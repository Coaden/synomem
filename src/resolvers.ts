/**
 * Context resolvers: the one place an operation's workspace/actor target is chosen
 * (identity contract §6, §6.1; plan §7 "Implementation boundary").
 *
 * Every MCP tool and CLI command asks a resolver for a service bound to exactly one
 * context, per call. Nothing holds a mutable "current actor" or "current workspace":
 * a resolved binding is immutable, so interleaved calls for two contexts cannot affect
 * each other's attribution. The resolver narrows (pins a context, restricts to a
 * preset); the server alone authorizes.
 */
import { randomBytes } from 'node:crypto';
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { atomicWriteFile } from './fs-utils.js';
import { SynomemClient } from './client.js';
import { describeIdentity, discoverContexts } from './discover.js';
import { SynomemError } from './errors.js';
import { bearerFrom, RemoteSynomemService } from './remote.js';
import type { RemoteCredential, RemoteCredentialSource } from './remote.js';
import type { SynomemService } from './service.js';
import type {
  ActorIdentity,
  ContextListing,
  ContextSummary,
  EffectiveContext,
  IdentityDescription,
  SynomemClientOptions,
} from './types.js';

export type { RemoteCredentialSource } from './remote.js';

export interface ResolvedContext {
  service: SynomemService;
  context: EffectiveContext;
}

export interface ContextResolver {
  /** `fixed`: omitting a context selects the one pinned target. */
  mode(): 'fixed' | 'explicit' | 'unknown';
  /** Resolve one operation's binding. `undefined` or `'default'` selects the fixed context. */
  resolve(contextId?: string): Promise<ResolvedContext>;
  list(): Promise<ContextListing>;
  describe?(): Promise<IdentityDescription | undefined>;
  close?(): Promise<void>;
}

/** The selector a model may pass to mean "the fixed context", e.g. in resource URIs. */
export const DEFAULT_CONTEXT = 'default';

const listingTtlMs = 30_000;

function normalize(contextId: string | undefined): string | undefined {
  const value = contextId?.trim();
  return !value || value === DEFAULT_CONTEXT ? undefined : value;
}

function forbidden(): SynomemError {
  // The same message whether the target is missing or merely unpermitted: an
  // authorization failure must not reveal that an inaccessible context exists.
  return new SynomemError(
    'CONTEXT_FORBIDDEN',
    'That context is not available to this credential. Call synomem_context_list to see the ones that are.',
  );
}

function required(): SynomemError {
  return new SynomemError(
    'CONTEXT_REQUIRED',
    'This connection can act as more than one workspace/actor. Pass contextId: call synomem_context_list and choose the context that matches what the user asked for.',
  );
}

/**
 * The stable local context id for one actor in one store, from the store's own
 * context registry (`<home>/contexts.json`).
 *
 * The id is cryptographically random (128 bits) and minted the first time the
 * actor is addressed, never derived from a name or from the canonical tuple:
 * an id reveals nothing about its target and cannot be guessed. It survives
 * renames and moving the store (the registry moves with it), and an unrelated
 * store with a same-named agent has its own registry and so its own id.
 * Minting is serialized across processes so two harnesses opening the store
 * at once agree on one id.
 */
export function localContextId(home: string, actor: ActorIdentity): string {
  const path = join(home, 'contexts.json');
  const key = `${actor.kind}:${actor.id}`;
  const existing = readRegistry(path).contexts[key];
  if (existing) return existing;
  return withRegistryLock(home, () => {
    const registry = readRegistry(path);
    const current = registry.contexts[key];
    if (current) return current;
    const id = `lctx_${randomBytes(16).toString('hex')}`;
    registry.contexts[key] = id;
    atomicWriteFile(path, `${JSON.stringify(registry, null, 2)}\n`, 0o600);
    return id;
  });
}

interface ContextRegistry {
  version: 1;
  contexts: Record<string, string>;
}

function readRegistry(path: string): ContextRegistry {
  if (!existsSync(path)) return { version: 1, contexts: {} };
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<ContextRegistry>;
    if (parsed.version === 1 && parsed.contexts && typeof parsed.contexts === 'object') {
      return { version: 1, contexts: { ...parsed.contexts } };
    }
  } catch {
    /* fall through */
  }
  throw new SynomemError('CONFIG_INVALID', `${path} is not a valid Synomem context registry.`);
}

/** A short synchronous O_EXCL lock; a dead or old owner is broken. */
function withRegistryLock<T>(home: string, operation: () => T): T {
  const lock = join(home, 'contexts.json.lock');
  const deadline = Date.now() + 10_000;
  const sleeper = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      const descriptor = openSync(lock, 'wx', 0o600);
      writeSync(descriptor, `${process.pid}\n`);
      closeSync(descriptor);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(lock, 'utf8').trim());
        const old = Date.now() - statSync(lock).mtimeMs > 5_000;
        let alive = Number.isSafeInteger(pid) && pid > 0;
        if (alive) {
          try {
            process.kill(pid, 0);
          } catch (probe) {
            alive = (probe as NodeJS.ErrnoException).code === 'EPERM';
          }
        }
        if (!alive || old) rmSync(lock, { force: true });
      } catch {
        /* released meanwhile */
      }
      if (Date.now() > deadline) {
        throw new SynomemError('DATABASE_BUSY', 'The local context registry is locked. Try again.');
      }
      Atomics.wait(sleeper, 0, 0, 20);
    }
  }
  try {
    return operation();
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * A remote (hosted API) resolver over one credential.
 *
 * `pinnedContextId` makes a fixed profile: only that target, whatever else the grant
 * allows. `allowedContextIds` makes an explicit preset: only those targets may be
 * selected. Either way the API re-authorizes every request; these only narrow.
 */
export function createRemoteResolver(options: {
  baseUrl: string;
  credential: RemoteCredentialSource | RemoteCredential;
  pinnedContextId?: string;
  allowedContextIds?: string[];
  fetch?: typeof fetch;
}): ContextResolver {
  const bearer = bearerFrom(options.credential);
  const pinned = normalize(options.pinnedContextId);
  const allowed = options.allowedContextIds?.length
    ? new Set(options.allowedContextIds)
    : undefined;
  let cached: { listing: ContextListing; at: number } | undefined;
  const services = new Map<string, Promise<RemoteSynomemService>>();

  const accessToken = async (): Promise<string> => {
    const token = await bearer();
    if (!token)
      throw new SynomemError('AUTH_REQUIRED', 'Remote Synomem authentication is required.');
    return token;
  };

  const serverListing = async (fresh = false): Promise<ContextListing> => {
    if (!fresh && cached && Date.now() - cached.at < listingTtlMs) return cached.listing;
    const listing = await discoverContexts({
      baseUrl: options.baseUrl,
      accessToken: await accessToken(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    cached = { listing, at: Date.now() };
    return listing;
  };

  const visible = (listing: ContextListing): ContextListing => {
    if (pinned) {
      return {
        mode: 'fixed',
        fixedContextId: pinned,
        contexts: listing.contexts.filter((entry) => entry.contextId === pinned),
        nextCursor: null,
      };
    }
    if (allowed) {
      return {
        mode: 'explicit',
        fixedContextId: null,
        contexts: listing.contexts.filter((entry) => allowed.has(entry.contextId)),
        nextCursor: null,
      };
    }
    return listing;
  };

  const summaryFor = async (contextId: string): Promise<ContextSummary> => {
    let found = (await serverListing()).contexts.find((entry) => entry.contextId === contextId);
    // A newly eligible target (a future-workspace rule, a fresh binding) may postdate the
    // cached listing; look once more before refusing.
    if (!found) {
      found = (await serverListing(true)).contexts.find((entry) => entry.contextId === contextId);
    }
    if (!found) throw forbidden();
    return found;
  };

  const serviceFor = (summary: ContextSummary): Promise<RemoteSynomemService> => {
    let pending = services.get(summary.contextId);
    if (!pending) {
      pending = (async () => {
        const service = new RemoteSynomemService({
          baseUrl: options.baseUrl,
          workspaceId: summary.workspaceId,
          contextId: summary.contextId,
          credential: options.credential,
          ...(options.fetch ? { fetch: options.fetch } : {}),
        });
        await service.init();
        return service;
      })();
      services.set(summary.contextId, pending);
      pending.catch(() => services.delete(summary.contextId));
    }
    return pending;
  };

  return {
    mode() {
      if (pinned) return 'fixed';
      if (allowed) return 'explicit';
      return cached ? cached.listing.mode : 'unknown';
    },
    async resolve(contextId) {
      const requested = normalize(contextId);
      let target: string;
      if (pinned) {
        if (requested && requested !== pinned) throw forbidden();
        target = pinned;
      } else if (requested) {
        if (allowed && !allowed.has(requested)) throw forbidden();
        target = requested;
      } else {
        const listing = await serverListing();
        if (listing.mode === 'fixed' && listing.fixedContextId && !allowed) {
          target = listing.fixedContextId;
        } else {
          throw required();
        }
      }
      const summary = await summaryFor(target);
      const service = await serviceFor(summary);
      return {
        service,
        context: {
          contextId: summary.contextId,
          organizationId: summary.organizationId,
          workspaceId: summary.workspaceId,
          actor: service.actor,
        },
      };
    },
    async list() {
      return visible(await serverListing());
    },
    async describe() {
      return await describeIdentity({
        baseUrl: options.baseUrl,
        accessToken: await accessToken(),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
    },
    async close() {
      const pending = [...services.values()];
      services.clear();
      await Promise.allSettled(pending.map(async (service) => (await service).close()));
    },
  };
}

/**
 * A local (SQLite) resolver: fixed mode, one store, one canonical actor.
 */
export function createLocalResolver(
  options: { home: string; actor: ActorIdentity } & Omit<SynomemClientOptions, 'home' | 'actor'>,
): ContextResolver {
  let ready: Promise<ResolvedContext> | undefined;
  const open = (): Promise<ResolvedContext> => {
    ready ??= (async () => {
      const client = new SynomemClient({ ...options, home: options.home, actor: options.actor });
      await client.init();
      const capabilities = await client.capabilities();
      // The canonical actor (a handle resolves to its opaque id), never the requested one.
      const actor = client.actor;
      return {
        service: client,
        context: {
          contextId: localContextId(options.home, actor),
          organizationId: null,
          workspaceId: capabilities.binding.workspaceId,
          actor,
        },
      };
    })();
    ready.catch(() => {
      ready = undefined;
    });
    return ready;
  };

  return {
    mode: () => 'fixed',
    async resolve(contextId) {
      const bound = await open();
      const requested = normalize(contextId);
      if (requested && requested !== bound.context.contextId) throw forbidden();
      return bound;
    },
    async list() {
      const { context } = await open();
      return {
        mode: 'fixed',
        fixedContextId: context.contextId,
        contexts: [
          {
            contextId: context.contextId,
            organizationId: null,
            workspaceId: context.workspaceId,
            actor: context.actor,
            actions: ['synomem:read', 'synomem:write'],
            source: 'local',
          },
        ],
        nextCursor: null,
      };
    },
    async describe() {
      const { context } = await open();
      return {
        account: { id: 'local' },
        organizationId: null,
        connection: { id: 'local', label: options.home, kind: 'local' },
        grant: null,
        fixedContextId: context.contextId,
        effectiveContext: context,
      };
    },
    async close() {
      const pending = ready;
      ready = undefined;
      if (pending) await (await pending.catch(() => undefined))?.service.close();
    },
  };
}
