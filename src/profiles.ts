/**
 * Profiles, connections, and presets — the only runtime identity interface.
 *
 * `<home>/profiles.json` (plan §8):
 *
 *   {
 *     "version": 1,
 *     "credentials": { "codex-mac": { kind, apiUrl, store, secretRef, … } },
 *     "profiles": {
 *       "codex-gracie": { "credentialRef": "codex-mac", "contextId": "ctx_…" },
 *       "gracie-local": { "backend": "local", "actorId": "01…", "contextId": "lctx_…" }
 *     },
 *     "harnessPresets": { "codex": ["codex-gracie", "codex-astra"] },
 *     "defaultProfile": "gracie-local"
 *   }
 *
 * A credential entry holds only a REFERENCE to its secret (`secretRef`, an
 * opaque key into the keychain or restricted-file store); the secret itself
 * never appears in this file. A profile routes one stable context through one
 * credential; several profiles may share a credential. Nothing here is
 * authority: the API authorizes every operation against the connection's
 * grant, whatever a profile says.
 *
 * Kept separate from `<home>/config.json`, which is the local store's own
 * policy file and persistent workspace identity.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { readSynomemConfig } from './backend.js';
import { resolveHome } from './config.js';
import {
  withCredentialLock,
  type CredentialStore,
  type CredentialStores,
  type StoredOAuthCredential,
} from './credentials.js';
import { SynomemError } from './errors.js';
import { atomicWriteFile, readJsonFile } from './fs-utils.js';
import { refreshOAuthCredential } from './oauth.js';
import { findProjectSelection } from './project.js';
import {
  createLocalResolver,
  createRemoteResolver,
  localContextId,
  type ContextResolver,
  type RemoteCredentialSource,
} from './resolvers.js';
import type { ActorIdentity, ContextSummary } from './types.js';

export const PROFILES_FILE = 'profiles.json';

const nameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]{0,62}$/i,
    'names use letters, digits, dot, dash and underscore (max 63)',
  );

const credentialEntrySchema = z
  .object({
    kind: z.enum(['oauth', 'access-key']),
    /** The Synomem API origin this credential is for. */
    apiUrl: z.string().url(),
    store: z.enum(['keychain', 'file', 'environment']),
    /** Opaque key into the keychain/file store. Absent for `environment`. */
    secretRef: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,100}$/)
      .optional(),
    issuer: z.string().optional(),
    resource: z.string().optional(),
    clientId: z.string().optional(),
    /** The server-side connection this credential belongs to, when known. */
    connectionId: z.string().optional(),
    label: z.string().optional(),
    createdAt: z.string(),
  })
  .strict()
  .refine((entry) => (entry.store === 'environment') === (entry.secretRef === undefined), {
    message: 'secretRef is required except for the environment store',
  });

const actorSnapshotSchema = z
  .object({
    kind: z.enum(['human', 'agent', 'system']),
    id: z.string().min(1),
    displayName: z.string().optional(),
  })
  .strict();

const localProfileSchema = z
  .object({
    backend: z.literal('local'),
    /** The store's home; absent means the root Synomem home. */
    home: z.string().optional(),
    actorId: z.string().min(1),
    actorName: z.string().optional(),
    contextId: z.string().regex(/^lctx_[0-9a-f]{32}$/),
  })
  .strict();

const remoteProfileSchema = z
  .object({
    backend: z.literal('remote').optional(),
    credentialRef: nameSchema,
    contextId: z.string().min(1),
    /** Descriptive snapshots taken at creation — for display, never authority. */
    workspaceId: z.string().optional(),
    workspaceName: z.string().optional(),
    actor: actorSnapshotSchema.optional(),
  })
  .strict();

export const profileSchema = z.union([localProfileSchema, remoteProfileSchema]);

export const profilesConfigSchema = z
  .object({
    version: z.literal(1),
    credentials: z.record(nameSchema, credentialEntrySchema).default({}),
    profiles: z.record(nameSchema, profileSchema).default({}),
    harnessPresets: z.record(nameSchema, z.array(nameSchema).min(1)).default({}),
    defaultProfile: nameSchema.optional(),
  })
  .strict();

export type CredentialEntry = z.infer<typeof credentialEntrySchema>;
export type LocalProfile = z.infer<typeof localProfileSchema>;
export type RemoteProfile = z.infer<typeof remoteProfileSchema>;
export type Profile = z.infer<typeof profileSchema>;
export type ProfilesConfig = z.infer<typeof profilesConfigSchema>;

export function isLocalProfile(profile: Profile): profile is LocalProfile {
  return profile.backend === 'local';
}

export function emptyProfilesConfig(): ProfilesConfig {
  return { version: 1, credentials: {}, profiles: {}, harnessPresets: {} };
}

export function assertName(name: string, what: string): string {
  const parsed = nameSchema.safeParse(name);
  if (!parsed.success) {
    throw new SynomemError(
      'INVALID_INPUT',
      `Invalid ${what} name "${name}": ${parsed.error.issues[0]?.message}.`,
    );
  }
  return parsed.data;
}

/** Reads and writes `<home>/profiles.json`. Injected in tests. */
export class ProfileStore {
  readonly home: string;

  constructor(explicitHome?: string) {
    this.home = resolveHome(explicitHome);
  }

  get path(): string {
    return join(this.home, PROFILES_FILE);
  }

  read(): ProfilesConfig {
    if (!existsSync(this.path)) {
      // The old remote-backend configuration is refused, not migrated: the
      // store's config.json reader names the replacement commands.
      if (existsSync(join(this.home, 'config.json'))) readSynomemConfig(this.home, {});
      return emptyProfilesConfig();
    }
    let raw: unknown;
    try {
      raw = readJsonFile(this.path);
    } catch {
      throw new SynomemError('CONFIG_INVALID', `${this.path} is not readable JSON.`);
    }
    const parsed = profilesConfigSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new SynomemError(
        'CONFIG_INVALID',
        `${this.path} is not a valid version-1 profiles file (${issue?.path.join('.') || 'root'}: ${
          issue?.message ?? 'invalid'
        }). Re-run \`synomem setup\`, or fix the file.`,
      );
    }
    return parsed.data;
  }

  write(config: ProfilesConfig): void {
    const parsed = profilesConfigSchema.parse(config);
    atomicWriteFile(this.path, `${JSON.stringify(parsed, null, 2)}\n`, 0o600);
  }
}

/* ------------------------------------------------------------ selection */

export type Selection =
  | { kind: 'profile'; name: string; source: string }
  | { kind: 'preset'; name: string; source: string };

export interface SelectionInput {
  profile?: string;
  preset?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** The Synomem home, so it is never mistaken for a project directory. */
  home?: string;
}

/**
 * Which profile or preset a process acts through. One implementation, used by
 * the CLI and both stdio entrypoints:
 *
 *   1. `--profile` / `--preset` on this invocation
 *   2. `SYNOMEM_PROFILE` / `SYNOMEM_PRESET` for this process
 *   3. the nearest project `.synomem/project.json` (names a profile/preset only)
 *   4. `defaultProfile` in profiles.json
 *
 * Returns undefined when nothing selects anything. Naming something that does
 * not exist is an error, never a fall-through to the next source.
 */
export function resolveSelection(
  config: ProfilesConfig,
  input: SelectionInput,
): Selection | undefined {
  const env = input.env ?? process.env;
  const pick = (
    profile: string | undefined,
    preset: string | undefined,
    source: string,
  ): Selection | undefined => {
    const profileName = profile?.trim() || undefined;
    const presetName = preset?.trim() || undefined;
    if (profileName && presetName) {
      throw new SynomemError(
        'INVALID_INPUT',
        `${source} names both a profile and a preset; choose one.`,
      );
    }
    if (profileName) {
      if (!config.profiles[profileName]) throw unknownName('profile', profileName, source, config);
      return { kind: 'profile', name: profileName, source };
    }
    if (presetName) {
      if (!config.harnessPresets[presetName])
        throw unknownName('preset', presetName, source, config);
      return { kind: 'preset', name: presetName, source };
    }
    return undefined;
  };
  return (
    pick(input.profile, input.preset, 'the command line') ??
    pick(env.SYNOMEM_PROFILE, env.SYNOMEM_PRESET, 'SYNOMEM_PROFILE/SYNOMEM_PRESET') ??
    (() => {
      const project = findProjectSelection(input.cwd ?? process.cwd(), input.home);
      return project ? pick(project.profile, project.preset, project.path) : undefined;
    })() ??
    (config.defaultProfile
      ? pick(config.defaultProfile, undefined, 'defaultProfile in profiles.json')
      : undefined)
  );
}

function unknownName(
  kind: 'profile' | 'preset',
  name: string,
  source: string,
  config: ProfilesConfig,
): SynomemError {
  const known = Object.keys(kind === 'profile' ? config.profiles : config.harnessPresets);
  return new SynomemError(
    'CONFIG_INVALID',
    `Unknown ${kind} "${name}" (from ${source}). ${
      known.length ? `Known ${kind}s: ${known.join(', ')}.` : `No ${kind}s exist yet.`
    } See \`synomem ${kind} list\`.`,
  );
}

export function noSelectionError(): SynomemError {
  return new SynomemError(
    'CONFIG_INVALID',
    'No profile selected. Pass --profile <name> (or set SYNOMEM_PROFILE), or run `synomem setup --backend local` / `synomem connection login` then `synomem profile create`.',
  );
}

/* ------------------------------------------------------------ credentials */

export interface CredentialSourceOptions {
  home: string;
  name: string;
  entry: CredentialEntry;
  stores: CredentialStores;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
}

export function storeFor(stores: CredentialStores, entry: CredentialEntry): CredentialStore {
  if (entry.store === 'environment') {
    throw new SynomemError('INTERNAL_ERROR', 'The environment store holds no secrets.');
  }
  return stores[entry.store];
}

/**
 * A connection's current bearer: an access key as stored, or an OAuth access
 * token, refreshed under the cross-process lock when it has expired.
 *
 * After taking the lock the stored credential is re-read: if another process
 * already refreshed it (a newer generation), that token is used and the
 * refresh token is not spent again. A refused refresh is never retried — the
 * connection must be logged in again.
 */
export class ConnectionCredentialSource implements RemoteCredentialSource {
  private cached?: string;
  private cachedExpiry = 0;
  private pending?: Promise<string>;

  constructor(private readonly options: CredentialSourceOptions) {}

  async bearer(): Promise<string> {
    if (this.cached && this.cachedExpiry > Date.now()) return this.cached;
    this.pending ??= this.load().finally(() => {
      this.pending = undefined;
    });
    return await this.pending;
  }

  private reauthorize(detail: string): SynomemError {
    return new SynomemError(
      'REAUTHORIZATION_REQUIRED',
      `${detail} Run \`synomem connection login --name ${this.options.name}\` to sign in again.`,
    );
  }

  private async load(): Promise<string> {
    const { entry, name } = this.options;
    const env = this.options.env ?? process.env;
    if (entry.store === 'environment') {
      const token = env.SYNOMEM_ACCESS_TOKEN?.trim();
      if (!token) {
        throw new SynomemError(
          'AUTH_REQUIRED',
          `Connection ${name} reads its credential from SYNOMEM_ACCESS_TOKEN, which is not set.`,
        );
      }
      this.cached = token;
      this.cachedExpiry = Number.MAX_SAFE_INTEGER;
      return token;
    }
    const store = storeFor(this.options.stores, entry);
    const stored = await store.get(entry.secretRef!);
    if (!stored) {
      throw new SynomemError(
        'AUTH_REQUIRED',
        `No stored credential for connection ${name}. Run \`synomem connection ${
          entry.kind === 'oauth' ? 'login' : 'add-key'
        } --name ${name}\`.`,
      );
    }
    if (stored.kind === 'access-key') {
      this.cached = stored.secret;
      this.cachedExpiry = Number.MAX_SAFE_INTEGER;
      return stored.secret;
    }
    if (stored.expiresAt > Date.now()) return this.remember(stored);
    return await withCredentialLock(this.options.home, name, async () => {
      const current = await store.get(entry.secretRef!);
      if (!current || current.kind !== 'oauth')
        throw this.reauthorize(`Connection ${name} has no OAuth credential.`);
      // Another process refreshed while we waited for the lock.
      if (current.expiresAt > Date.now()) return this.remember(current);
      let refreshed: StoredOAuthCredential;
      try {
        refreshed = await refreshOAuthCredential(current, this.options.fetch ?? fetch);
      } catch (error) {
        if (
          error instanceof SynomemError &&
          error.code === 'REMOTE_UNAVAILABLE' &&
          error.details?.delivery === 'not_sent'
        ) {
          // The refresh token provably never left this machine: safe to retry later.
          throw error;
        }
        // Refused, or delivery unknown (the server may have rotated it): the
        // stored refresh token is treated as spent and removed, so no process
        // can replay it and trip reuse detection for the whole family.
        const withoutRefresh: StoredOAuthCredential = { ...current };
        delete withoutRefresh.refreshToken;
        await store.set(entry.secretRef!, {
          ...withoutRefresh,
          expiresAt: 0,
          generation: current.generation + 1,
        });
        throw this.reauthorize(`Connection ${name} could not be refreshed.`);
      }
      // Compare-and-swap: only this process may have spent the refresh token
      // while holding the lock, so a different stored generation means the
      // store was replaced underneath us (a fresh login) — keep that one.
      const latest = await store.get(entry.secretRef!);
      if (latest?.kind === 'oauth' && latest.generation !== current.generation) {
        return this.remember(latest);
      }
      await store.set(entry.secretRef!, refreshed);
      return this.remember(refreshed);
    });
  }

  private remember(credential: StoredOAuthCredential): string {
    this.cached = credential.accessToken;
    this.cachedExpiry = credential.expiresAt;
    return credential.accessToken;
  }
}

/* ------------------------------------------------------------ resolvers */

export interface ResolverDependencies {
  stores: CredentialStores;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof fetch;
  createRemoteResolver?: typeof createRemoteResolver;
  createLocalResolver?: typeof createLocalResolver;
}

export function credentialSourceFor(
  home: string,
  config: ProfilesConfig,
  name: string,
  deps: ResolverDependencies,
): ConnectionCredentialSource {
  const entry = config.credentials[name];
  if (!entry) {
    throw new SynomemError(
      'CONFIG_INVALID',
      `Unknown connection "${name}". See \`synomem connection list\`.`,
    );
  }
  return new ConnectionCredentialSource({
    home,
    name,
    entry,
    stores: deps.stores,
    ...(deps.env ? { env: deps.env } : {}),
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

/** The canonical local actor for a local profile, after checking its store. */
export function localProfileTarget(
  rootHome: string,
  profile: LocalProfile,
): { home: string; actor: ActorIdentity } {
  const home = profile.home ?? rootHome;
  const actor: ActorIdentity = {
    kind: 'agent',
    id: profile.actorId,
    ...(profile.actorName ? { displayName: profile.actorName } : {}),
  };
  const expected = localContextId(home, actor);
  if (expected !== profile.contextId) {
    throw new SynomemError(
      'CONTEXT_FORBIDDEN',
      `Profile's local context ${profile.contextId} does not belong to the store at ${home}. Recreate the profile.`,
    );
  }
  return { home, actor };
}

/** A fixed-mode resolver for one profile. */
export function profileResolver(
  rootHome: string,
  config: ProfilesConfig,
  name: string,
  deps: ResolverDependencies,
): ContextResolver {
  const profile = config.profiles[name];
  if (!profile) throw unknownName('profile', name, 'the selection', config);
  if (isLocalProfile(profile)) {
    const target = localProfileTarget(rootHome, profile);
    return (deps.createLocalResolver ?? createLocalResolver)(target);
  }
  const entry = config.credentials[profile.credentialRef];
  if (!entry) {
    throw new SynomemError(
      'CONFIG_INVALID',
      `Profile ${name} uses connection "${profile.credentialRef}", which does not exist. See \`synomem connection list\`.`,
    );
  }
  return (deps.createRemoteResolver ?? createRemoteResolver)({
    baseUrl: entry.apiUrl,
    credential: credentialSourceFor(rootHome, config, profile.credentialRef, deps),
    pinnedContextId: profile.contextId,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
  });
}

interface Route {
  profile: string;
  contextId: string;
  resolver: ContextResolver;
}

/**
 * An explicit-context resolver over a preset's profiles.
 *
 * Remote profiles sharing a connection share one remote resolver, restricted
 * to exactly the contexts the preset names (the server still authorizes each).
 * Every operation must name its context; there is no default and no switch.
 */
export class PresetResolver implements ContextResolver {
  constructor(
    private readonly name: string,
    private readonly routes: Route[],
  ) {}

  mode(): 'explicit' {
    return 'explicit';
  }

  async resolve(contextId?: string) {
    if (!contextId) {
      throw new SynomemError(
        'CONTEXT_REQUIRED',
        `Preset ${this.name} serves several identities; pass contextId (see synomem_context_list). Profiles: ${this.routes
          .map((route) => `${route.profile}=${route.contextId}`)
          .join(', ')}.`,
      );
    }
    const route = this.routes.find((candidate) => candidate.contextId === contextId);
    if (!route) {
      throw new SynomemError('CONTEXT_FORBIDDEN', 'That context is not available on this server.');
    }
    return await route.resolver.resolve(contextId);
  }

  async list() {
    const allowed = new Set(this.routes.map((route) => route.contextId));
    const seen = new Set<string>();
    const contexts: Awaited<ReturnType<ContextResolver['list']>>['contexts'] = [];
    for (const resolver of new Set(this.routes.map((route) => route.resolver))) {
      const listing = await resolver.list();
      for (const context of listing.contexts) {
        if (allowed.has(context.contextId) && !seen.has(context.contextId)) {
          seen.add(context.contextId);
          contexts.push(context);
        }
      }
    }
    return { mode: 'explicit' as const, fixedContextId: null, contexts };
  }

  async close(): Promise<void> {
    await Promise.allSettled(
      [...new Set(this.routes.map((route) => route.resolver))].map(async (resolver) => {
        await resolver.close?.();
      }),
    );
  }
}

export function presetResolver(
  rootHome: string,
  config: ProfilesConfig,
  name: string,
  deps: ResolverDependencies,
): PresetResolver {
  const members = config.harnessPresets[name];
  if (!members) throw unknownName('preset', name, 'the selection', config);
  const remoteByCredential = new Map<string, { contexts: string[]; profiles: string[] }>();
  const routes: Route[] = [];
  const pendingRemote: Array<{ profile: string; contextId: string; credential: string }> = [];
  for (const member of members) {
    const profile = config.profiles[member];
    if (!profile) {
      throw new SynomemError(
        'CONFIG_INVALID',
        `Preset ${name} names profile "${member}", which does not exist.`,
      );
    }
    if (
      routes.some((route) => route.contextId === profile.contextId) ||
      pendingRemote.some((p) => p.contextId === profile.contextId)
    ) {
      throw new SynomemError(
        'CONFIG_INVALID',
        `Preset ${name} lists context ${profile.contextId} twice.`,
      );
    }
    if (isLocalProfile(profile)) {
      routes.push({
        profile: member,
        contextId: profile.contextId,
        resolver: (deps.createLocalResolver ?? createLocalResolver)(
          localProfileTarget(rootHome, profile),
        ),
      });
    } else {
      const group = remoteByCredential.get(profile.credentialRef) ?? { contexts: [], profiles: [] };
      group.contexts.push(profile.contextId);
      group.profiles.push(member);
      remoteByCredential.set(profile.credentialRef, group);
      pendingRemote.push({
        profile: member,
        contextId: profile.contextId,
        credential: profile.credentialRef,
      });
    }
  }
  for (const [credential, group] of remoteByCredential) {
    const entry = config.credentials[credential];
    if (!entry) {
      throw new SynomemError(
        'CONFIG_INVALID',
        `Preset ${name} uses connection "${credential}", which does not exist.`,
      );
    }
    const resolver = (deps.createRemoteResolver ?? createRemoteResolver)({
      baseUrl: entry.apiUrl,
      credential: credentialSourceFor(rootHome, config, credential, deps),
      allowedContextIds: group.contexts,
      ...(deps.fetch ? { fetch: deps.fetch } : {}),
    });
    for (const pending of pendingRemote.filter((p) => p.credential === credential)) {
      routes.push({ profile: pending.profile, contextId: pending.contextId, resolver });
    }
  }
  return new PresetResolver(name, routes);
}

/**
 * The single entry point for the CLI and both stdio servers: selection flags
 * and environment in, one resolver out.
 */
export function resolverForSelection(
  rootHome: string,
  config: ProfilesConfig,
  selection: Selection,
  deps: ResolverDependencies,
): ContextResolver {
  return selection.kind === 'profile'
    ? profileResolver(rootHome, config, selection.name, deps)
    : presetResolver(rootHome, config, selection.name, deps);
}

/* ------------------------------------------------------------ display */

export function describeContext(context: ContextSummary): string {
  const who = context.actor.displayName ?? context.actor.handle ?? context.actor.id;
  const where = context.workspaceName ?? context.workspaceId;
  return `${who} (${context.actor.kind}) in ${where}`;
}

/** One line describing a profile, for list/show. Never a secret. */
export function describeProfile(name: string, profile: Profile): string {
  if (isLocalProfile(profile)) {
    return `${name}  local  ${profile.actorName ?? profile.actorId}  ${profile.home ?? '(root home)'}  ${profile.contextId}`;
  }
  const who = profile.actor?.displayName ?? profile.actor?.id ?? '?';
  return `${name}  remote via ${profile.credentialRef}  ${who} in ${profile.workspaceName ?? profile.workspaceId ?? '?'}  ${profile.contextId}`;
}
