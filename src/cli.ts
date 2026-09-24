#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import {
  ensureLocalStore,
  LOCAL_OPERATOR,
  localStoreWorkspaceId,
  openLocalService,
} from './backend.js';
import { cloudApiUrl } from './cloud.js';
import { resolveHome } from './config.js';
import {
  assertInteractive,
  credentialFingerprint,
  parseCredentialBackend,
  readAccessKey,
} from './configure.js';
import {
  defaultCredentialStores,
  newSecretReference,
  type CredentialStores,
  type StoredCredential,
  type StoredOAuthCredential,
} from './credentials.js';
import { describeIdentity, discoverContexts } from './discover.js';
import { asSynomemError, SynomemError, type SynomemErrorCode } from './errors.js';
import { atomicWriteFile } from './fs-utils.js';
import {
  createLocalImportBundle,
  RemoteImportClient,
  type ImportBundle,
  type ImportPreview,
  type ImportResult,
} from './import.js';
import { serveStdio } from './mcp/index.js';
import { loginWithOAuth, secureUrl, type OAuthLoginOptions } from './oauth.js';
import {
  assertName,
  credentialSourceFor,
  describeContext,
  describeProfile,
  isLocalProfile,
  noSelectionError,
  presetResolver,
  profileResolver,
  ProfileStore,
  resolveSelection,
  storeFor,
  type CredentialEntry,
  type LocalProfile,
  type ProfilesConfig,
  type RemoteProfile,
  type ResolverDependencies,
} from './profiles.js';
import { writeProjectSelection } from './project.js';
import { defaultPromptIo, ask, select, type PromptIo } from './prompt.js';
import { localContextId, type ContextResolver } from './resolvers.js';
import type { createLocalResolver, createRemoteResolver } from './resolvers.js';
import type { SynomemService } from './service.js';
import {
  formatSkillResult,
  installSkill,
  skillRuntimeNames,
  skillStatus,
  uninstallSkill,
  type SkillRuntime,
} from './skill-install.js';
import type {
  AgentRuntimeBinding,
  ContextSummary,
  EffectiveContext,
  EvidenceReference,
  IdentityDescription,
  ItemListInput,
  ItemSummary,
  KudosListInput,
  KudosRecord,
  KudosSummary,
  TaskDue,
} from './types.js';
import { packageVersion } from './version.js';
import { listLocalWorkspaces, localWorkspaceHome } from './workspaces.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDependencies {
  /** Injected so interactive steps can be driven by a test without a terminal. */
  promptIo?: PromptIo;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  platform?: NodeJS.Platform;
  fetch?: typeof fetch;
  credentialStores?: (home: string) => CredentialStores;
  profileStore?: (home: string) => ProfileStore;
  oauthLogin?: (options: OAuthLoginOptions) => Promise<StoredOAuthCredential>;
  createRemoteResolver?: typeof createRemoteResolver;
  createLocalResolver?: typeof createLocalResolver;
  startMcpServer?: (options: { resolver: ContextResolver }) => Promise<void>;
  createImportBundle?: (home: string) => Promise<ImportBundle>;
  remoteImport?: (options: {
    baseUrl: string;
    workspaceId: string;
    contextId: string;
    bundle: ImportBundle;
    planId?: string;
  }) => Promise<ImportPreview | ImportResult>;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const cliExitCodes = new WeakMap<Command, number>();

/**
 * Identity overrides the profile model replaced. Named here so using one fails
 * with a message that points at `--profile`, rather than a generic unknown
 * option or — worse — being silently ignored.
 */
const OBSOLETE_FLAGS = [
  '--actor',
  '--as',
  '--from',
  '--actor-kind',
  '--actor-id',
  '--agent-id',
  '--actor-name',
];
const OBSOLETE_ENV = [
  'SYNOMEM_ACTOR_ID',
  'SYNOMEM_ACTOR_KIND',
  'SYNOMEM_ACTOR_NAME',
  'SYNOMEM_AGENT_ID',
  'SYNOMEM_WORKSPACE',
];

function obsoleteIdentityInput(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  const args = argv.slice(2);
  for (const argument of args) {
    const flag = argument.split('=')[0]!;
    if (OBSOLETE_FLAGS.includes(flag)) return flag;
    // `--workspace` survives only as a filter on `profile create`.
    if (flag === '--workspace' && !(args.includes('profile') && args.includes('create'))) {
      return flag;
    }
  }
  if (
    args.length === 0 ||
    args.includes('--help') ||
    args.includes('-h') ||
    args.includes('--version')
  ) {
    return undefined;
  }
  return OBSOLETE_ENV.find((name) => env[name]?.trim());
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function skillRuntimes(values: string[]): SkillRuntime[] | undefined {
  const normalized = values.map((value) => (value === 'grokbot' ? 'grok' : value));
  const invalid = normalized.find(
    (value) => value !== 'all' && !skillRuntimeNames.some((runtime) => runtime === value),
  );
  if (invalid) {
    throw new SynomemError('INVALID_INPUT', `Unsupported skill runtime: ${invalid}.`);
  }
  if (!normalized.length || normalized.includes('all')) return undefined;
  return normalized as SkillRuntime[];
}

const skillRuntimeHelp = `${skillRuntimeNames.join(', ')}, grokbot (alias for grok), or all`;

function parseEvidence(value: string): EvidenceReference {
  const separator = value.indexOf(':');
  if (separator < 1 || separator === value.length - 1) {
    throw new SynomemError('INVALID_INPUT', 'Evidence must use kind:value syntax.');
  }
  return {
    kind: value.slice(0, separator) as EvidenceReference['kind'],
    value: value.slice(separator + 1),
  };
}

function taskDue(options: {
  dueDate?: string;
  dueAt?: string;
  timeZone?: string;
}): TaskDue | undefined {
  if (options.dueDate && options.dueAt)
    throw new SynomemError('INVALID_INPUT', 'Use due-date or due-at, not both.');
  if (options.dueDate) return { kind: 'date', date: options.dueDate };
  if (options.dueAt) {
    if (!options.timeZone)
      throw new SynomemError('INVALID_INPUT', '--time-zone is required with --due-at.');
    return { kind: 'datetime', datetime: options.dueAt, timeZone: options.timeZone };
  }
  return undefined;
}

function exitCode(code: SynomemErrorCode): number {
  if (code.endsWith('_NOT_FOUND')) return 3;
  if (
    code.endsWith('_FORBIDDEN') ||
    code === 'READ_ONLY' ||
    code === 'AUTH_REQUIRED' ||
    code === 'AUTH_FORBIDDEN' ||
    code === 'REAUTHORIZATION_REQUIRED'
  )
    return 4;
  if (code.startsWith('DATABASE_') || code === 'UNSUPPORTED_SCHEMA' || code === 'UNSUPPORTED_EVENT')
    return 5;
  if (code.startsWith('REMOTE_') || code === 'RATE_LIMITED') return 5;
  if (code === 'INTERNAL_ERROR') return 1;
  return 2;
}

function lineForSummary(record: KudosSummary): string {
  const state =
    record.revocationStatus === 'revoked'
      ? 'revoked'
      : record.status === 'acknowledged'
        ? 'acknowledged'
        : 'new';
  return `${record.id}  ${record.createdAt.slice(0, 10)}  ${record.recipientAgentId}  [${state}]  ${record.title}`;
}

function lineForItem(item: ItemSummary): string {
  return `${item.id}  ${item.createdAt.slice(0, 10)}  ${item.kind.padEnd(5)}  [${item.status}]  ${item.title}`;
}

function itemListInput(options: Record<string, string | string[]>): ItemListInput {
  return {
    ...(Array.isArray(options.kind) && options.kind.length
      ? { kinds: options.kind as ItemListInput['kinds'] }
      : {}),
    ...(typeof options.participant === 'string' ? { participantAgentId: options.participant } : {}),
    ...(typeof options.author === 'string' ? { actorId: options.author } : {}),
    ...(typeof options.status === 'string' ? { status: options.status } : {}),
    ...(typeof options.tag === 'string' ? { tag: options.tag } : {}),
    ...(typeof options.topic === 'string' ? { topicId: options.topic } : {}),
    ...(typeof options.visibility === 'string'
      ? { visibility: options.visibility as ItemListInput['visibility'] }
      : {}),
    ...(typeof options.cursor === 'string' ? { cursor: options.cursor } : {}),
    limit: Number(options.limit ?? 10),
    offset: Number(options.offset ?? 0),
  };
}

function showRecord(record: KudosRecord): string {
  const event = record.event;
  const evidence = event.evidence?.map((item) => `  - ${item.kind}: ${item.value}`).join('\n');
  return [
    event.title,
    `ID: ${event.id}`,
    `Recipient: ${event.recipientDisplayName} (${event.recipientAgentId})`,
    `From: ${event.actor.displayName ?? event.actor.id} (${event.actor.kind}:${event.actor.id})`,
    `Date: ${event.createdAt}`,
    `Visibility: ${event.visibility}`,
    `Status: ${record.status}`,
    `Revocation: ${record.revocationStatus}`,
    event.tags?.length ? `Tags: ${event.tags.join(', ')}` : undefined,
    '',
    event.reason,
    evidence ? `\nEvidence:\n${evidence}` : undefined,
    record.acknowledgment?.note ? `\nAcknowledgment: ${record.acknowledgment.note}` : undefined,
    record.revocation ? `\nRevoked: ${record.revocation.reason}` : undefined,
  ]
    .filter((value) => value !== undefined)
    .join('\n');
}

function output(io: CliIo, json: boolean, value: unknown, human: string): void {
  io.stdout(json ? `${JSON.stringify(value, null, 2)}\n` : `${human}\n`);
}

function addListOptions(command: Command): Command {
  return command
    .option('--recipient <agent>')
    .option('--author <id>', 'only kudos given by this actor')
    .option('--author-kind <kind>', 'human, agent, or system')
    .option('--tag <tag>')
    .option('--topic <id>', 'only records carrying this topic')
    .option('--status <status>', 'acknowledged or unacknowledged')
    .option('--visibility <visibility>', 'private, workspace, or public')
    .addOption(
      new Option('--revoked <state>').choices(['include', 'only', 'exclude']).default('include'),
    )
    .option('--from-date <iso>')
    .option('--to-date <iso>')
    .option('--limit <number>', 'maximum results (default 10, maximum 50)', '10')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .option('--offset <number>', 'pagination offset', '0');
}

function listInput(options: Record<string, string>): KudosListInput {
  return {
    ...(options.recipient ? { recipientAgentId: options.recipient } : {}),
    ...(options.author ? { actorId: options.author } : {}),
    ...(options.authorKind ? { actorKind: options.authorKind as KudosListInput['actorKind'] } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
    ...(options.topic ? { topicId: options.topic } : {}),
    ...(options.status ? { status: options.status as KudosListInput['status'] } : {}),
    ...(options.visibility
      ? { visibility: options.visibility as KudosListInput['visibility'] }
      : {}),
    ...(options.revoked === 'only' ? { revoked: true } : {}),
    ...(options.revoked === 'exclude' ? { revoked: false } : {}),
    ...(options.fromDate ? { from: options.fromDate } : {}),
    ...(options.toDate ? { to: options.toDate } : {}),
    ...(options.cursor ? { cursor: options.cursor } : {}),
    limit: Number(options.limit),
    offset: Number(options.offset),
  };
}

function describeEffective(context: EffectiveContext): string {
  return `${context.actor.displayName ?? context.actor.id} (${context.actor.kind}:${context.actor.id}) in ${context.workspaceId}`;
}

interface Globals {
  home: string;
  explicitHome?: string;
  json: boolean;
  profile?: string;
  preset?: string;
}

export function createCli(io: CliIo = defaultIo, dependencies: CliDependencies = {}): Command {
  const env = dependencies.env ?? process.env;
  const cwd = dependencies.cwd ?? process.cwd();
  const platform = dependencies.platform ?? process.platform;
  const fetchImplementation = dependencies.fetch ?? fetch;
  const promptIo = dependencies.promptIo ?? defaultPromptIo();
  const oauthLogin = dependencies.oauthLogin ?? loginWithOAuth;
  const storesFor = dependencies.credentialStores ?? defaultCredentialStores;
  const profileStoreFor = dependencies.profileStore ?? ((home: string) => new ProfileStore(home));

  const globals = (command: Command): Globals => {
    const options = command.optsWithGlobals<{
      home?: string;
      json: boolean;
      profile?: string;
      preset?: string;
    }>();
    return {
      home: resolveHome(options.home),
      ...(options.home ? { explicitHome: options.home } : {}),
      json: options.json,
      ...(options.profile ? { profile: options.profile } : {}),
      ...(options.preset ? { preset: options.preset } : {}),
    };
  };

  const resolverDeps = (home: string): ResolverDependencies => ({
    stores: storesFor(home),
    env,
    fetch: fetchImplementation,
    ...(dependencies.createRemoteResolver
      ? { createRemoteResolver: dependencies.createRemoteResolver }
      : {}),
    ...(dependencies.createLocalResolver
      ? { createLocalResolver: dependencies.createLocalResolver }
      : {}),
  });

  const selectionFor = (global: Globals, config: ProfilesConfig) =>
    resolveSelection(config, {
      ...(global.profile ? { profile: global.profile } : {}),
      ...(global.preset ? { preset: global.preset } : {}),
      env,
      cwd,
      home: global.home,
    });

  /**
   * Runs a domain command as the selected profile's single context. Every
   * acting identity comes from here — there is no per-command actor flag.
   */
  const withProfile = async <T>(
    command: Command,
    operation: (
      service: SynomemService,
      context: EffectiveContext,
      profileName: string,
    ) => Promise<T>,
  ): Promise<T> => {
    const global = globals(command);
    const config = profileStoreFor(global.home).read();
    const selection = selectionFor(global, config);
    if (!selection) throw noSelectionError();
    if (selection.kind === 'preset') {
      throw new SynomemError(
        'INVALID_INPUT',
        `A command acts as exactly one profile; preset ${selection.name} is for \`synomem mcp --preset ${selection.name} --contexts explicit\`. Pass --profile <name>.`,
      );
    }
    const resolver = profileResolver(
      global.home,
      config,
      selection.name,
      resolverDeps(global.home),
    );
    try {
      const { service, context } = await resolver.resolve();
      return await operation(service, context, selection.name);
    } finally {
      await resolver.close?.();
    }
  };

  /**
   * Store administration: agent management, rebuild, backup, export, doctor.
   *
   * A selected REMOTE profile routes through its context (the API decides
   * whether that context may administer). Otherwise it is a local store — the
   * selected local profile's store, or the root home — administered as the
   * local operator, since the filesystem owner is the authority over a local
   * store.
   */
  const withManagement = async <T>(
    command: Command,
    operation: (
      service: SynomemService,
      context: EffectiveContext | undefined,
      home: string | undefined,
    ) => Promise<T>,
  ): Promise<T> => {
    const global = globals(command);
    const config = profileStoreFor(global.home).read();
    const selection = selectionFor(global, config);
    const profile = selection?.kind === 'profile' ? config.profiles[selection.name] : undefined;
    if (profile && !isLocalProfile(profile)) {
      return await withProfile(command, (service, context) =>
        operation(service, context, undefined),
      );
    }
    const storeHome =
      profile && isLocalProfile(profile) ? (profile.home ?? global.home) : global.home;
    const client = await openLocalService(storeHome, LOCAL_OPERATOR);
    try {
      return await operation(client, undefined, storeHome);
    } finally {
      await client.close();
    }
  };

  const program = new Command();
  cliExitCodes.set(program, 0);
  program
    .name('synomem')
    .description('Durable communication, memory, recognition, and task infrastructure for agents')
    .version(packageVersion())
    .option('--home <path>', 'Synomem home (defaults to SYNOMEM_HOME or ~/.synomem)')
    .option('--profile <name>', 'act as this profile (or SYNOMEM_PROFILE)')
    .option('--preset <name>', 'MCP preset of several profiles (or SYNOMEM_PRESET)')
    .option('--json', 'emit stable machine-readable JSON', false)
    .showSuggestionAfterError()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  /* ------------------------------------------------------------ setup */

  program
    .command('setup')
    .description('Set up a local store with its first agent and a matching fixed profile')
    .option('--backend <kind>', 'local (hosted access uses `connection login`)', 'local')
    .option('--agent <handle>', 'handle of the first agent')
    .option('--name <display-name>', 'display name of the first agent')
    .option('--description <text>')
    .option('--profile-name <name>', 'profile name (defaults to the handle)')
    .action(
      async (
        options: {
          backend: string;
          agent?: string;
          name?: string;
          description?: string;
          profileName?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        if (options.backend !== 'local') {
          throw new SynomemError(
            'INVALID_INPUT',
            'Hosted access is a connection: run `synomem connection login --name <name>`, then `synomem profile create`.',
          );
        }
        let handle = options.agent?.trim();
        let displayName = options.name?.trim();
        if (!handle || !displayName) {
          assertInteractive(
            promptIo,
            'synomem setup --backend local --agent <handle> --name "<display name>"',
          );
          handle ||= await ask(promptIo, 'Agent handle (what people type, e.g. gracie)');
          displayName ||= await ask(promptIo, 'Agent display name', handle);
        }
        if (!handle) throw new SynomemError('INVALID_INPUT', 'An agent handle is required.');
        const profileName = assertName(options.profileName ?? handle, 'profile');
        const store = profileStoreFor(global.home);
        const storeConfig = ensureLocalStore(global.home);
        const config = store.read();

        const existing = config.profiles[profileName];
        const client = await openLocalService(global.home, LOCAL_OPERATOR);
        let agent;
        let resumed = false;
        try {
          const resolution = await client.agents.resolve(handle);
          const match =
            resolution.match && resolution.match.handle.toLowerCase() === handle.toLowerCase()
              ? resolution.match
              : undefined;
          if (existing) {
            // Idempotent re-run: the same profile, same store, same agent.
            if (
              isLocalProfile(existing) &&
              (existing.home ?? global.home) === global.home &&
              match &&
              existing.actorId === match.id
            ) {
              output(
                io,
                global.json,
                {
                  applied: false,
                  profile: profileName,
                  agentId: match.id,
                  contextId: existing.contextId,
                },
                `Already set up: profile ${profileName} acts as ${match.displayName} (${match.id}).\n\nStart the MCP server with:\n  synomem mcp --profile ${profileName}`,
              );
              return;
            }
            throw new SynomemError(
              'CONFIG_INVALID',
              `Profile ${profileName} already exists and points somewhere else; setup will not overwrite it. Pass --profile-name <other>.`,
            );
          }
          if (match) {
            agent = match;
            resumed = true;
          } else {
            agent = await client.agents.create({
              handle,
              displayName: displayName || handle,
              ...(options.description ? { description: options.description } : {}),
            });
          }
        } finally {
          await client.close();
        }

        const actor = { kind: 'agent' as const, id: agent.id };
        const profile: LocalProfile = {
          backend: 'local',
          ...(global.explicitHome ? { home: global.home } : {}),
          actorId: agent.id,
          actorName: agent.displayName,
          contextId: localContextId(storeConfig.workspaceId, actor),
        };
        const next: ProfilesConfig = {
          ...config,
          profiles: { ...config.profiles, [profileName]: profile },
          ...(config.defaultProfile ? {} : { defaultProfile: profileName }),
        };
        store.write(next);
        output(
          io,
          global.json,
          {
            applied: true,
            resumed,
            profile: profileName,
            agentId: agent.id,
            contextId: profile.contextId,
            default: next.defaultProfile === profileName,
            mcpCommand: `synomem mcp --profile ${profileName}`,
          },
          [
            '',
            `${resumed ? 'Found existing agent' : 'Created'} ${agent.displayName}  (handle ${agent.handle}, id ${agent.id})`,
            `Profile ${profileName} acts as it in ${global.home}${next.defaultProfile === profileName ? ' (default)' : ''}.`,
            '',
            'Start the MCP server with:',
            `  synomem mcp --profile ${profileName}`,
            '',
            'Register it with your harness and install the skill:',
            `  synomem skill install --runtime <claude|codex|hermes|...> --profile ${profileName} --yes`,
          ].join('\n'),
        );
      },
    );

  /* ------------------------------------------------------------ connections */

  const connectionCommand = program
    .command('connection')
    .description('Hosted credentials: one per harness installation, shared by its profiles');

  const saveCredential = async (
    global: Globals,
    name: string,
    entry: CredentialEntry,
    credential: StoredCredential | undefined,
  ): Promise<ProfilesConfig> => {
    const store = profileStoreFor(global.home);
    const config = store.read();
    if (credential && entry.store !== 'environment') {
      await storeFor(storesFor(global.home), entry).set(entry.secretRef!, credential);
    }
    const next = { ...config, credentials: { ...config.credentials, [name]: entry } };
    store.write(next);
    return next;
  };

  const verifyConnection = async (
    apiUrl: string,
    bearer: string,
  ): Promise<{ identity: IdentityDescription; contexts: ContextSummary[] }> => {
    const identity = await describeIdentity({
      baseUrl: apiUrl,
      accessToken: bearer,
      fetch: fetchImplementation,
    });
    const listing = await discoverContexts({
      baseUrl: apiUrl,
      accessToken: bearer,
      fetch: fetchImplementation,
    });
    return { identity, contexts: listing.contexts };
  };

  const connectionSummary = (
    name: string,
    identity: IdentityDescription,
    contexts: ContextSummary[],
  ): string =>
    [
      `Connection ${name}${identity.connection ? ` — ${identity.connection.label}` : ''}`,
      ...(identity.grant
        ? [`Grant: ${identity.grant.mode}, ${identity.grant.actions.join(' ')}`]
        : []),
      contexts.length ? 'May act as:' : 'This connection may not act as anything yet.',
      ...contexts.map((context) => `  ${context.contextId}  ${describeContext(context)}`),
      '',
      contexts.length
        ? `Next: synomem profile create <name> --connection ${name} --context <context-id>`
        : 'Authorize an agent for it on the consent screen or in the portal.',
    ].join('\n');

  connectionCommand
    .command('login')
    .description('Sign in through the browser (OAuth 2.1 + PKCE) and store the credential')
    .requiredOption('--name <name>', 'connection name, e.g. codex-mac')
    // Internal: development and private deployments. Kept out of public docs —
    // onboarding must never ask a person for a service address.
    .option('--api-url <url>', 'internal: alternate API origin')
    .option('--client-id <id>', 'OAuth client id (default synomem-cli)')
    .option('--store <where>', 'keychain (default) or file')
    .option('--callback-port <port>', 'loopback callback port', '43817')
    .action(
      async (
        options: {
          name: string;
          apiUrl?: string;
          clientId?: string;
          store?: string;
          callbackPort: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const name = assertName(options.name, 'connection');
        const apiUrl = secureUrl(options.apiUrl ?? cloudApiUrl(env), 'API URL').origin;
        const config = profileStoreFor(global.home).read();
        const existing = config.credentials[name];
        if (existing && existing.kind !== 'oauth') {
          throw new SynomemError(
            'INVALID_INPUT',
            `Connection ${name} is an access key, not a browser sign-in. Choose another name.`,
          );
        }
        const backend = parseCredentialBackend(options.store ?? existing?.store, platform);
        if (backend === 'environment') {
          throw new SynomemError(
            'INVALID_INPUT',
            'A browser sign-in is stored in the keychain or a file, never the environment.',
          );
        }
        const callbackPort = Number(options.callbackPort);
        if (!Number.isSafeInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535) {
          throw new SynomemError('INVALID_INPUT', '--callback-port must be from 1 through 65535.');
        }
        const credential = await oauthLogin({
          apiUrl,
          ...(options.clientId ? { clientId: options.clientId } : {}),
          callbackPort,
          fetch: fetchImplementation,
        });
        const { identity, contexts } = await verifyConnection(apiUrl, credential.accessToken);
        // Re-login keeps the same secret reference, so every profile routing
        // through this connection keeps working with the new credential.
        const entry: CredentialEntry = {
          kind: 'oauth',
          apiUrl,
          store: backend,
          secretRef: existing?.secretRef ?? newSecretReference(),
          issuer: credential.issuer,
          resource: credential.resource,
          clientId: credential.clientId,
          ...(identity.connection
            ? { connectionId: identity.connection.id, label: identity.connection.label }
            : {}),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        await saveCredential(global, name, entry, credential);
        output(
          io,
          global.json,
          { connection: name, store: backend, identity, contexts },
          connectionSummary(name, identity, contexts),
        );
      },
    );

  connectionCommand
    .command('add-key')
    .description('Store a member-owned access key (read from stdin, never an argument)')
    .requiredOption('--name <name>', 'connection name')
    .option('--api-url <url>', 'internal: alternate API origin')
    .option('--store <where>', 'keychain (default), file, or environment')
    .action(
      async (options: { name: string; apiUrl?: string; store?: string }, command: Command) => {
        const global = globals(command);
        const name = assertName(options.name, 'connection');
        const apiUrl = secureUrl(options.apiUrl ?? cloudApiUrl(env), 'API URL').origin;
        const config = profileStoreFor(global.home).read();
        const existing = config.credentials[name];
        if (existing && existing.kind !== 'access-key') {
          throw new SynomemError(
            'INVALID_INPUT',
            `Connection ${name} is a browser sign-in. Choose another name.`,
          );
        }
        const backend = parseCredentialBackend(options.store, platform);
        const secret =
          backend === 'environment'
            ? env.SYNOMEM_ACCESS_TOKEN?.trim()
            : await readAccessKey(promptIo);
        if (!secret) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Set SYNOMEM_ACCESS_TOKEN to the key before adding an environment connection.',
          );
        }
        const { identity, contexts } = await verifyConnection(apiUrl, secret);
        const entry: CredentialEntry = {
          kind: 'access-key',
          apiUrl,
          store: backend,
          ...(backend === 'environment'
            ? {}
            : { secretRef: existing?.secretRef ?? newSecretReference() }),
          ...(identity.connection
            ? { connectionId: identity.connection.id, label: identity.connection.label }
            : {}),
          createdAt: existing?.createdAt ?? new Date().toISOString(),
        };
        await saveCredential(
          global,
          name,
          entry,
          backend === 'environment' ? undefined : { kind: 'access-key', secret },
        );
        output(
          io,
          global.json,
          {
            connection: name,
            store: backend,
            key: credentialFingerprint(secret),
            identity,
            contexts,
          },
          connectionSummary(name, identity, contexts),
        );
      },
    );

  connectionCommand
    .command('list')
    .description('List connections and the profiles using each, without secrets')
    .action((_options, command: Command) => {
      const global = globals(command);
      const config = profileStoreFor(global.home).read();
      const connections = Object.entries(config.credentials).map(([name, entry]) => ({
        name,
        kind: entry.kind,
        store: entry.store,
        apiUrl: entry.apiUrl,
        ...(entry.label ? { label: entry.label } : {}),
        ...(entry.connectionId ? { connectionId: entry.connectionId } : {}),
        profiles: Object.entries(config.profiles)
          .filter(([, profile]) => !isLocalProfile(profile) && profile.credentialRef === name)
          .map(([profileName]) => profileName),
      }));
      output(
        io,
        global.json,
        { connections },
        connections.length
          ? connections
              .map(
                (connection) =>
                  `${connection.name}  ${connection.kind}  ${connection.store}  ${connection.label ?? ''}\n  profiles: ${
                    connection.profiles.join(', ') || 'none'
                  }`,
              )
              .join('\n')
          : 'No connections. Run `synomem connection login --name <name>`.',
      );
    });

  connectionCommand
    .command('status [name]')
    .description('Check that a connection (or every connection) authenticates')
    .action(async (name: string | undefined, _options, command: Command) => {
      const global = globals(command);
      const config = profileStoreFor(global.home).read();
      const names = name ? [name] : Object.keys(config.credentials);
      const results: Array<Record<string, unknown>> = [];
      let failed = false;
      for (const connection of names) {
        const entry = config.credentials[connection];
        if (!entry) throw new SynomemError('CONFIG_INVALID', `Unknown connection "${connection}".`);
        try {
          const bearer = await credentialSourceFor(
            global.home,
            config,
            connection,
            resolverDeps(global.home),
          ).bearer();
          const { identity, contexts } = await verifyConnection(entry.apiUrl, bearer);
          results.push({
            name: connection,
            ok: true,
            store: entry.store,
            identity,
            contexts: contexts.length,
          });
        } catch (error) {
          failed = true;
          const synomemError = asSynomemError(error);
          results.push({
            name: connection,
            ok: false,
            store: entry.store,
            error: { code: synomemError.code, message: synomemError.message },
          });
        }
      }
      output(
        io,
        global.json,
        { connections: results },
        results.length
          ? results
              .map((result) =>
                result.ok
                  ? `${String(result.name)}  ok  (${String(result.store)}) — ${String(result.contexts)} context(s)`
                  : `${String(result.name)}  FAILED  ${(result.error as { message: string }).message}`,
              )
              .join('\n')
          : 'No connections.',
      );
      if (failed) cliExitCodes.set(program, 4);
    });

  connectionCommand
    .command('remove')
    .description('Forget a connection and delete its locally stored secret')
    .requiredOption('--name <name>')
    .option('--force', 'also remove the profiles that use it', false)
    .action(async (options: { name: string; force: boolean }, command: Command) => {
      const global = globals(command);
      const store = profileStoreFor(global.home);
      const config = store.read();
      const entry = config.credentials[options.name];
      if (!entry) throw new SynomemError('CONFIG_INVALID', `Unknown connection "${options.name}".`);
      const dependents = Object.entries(config.profiles)
        .filter(([, profile]) => !isLocalProfile(profile) && profile.credentialRef === options.name)
        .map(([profileName]) => profileName);
      if (dependents.length && !options.force) {
        throw new SynomemError(
          'INVALID_INPUT',
          `Profiles ${dependents.join(', ')} use connection ${options.name}. Remove them first, or pass --force to remove them too.`,
        );
      }
      if (entry.store !== 'environment') {
        await storeFor(storesFor(global.home), entry).delete(entry.secretRef!);
      }
      const profiles = Object.fromEntries(
        Object.entries(config.profiles).filter(
          ([profileName]) => !dependents.includes(profileName),
        ),
      );
      const harnessPresets = Object.fromEntries(
        Object.entries(config.harnessPresets)
          .map(
            ([preset, members]) =>
              [preset, members.filter((member) => !dependents.includes(member))] as const,
          )
          .filter(([, members]) => members.length > 0),
      );
      const credentials = Object.fromEntries(
        Object.entries(config.credentials).filter(([name]) => name !== options.name),
      );
      store.write({
        ...config,
        credentials,
        profiles,
        harnessPresets,
        ...(config.defaultProfile && dependents.includes(config.defaultProfile)
          ? { defaultProfile: undefined }
          : {}),
      });
      output(
        io,
        global.json,
        { removed: options.name, profilesRemoved: dependents },
        [
          `Removed connection ${options.name} and its local secret.`,
          ...(dependents.length ? [`Also removed profiles: ${dependents.join(', ')}.`] : []),
          'The server-side authorization still exists: revoke it in the portal (Connections) to stop it everywhere.',
        ].join('\n'),
      );
    });

  /* ------------------------------------------------------------ profiles */

  const profileCommand = program
    .command('profile')
    .description('Named identities: one stable context through one connection or local store');

  profileCommand
    .command('create <name>')
    .description('Create a profile for a context this connection may already use')
    .option('--connection <name>', 'hosted connection to route through')
    .option('--context <context-id>', 'exact context id (see `connection status`)')
    .option('--agent <handle-or-id>', 'narrow by agent handle, id or display name')
    .option('--workspace <name-or-id>', 'narrow by workspace name or id')
    .option('--local', 'a local-store profile for an existing local agent', false)
    .option('--store-home <path>', 'local store home (default: the Synomem home)')
    .option('--default', 'make this the default profile', false)
    .action(
      async (
        rawName: string,
        options: {
          connection?: string;
          context?: string;
          agent?: string;
          workspace?: string;
          local: boolean;
          storeHome?: string;
          default: boolean;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const name = assertName(rawName, 'profile');
        const store = profileStoreFor(global.home);
        const config = store.read();
        if (config.profiles[name]) {
          throw new SynomemError(
            'CONFIG_INVALID',
            `Profile ${name} already exists. Remove it first to change what it points at.`,
          );
        }

        if (options.local) {
          if (!options.agent)
            throw new SynomemError(
              'INVALID_INPUT',
              'A local profile needs --agent <handle-or-id>.',
            );
          const storeHome = options.storeHome ? resolve(options.storeHome) : global.home;
          const client = await openLocalService(storeHome, LOCAL_OPERATOR);
          let agent;
          try {
            const resolution = await client.agents.resolve(options.agent);
            if (!resolution.match) {
              throw new SynomemError(
                resolution.candidates.length ? 'CONTEXT_AMBIGUOUS' : 'AGENT_NOT_FOUND',
                resolution.candidates.length
                  ? `"${options.agent}" matches several agents: ${resolution.candidates.map((c) => `${c.handle} (${c.id})`).join(', ')}.`
                  : `No local agent answers to "${options.agent}". Profiles never create agents: run \`synomem agent create\` first.`,
              );
            }
            agent = resolution.match;
          } finally {
            await client.close();
          }
          const profile: LocalProfile = {
            backend: 'local',
            ...(storeHome !== global.home ? { home: storeHome } : {}),
            actorId: agent.id,
            actorName: agent.displayName,
            contextId: localContextId(localStoreWorkspaceId(storeHome), {
              kind: 'agent',
              id: agent.id,
            }),
          };
          store.write({
            ...config,
            profiles: { ...config.profiles, [name]: profile },
            ...(options.default || !config.defaultProfile ? { defaultProfile: name } : {}),
          });
          output(
            io,
            global.json,
            { profile: name, ...profile },
            `Created profile ${name}: ${agent.displayName} in ${storeHome}.`,
          );
          return;
        }

        if (!options.connection) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Pass --connection <name> (or --local for a local store).',
          );
        }
        const entry = config.credentials[options.connection];
        if (!entry)
          throw new SynomemError('CONFIG_INVALID', `Unknown connection "${options.connection}".`);
        const bearer = await credentialSourceFor(
          global.home,
          config,
          options.connection,
          resolverDeps(global.home),
        ).bearer();
        const listing = await discoverContexts({
          baseUrl: entry.apiUrl,
          accessToken: bearer,
          fetch: fetchImplementation,
        });
        const lower = (value: string | undefined) => value?.toLowerCase();
        let candidates = listing.contexts.filter((context) => {
          if (options.context && context.contextId !== options.context) return false;
          if (options.agent) {
            const wanted = options.agent.toLowerCase();
            if (
              context.actor.id !== options.agent &&
              lower(context.actor.handle) !== wanted &&
              lower(context.actor.displayName) !== wanted
            )
              return false;
          }
          if (options.workspace) {
            const wanted = options.workspace.toLowerCase();
            if (
              context.workspaceId !== options.workspace &&
              lower(context.workspaceName) !== wanted
            )
              return false;
          }
          return true;
        });
        if (candidates.length === 0) {
          throw new SynomemError(
            'CONTEXT_FORBIDDEN',
            `Connection ${options.connection} may not use any context matching that. Profiles never create agents or grant access — authorize it on the consent screen or in the portal. Available: ${
              listing.contexts
                .map((context) => `${context.contextId} (${describeContext(context)})`)
                .join('; ') || 'none'
            }.`,
          );
        }
        if (candidates.length > 1) {
          if (!promptIo.interactive) {
            throw new SynomemError(
              'CONTEXT_AMBIGUOUS',
              `Several contexts match; pass --context <id>:\n${candidates
                .map((context) => `  ${context.contextId}  ${describeContext(context)}`)
                .join('\n')}`,
            );
          }
          const chosen = await select(
            promptIo,
            'Which identity should this profile act as?',
            candidates.map((context) => ({
              value: context.contextId,
              label: describeContext(context),
              detail: context.contextId,
            })),
          );
          candidates = candidates.filter((context) => context.contextId === chosen);
        }
        const context = candidates[0]!;
        const profile: RemoteProfile = {
          credentialRef: options.connection,
          contextId: context.contextId,
          workspaceId: context.workspaceId,
          ...(context.workspaceName ? { workspaceName: context.workspaceName } : {}),
          actor: {
            kind: context.actor.kind,
            id: context.actor.id,
            ...(context.actor.displayName ? { displayName: context.actor.displayName } : {}),
          },
        };
        store.write({
          ...config,
          profiles: { ...config.profiles, [name]: profile },
          ...(options.default || !config.defaultProfile ? { defaultProfile: name } : {}),
        });
        output(
          io,
          global.json,
          { profile: name, ...profile },
          `Created profile ${name}: ${describeContext(context)} via ${options.connection}.\n\nUse it with --profile ${name}, or start MCP with:\n  synomem mcp --profile ${name}`,
        );
      },
    );

  profileCommand
    .command('list')
    .description('List profiles and presets')
    .action((_options, command: Command) => {
      const global = globals(command);
      const config = profileStoreFor(global.home).read();
      const lines = Object.entries(config.profiles).map(
        ([name, profile]) =>
          `${name === config.defaultProfile ? '*' : ' '} ${describeProfile(name, profile)}`,
      );
      output(
        io,
        global.json,
        {
          profiles: config.profiles,
          presets: config.harnessPresets,
          defaultProfile: config.defaultProfile ?? null,
        },
        lines.length
          ? [
              ...lines,
              ...(Object.keys(config.harnessPresets).length
                ? [
                    '',
                    'Presets:',
                    ...Object.entries(config.harnessPresets).map(
                      ([name, members]) => `  ${name}: ${members.join(', ')}`,
                    ),
                  ]
                : []),
            ].join('\n')
          : 'No profiles. Run `synomem setup --backend local`, or `synomem connection login` then `synomem profile create`.',
      );
    });

  profileCommand
    .command('show <name>')
    .description('Show one profile')
    .action((name: string, _options, command: Command) => {
      const global = globals(command);
      const config = profileStoreFor(global.home).read();
      const profile = config.profiles[name];
      if (!profile) throw new SynomemError('CONFIG_INVALID', `Unknown profile "${name}".`);
      output(
        io,
        global.json,
        { name, ...profile, default: config.defaultProfile === name },
        describeProfile(name, profile),
      );
    });

  profileCommand
    .command('remove <name>')
    .description('Remove a profile (its connection and credential are kept)')
    .option('--force', 'also remove it from presets that use it', false)
    .action((name: string, options: { force: boolean }, command: Command) => {
      const global = globals(command);
      const store = profileStoreFor(global.home);
      const config = store.read();
      if (!config.profiles[name])
        throw new SynomemError('CONFIG_INVALID', `Unknown profile "${name}".`);
      const presets = Object.entries(config.harnessPresets)
        .filter(([, members]) => members.includes(name))
        .map(([preset]) => preset);
      if (presets.length && !options.force) {
        throw new SynomemError(
          'INVALID_INPUT',
          `Presets ${presets.join(', ')} use profile ${name}. Pass --force to remove it from them too.`,
        );
      }
      const profiles = Object.fromEntries(
        Object.entries(config.profiles).filter(([profileName]) => profileName !== name),
      );
      store.write({
        ...config,
        profiles,
        harnessPresets: Object.fromEntries(
          Object.entries(config.harnessPresets)
            .map(
              ([preset, members]) => [preset, members.filter((member) => member !== name)] as const,
            )
            .filter(([, members]) => members.length > 0),
        ),
        ...(config.defaultProfile === name ? { defaultProfile: undefined } : {}),
      });
      output(
        io,
        global.json,
        { removed: name },
        `Removed profile ${name}. Its connection and credential were kept.`,
      );
    });

  profileCommand
    .command('default <name>')
    .description('Make a profile the default when nothing else selects one')
    .action((name: string, _options, command: Command) => {
      const global = globals(command);
      const store = profileStoreFor(global.home);
      const config = store.read();
      if (!config.profiles[name])
        throw new SynomemError('CONFIG_INVALID', `Unknown profile "${name}".`);
      store.write({ ...config, defaultProfile: name });
      output(io, global.json, { defaultProfile: name }, `Default profile: ${name}.`);
    });

  profileCommand
    .command('use <name>')
    .description('Bind this directory to a profile (writes .synomem/config.json)')
    .action((name: string, _options, command: Command) => {
      const global = globals(command);
      const config = profileStoreFor(global.home).read();
      if (!config.profiles[name])
        throw new SynomemError('CONFIG_INVALID', `Unknown profile "${name}".`);
      const path = writeProjectSelection(cwd, { profile: name });
      output(
        io,
        global.json,
        { path, profile: name },
        `Wrote ${path}\n\nCommands and MCP servers started here now act as profile ${name} unless --profile or SYNOMEM_PROFILE says otherwise.`,
      );
    });

  const presetCommand = program
    .command('preset')
    .description('Several profiles served by one explicit-context MCP server');

  presetCommand
    .command('create <name> <profiles...>')
    .description('Create a preset from existing profiles')
    .action((rawName: string, members: string[], _options, command: Command) => {
      const global = globals(command);
      const name = assertName(rawName, 'preset');
      const store = profileStoreFor(global.home);
      const config = store.read();
      if (config.harnessPresets[name])
        throw new SynomemError('CONFIG_INVALID', `Preset ${name} already exists.`);
      const missing = members.filter((member) => !config.profiles[member]);
      if (missing.length)
        throw new SynomemError('CONFIG_INVALID', `Unknown profiles: ${missing.join(', ')}.`);
      const contexts = members.map((member) => config.profiles[member]!.contextId);
      if (new Set(contexts).size !== contexts.length) {
        throw new SynomemError('CONFIG_INVALID', 'Two of those profiles select the same context.');
      }
      store.write({ ...config, harnessPresets: { ...config.harnessPresets, [name]: members } });
      output(
        io,
        global.json,
        { preset: name, profiles: members },
        `Created preset ${name}: ${members.join(', ')}.\n\nStart it with:\n  synomem mcp --preset ${name} --contexts explicit`,
      );
    });

  presetCommand.command('list').action((_options, command: Command) => {
    const global = globals(command);
    const config = profileStoreFor(global.home).read();
    output(
      io,
      global.json,
      { presets: config.harnessPresets },
      Object.entries(config.harnessPresets)
        .map(([name, members]) => `${name}: ${members.join(', ')}`)
        .join('\n') || 'No presets.',
    );
  });

  presetCommand.command('remove <name>').action((name: string, _options, command: Command) => {
    const global = globals(command);
    const store = profileStoreFor(global.home);
    const config = store.read();
    if (!config.harnessPresets[name])
      throw new SynomemError('CONFIG_INVALID', `Unknown preset "${name}".`);
    const harnessPresets = Object.fromEntries(
      Object.entries(config.harnessPresets).filter(([preset]) => preset !== name),
    );
    store.write({ ...config, harnessPresets });
    output(io, global.json, { removed: name }, `Removed preset ${name}.`);
  });

  /* ------------------------------------------------------------ identity */

  program
    .command('whoami')
    .description('Show the selected profile, its effective context, and its credential source')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const config = profileStoreFor(global.home).read();
      const selection = selectionFor(global, config);
      if (!selection) throw noSelectionError();
      const deps = resolverDeps(global.home);
      if (selection.kind === 'preset') {
        const resolver = presetResolver(global.home, config, selection.name, deps);
        try {
          const listing = await resolver.list();
          output(
            io,
            global.json,
            { selection, listing },
            [
              `Preset ${selection.name} (from ${selection.source}) — explicit contexts:`,
              ...listing.contexts.map(
                (context) => `  ${context.contextId}  ${describeContext(context)}`,
              ),
            ].join('\n'),
          );
        } finally {
          await resolver.close?.();
        }
        return;
      }
      const profile = config.profiles[selection.name]!;
      const resolver = profileResolver(global.home, config, selection.name, deps);
      try {
        const { context } = await resolver.resolve();
        const description = await resolver.describe?.().catch(() => undefined);
        const source = isLocalProfile(profile)
          ? `local store ${profile.home ?? global.home}`
          : `connection ${profile.credentialRef} (${config.credentials[profile.credentialRef]?.store ?? '?'})`;
        output(
          io,
          global.json,
          {
            selection,
            effectiveContext: context,
            credentialSource: source,
            identity: description ?? null,
          },
          [
            `Profile:   ${selection.name}  (from ${selection.source})`,
            `Acting as: ${describeEffective(context)}`,
            `Context:   ${context.contextId}`,
            `Source:    ${source}`,
            ...(description?.connection
              ? [`Connection: ${description.connection.label} (${description.connection.id})`]
              : []),
            ...(description?.grant
              ? [`Grant:     ${description.grant.mode}, ${description.grant.actions.join(' ')}`]
              : []),
          ].join('\n'),
        );
      } finally {
        await resolver.close?.();
      }
    });

  /* ------------------------------------------------------------ local stores */

  const workspaceCommand = program
    .command('workspace')
    .description('Local stores on this machine, each a separate SQLite database');

  workspaceCommand
    .command('list')
    .description('List the local stores on this machine')
    .action((_options, command: Command) => {
      const global = globals(command);
      const workspaces = listLocalWorkspaces(global.home);
      output(
        io,
        global.json,
        { workspaces },
        workspaces
          .map(
            (workspace) =>
              `${workspace.name.padEnd(24)} ${workspace.initialized ? workspace.home : `${workspace.home} (not initialized)`}`,
          )
          .join('\n') || 'No local stores.',
      );
    });

  workspaceCommand
    .command('create <name>')
    .description('Create a local store (then `profile create --local --store-home <path>`)')
    .action((name: string, _options, command: Command) => {
      const global = globals(command);
      const home = localWorkspaceHome(name, global.home);
      if (existsSync(join(home, 'config.json'))) {
        throw new SynomemError('INVALID_INPUT', `Workspace already exists: ${name}`);
      }
      ensureLocalStore(home);
      output(io, global.json, { name, home }, `Created local store ${name} at ${home}.`);
    });

  /* ------------------------------------------------------------ remote import */

  const remoteCommand = program.command('remote').description('Hosted workspace administration');

  remoteCommand
    .command('import')
    .description(
      'Preview or confirm a one-way import from a local store into the profile’s workspace',
    )
    .requiredOption('--from-home <path>', 'source local Synomem home')
    .option('--preview', 'validate and return a short-lived import plan')
    .option('--confirm <plan-id>', 'commit the exact bundle authorized by a preview')
    .action(
      async (
        options: { fromHome: string; preview?: boolean; confirm?: string },
        command: Command,
      ) => {
        const global = globals(command);
        if (Boolean(options.preview) === Boolean(options.confirm)) {
          throw new SynomemError('INVALID_INPUT', 'Choose exactly one of --preview or --confirm.');
        }
        const config = profileStoreFor(global.home).read();
        const selection = selectionFor(global, config);
        if (!selection || selection.kind !== 'profile') throw noSelectionError();
        const profile = config.profiles[selection.name]!;
        if (isLocalProfile(profile)) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Importing needs a hosted profile (a human context with administration).',
          );
        }
        const entry = config.credentials[profile.credentialRef]!;
        const bundle = await (dependencies.createImportBundle ?? createLocalImportBundle)(
          options.fromHome,
        );
        const workspaceId = await withProfile(
          command,
          async (_service, context) => context.workspaceId,
        );
        const result = dependencies.remoteImport
          ? await dependencies.remoteImport({
              baseUrl: entry.apiUrl,
              workspaceId,
              contextId: profile.contextId,
              bundle,
              ...(options.confirm ? { planId: options.confirm } : {}),
            })
          : await (async () => {
              const source = credentialSourceFor(
                global.home,
                config,
                profile.credentialRef,
                resolverDeps(global.home),
              );
              const importer = new RemoteImportClient({
                baseUrl: entry.apiUrl,
                workspaceId,
                contextId: profile.contextId,
                credentialProvider: { getAccessToken: () => source.bearer() },
                fetch: fetchImplementation,
              });
              return options.confirm
                ? await importer.confirm(bundle, options.confirm)
                : await importer.preview(bundle);
            })();
        const human =
          'planId' in result
            ? [
                `Import preview: ${result.events} events and ${result.profiles} agent profiles.`,
                `Source: ${result.sourceWorkspaceId}`,
                `Target: ${result.targetWorkspaceId}`,
                `Checksum: ${result.checksum}`,
                `Plan expires: ${result.expiresAt}`,
                `Plan ID: ${result.planId}`,
                'Nothing was imported. Re-run with --confirm <plan-id> to commit this exact snapshot.',
              ].join('\n')
            : `Imported ${result.events} events and ${result.profiles} agent profiles into ${result.targetWorkspaceId}.`;
        output(io, global.json, result, human);
      },
    );

  /* ------------------------------------------------------------ reset */

  program
    .command('reset')
    .description('Remove Synomem configuration, the local database, profiles and stored secrets')
    .option('--integrations', 'also remove installed skills', false)
    .option('--yes', 'apply the displayed plan', false)
    .action(async (options: { integrations: boolean; yes: boolean }, command: Command) => {
      const global = globals(command);
      const home = global.home;
      const store = profileStoreFor(home);
      const config = existsSync(store.path) ? store.read() : undefined;
      const secrets = Object.entries(config?.credentials ?? {})
        .filter(([, entry]) => entry.store !== 'environment')
        .map(([name, entry]) => ({ name, entry }));
      // Every target is an exact path; no recursive delete is derived from a
      // variable that might be empty.
      const targets = [
        join(home, 'config.json'),
        join(home, 'profiles.json'),
        join(home, 'synomem.sqlite3'),
        join(home, 'synomem.sqlite3-wal'),
        join(home, 'synomem.sqlite3-shm'),
        ...secrets
          .filter(({ entry }) => entry.store === 'file')
          .map(({ entry }) => join(home, 'credentials', `${entry.secretRef}.json`)),
      ].filter((path) => existsSync(path));
      const keychain = secrets
        .filter(({ entry }) => entry.store === 'keychain')
        .map(({ name }) => name);
      const skillPlan = options.integrations ? uninstallSkill({ apply: false }) : undefined;
      const skillTargets =
        skillPlan?.locations
          .filter((location) => location.state === 'current' || location.state === 'stale')
          .map((location) => location.target) ?? [];

      if (!options.yes) {
        output(
          io,
          global.json,
          { targets, keychain, skillTargets, applied: false },
          [
            'This will remove:',
            ...(targets.length ? targets.map((path) => `  ${path}`) : ['  (no files found)']),
            ...(keychain.length
              ? [
                  '',
                  'And the keychain secrets of connections:',
                  ...keychain.map((name) => `  ${name}`),
                ]
              : []),
            ...(skillTargets.length
              ? ['', 'And these Synomem-owned skills:', ...skillTargets.map((path) => `  ${path}`)]
              : []),
            '',
            'Server-side authorizations are not revoked; do that in the portal.',
            'Run with --yes to continue.',
          ].join('\n'),
        );
        return;
      }
      const stores = storesFor(home);
      for (const { entry } of secrets.filter(({ entry }) => entry.store === 'keychain')) {
        await stores.keychain.delete(entry.secretRef!).catch(() => false);
      }
      for (const path of targets) rmSync(path, { force: true });
      const skillResult = options.integrations ? uninstallSkill({ apply: true }) : undefined;
      output(
        io,
        global.json,
        { removed: targets, keychain, skills: skillResult?.locations ?? [] },
        [
          `Removed ${targets.length} file(s)${keychain.length ? ` and ${keychain.length} keychain secret(s)` : ''}.`,
          ...(skillResult ? [`Skill locations processed: ${skillResult.locations.length}.`] : []),
        ].join('\n'),
      );
    });

  /* ------------------------------------------------------------ agents */

  const agentCommand = program
    .command('agent')
    .description('Create and inspect stable agent identities');

  agentCommand
    .command('create <handle>')
    .description('Create an agent. The canonical ID is generated, not chosen.')
    .requiredOption('--name <display-name>', 'display name')
    .option('--alias <name>', 'alias (repeatable)', collect, [])
    .option('--description <text>')
    .option('--create-profile', 'local store: also create a same-named fixed profile', false)
    .action(
      async (
        handle: string,
        options: { name: string; alias: string[]; description?: string; createProfile: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        const created = await withManagement(command, async (service, context, storeHome) => ({
          agent: await service.agents.create({
            handle,
            displayName: options.name,
            ...(options.alias.length ? { aliases: options.alias } : {}),
            ...(options.description ? { description: options.description } : {}),
          }),
          remote: context !== undefined,
          storeHome,
        }));
        const agent = created.agent;
        let profileName: string | undefined;
        if (options.createProfile) {
          if (created.remote || !created.storeHome) {
            throw new SynomemError(
              'INVALID_INPUT',
              `Created ${agent.handle} (${agent.id}), but --create-profile works for local stores only. For a hosted agent, authorize it for a connection and run \`synomem profile create\`.`,
            );
          }
          const store = profileStoreFor(global.home);
          const config = store.read();
          profileName = assertName(agent.handle, 'profile');
          if (config.profiles[profileName]) {
            throw new SynomemError(
              'CONFIG_INVALID',
              `Created ${agent.handle} (${agent.id}), but profile ${profileName} already exists.`,
            );
          }
          const profile: LocalProfile = {
            backend: 'local',
            ...(created.storeHome !== global.home ? { home: created.storeHome } : {}),
            actorId: agent.id,
            actorName: agent.displayName,
            contextId: localContextId(localStoreWorkspaceId(created.storeHome), {
              kind: 'agent',
              id: agent.id,
            }),
          };
          store.write({ ...config, profiles: { ...config.profiles, [profileName]: profile } });
        }
        output(
          io,
          global.json,
          { ...agent, ...(profileName ? { profileCreated: profileName } : {}) },
          `Created ${agent.displayName}\n\nHandle:   ${agent.handle}\nAgent ID: ${agent.id}${
            profileName ? `\nProfile:  ${profileName} (synomem mcp --profile ${profileName})` : ''
          }`,
        );
      },
    );

  const aliasCommand = agentCommand
    .command('alias')
    .description('Add or remove discovery aliases without replacing the set');

  aliasCommand
    .command('add <agent> <alias...>')
    .description('Add aliases, keeping the ones already there')
    .action(async (agent: string, aliases: string[], _options, command: Command) => {
      const global = globals(command);
      const profile = await withManagement(command, (service) =>
        service.agents.addAliases(agent, aliases),
      );
      output(io, global.json, profile, `Aliases: ${(profile.aliases ?? []).join(', ') || 'none'}`);
    });

  aliasCommand
    .command('remove <agent> <alias...>')
    .description('Remove aliases, keeping the rest')
    .action(async (agent: string, aliases: string[], _options, command: Command) => {
      const global = globals(command);
      const profile = await withManagement(command, (service) =>
        service.agents.removeAliases(agent, aliases),
      );
      output(io, global.json, profile, `Aliases: ${(profile.aliases ?? []).join(', ') || 'none'}`);
    });

  agentCommand
    .command('rename <agent> <handle>')
    .description('Change an agent handle. Its canonical ID never changes.')
    .action(async (agent: string, handle: string, _options, command: Command) => {
      const global = globals(command);
      const profile = await withManagement(command, (service) =>
        service.agents.update(agent, { handle }),
      );
      output(
        io,
        global.json,
        profile,
        `Handle:   ${profile.handle}\nAgent ID: ${profile.id} (unchanged)`,
      );
    });

  agentCommand
    .command('archive <agent>')
    .description('Stop an agent acting, keeping its records and history')
    .action(async (agent: string, _options, command: Command) => {
      const global = globals(command);
      const profile = await withManagement(command, (service) => service.agents.archive(agent));
      output(io, global.json, profile, `Archived ${profile.handle} (${profile.id})`);
    });

  agentCommand
    .command('restore <agent>')
    .description('Let an archived agent act again')
    .action(async (agent: string, _options, command: Command) => {
      const global = globals(command);
      const profile = await withManagement(command, (service) => service.agents.restore(agent));
      output(io, global.json, profile, `Restored ${profile.handle} (${profile.id})`);
    });

  agentCommand
    .command('list')
    .description('List known agent identities')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const agents = await withManagement(command, (service) => service.agents.list());
      const human = agents.length
        ? agents
            .map(
              (profile) =>
                `${profile.handle}  ${profile.displayName}${profile.status === 'archived' ? '  [archived]' : ''}${
                  profile.aliases?.length ? `  aliases: ${profile.aliases.join(', ')}` : ''
                }\n  ${profile.id}`,
            )
            .join('\n')
        : 'No agents configured.';
      output(io, global.json, { agents }, human);
    });

  agentCommand
    .command('show <id>')
    .description('Show one agent profile, resolving aliases')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const profile = await withManagement(command, (service) => service.agents.get(id));
      output(
        io,
        global.json,
        profile,
        `${profile.displayName}\n\nHandle:   ${profile.handle}\nAgent ID: ${profile.id}\nStatus:   ${profile.status}\n\n${profile.description ?? 'No description.'}`,
      );
    });

  agentCommand
    .command('update <id>')
    .description('Update an agent profile without rewriting history')
    .option('--name <display-name>')
    .option('--alias <id>', 'replace aliases (repeatable)', collect, [])
    .option('--clear-aliases', 'remove every alias', false)
    .option('--description <text>')
    .action(
      async (
        id: string,
        options: { name?: string; alias: string[]; clearAliases: boolean; description?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const hasAliases = options.clearAliases || options.alias.length > 0;
        const profile = await withManagement(command, (service) =>
          service.agents.update(id, {
            ...(options.name ? { displayName: options.name } : {}),
            ...(hasAliases ? { aliases: options.clearAliases ? [] : options.alias } : {}),
            ...(options.description !== undefined ? { description: options.description } : {}),
          }),
        );
        output(io, global.json, profile, `Updated ${profile.displayName} (${profile.id})`);
      },
    );

  agentCommand
    .command('resolve <name>')
    .description('Resolve a name or alias to one agent, or list the candidates')
    .action(async (name: string, _options, command: Command) => {
      const global = globals(command);
      const resolution = await withManagement(command, (service) => service.agents.resolve(name));
      const human = resolution.match
        ? `${resolution.match.displayName} (${resolution.match.id})`
        : resolution.candidates.length
          ? `"${resolution.query}" is ambiguous. Candidates:\n${resolution.candidates
              .map((profile) => `  ${profile.id}  ${profile.displayName}`)
              .join('\n')}`
          : `No agent answers to "${resolution.query}".`;
      output(io, global.json, resolution, human);
    });

  agentCommand
    .command('directory')
    .description('List agents with their runtime bindings')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const entries = await withManagement(command, (service) => service.agents.directory());
      const human = entries.length
        ? entries
            .map((entry) => {
              const runtimes = entry.runtimeBindings.length
                ? entry.runtimeBindings
                    .map(
                      (binding) =>
                        `    ${binding.runtime}${binding.profile ? `/${binding.profile}` : ''}` +
                        `${binding.lastSeenAt ? `  last seen ${binding.lastSeenAt}` : '  not yet seen'}`,
                    )
                    .join('\n')
                : '    no runtime bindings';
              return `${entry.profile.id}  ${entry.profile.displayName}\n${runtimes}`;
            })
            .join('\n')
        : 'No agents configured.';
      output(io, global.json, { entries }, human);
    });

  const runtimeCommand = agentCommand.command('runtime').description('Record where an agent runs');

  runtimeCommand
    .command('bind <agent>')
    .description('Bind an agent to a runtime')
    .requiredOption('--runtime <name>', 'runtime family, e.g. claude-code')
    .option('--runtime-profile <name>', 'named configuration within the runtime')
    .action(
      async (
        agent: string,
        options: { runtime: string; runtimeProfile?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const binding = await withManagement(command, (service) =>
          service.agents.bindRuntime({
            agentId: agent,
            runtime: options.runtime,
            ...(options.runtimeProfile ? { profile: options.runtimeProfile } : {}),
          }),
        );
        output(
          io,
          global.json,
          binding,
          `Bound ${binding.agentId} to ${binding.runtime}${binding.profile ? `/${binding.profile}` : ''} (${binding.id})`,
        );
      },
    );

  runtimeCommand
    .command('list [agent]')
    .description('List runtime bindings for one agent, or for every agent')
    .action(async (agent: string | undefined, _options, command: Command) => {
      const global = globals(command);
      const result = await withManagement(command, async (service) => {
        if (agent) {
          const profile = await service.agents.get(agent);
          return [{ profile, runtimeBindings: await service.agents.bindings(agent) }];
        }
        return (await service.agents.directory()).filter(
          (entry) => entry.runtimeBindings.length > 0,
        );
      });
      const describe = (binding: AgentRuntimeBinding) =>
        `  ${binding.id}  ${binding.runtime}${binding.profile ? `/${binding.profile}` : ''}  bound ${binding.boundAt}`;
      const human = result.length
        ? result
            .map((entry) =>
              [
                `${entry.profile.handle} (${entry.profile.id})`,
                ...entry.runtimeBindings.map(describe),
              ].join('\n'),
            )
            .join('\n')
        : agent
          ? 'No runtime bindings.'
          : 'No agent in this workspace has a runtime binding.';
      output(io, global.json, { agents: result }, human);
    });

  runtimeCommand
    .command('unbind <binding-id>')
    .description('Remove a runtime binding')
    .action(async (bindingId: string, _options, command: Command) => {
      const global = globals(command);
      const removed = await withManagement(command, (service) =>
        service.agents.unbindRuntime(bindingId),
      );
      output(
        io,
        global.json,
        { removed },
        removed ? `Removed binding ${bindingId}.` : `No binding ${bindingId}.`,
      );
    });

  /* ------------------------------------------------------------ topics */

  const topicCommand = program
    .command('topic')
    .description('Create and manage topics — a stable, reusable subject any record can carry');

  topicCommand
    .command('create <display-name>')
    .description('Create a topic. Any actor may create one.')
    .option('--alias <name>', 'alias (repeatable)', collect, [])
    .action(async (displayName: string, options: { alias: string[] }, command: Command) => {
      const global = globals(command);
      const topic = await withProfile(command, (service) =>
        service.topics.create({
          displayName,
          ...(options.alias.length ? { aliases: options.alias } : {}),
        }),
      );
      output(io, global.json, topic, `Created ${topic.displayName}\n\nTopic ID: ${topic.id}`);
    });

  topicCommand
    .command('list')
    .description('List known topics')
    .option('--status <status>', 'active or archived')
    .action(async (options: { status?: string }, command: Command) => {
      const global = globals(command);
      const topics = await withProfile(command, (service) =>
        service.topics.list(
          options.status ? { status: options.status as 'active' | 'archived' } : {},
        ),
      );
      const human = topics.length
        ? topics
            .map(
              (topic) =>
                `${topic.displayName}${topic.status === 'archived' ? '  [archived]' : ''}${
                  topic.aliases?.length ? `  aliases: ${topic.aliases.join(', ')}` : ''
                }\n  ${topic.id}`,
            )
            .join('\n')
        : 'No topics yet.';
      output(io, global.json, { topics }, human);
    });

  topicCommand
    .command('show <id>')
    .description('Show one topic, resolving aliases')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const topic = await withProfile(command, (service) => service.topics.get(id));
      output(
        io,
        global.json,
        topic,
        `${topic.displayName}\n\nTopic ID: ${topic.id}\nStatus:   ${topic.status}\nAliases:  ${topic.aliases?.join(', ') ?? 'none'}`,
      );
    });

  topicCommand
    .command('resolve <name>')
    .description('Resolve a name or alias to one topic, or list the candidates')
    .action(async (name: string, _options, command: Command) => {
      const global = globals(command);
      const resolution = await withProfile(command, (service) => service.topics.resolve(name));
      const human = resolution.match
        ? `${resolution.match.displayName} (${resolution.match.id})`
        : resolution.candidates.length
          ? `"${resolution.query}" is ambiguous. Candidates:\n${resolution.candidates
              .map((topic) => `  ${topic.id}  ${topic.displayName}`)
              .join('\n')}`
          : `No topic answers to "${resolution.query}".`;
      output(io, global.json, resolution, human);
    });

  topicCommand
    .command('rename <id> <display-name>')
    .description("Change a topic's display name. Its ID never changes.")
    .action(async (id: string, displayName: string, _options, command: Command) => {
      const global = globals(command);
      const topic = await withProfile(command, (service) =>
        service.topics.update(id, { displayName }),
      );
      output(
        io,
        global.json,
        topic,
        `Renamed to ${topic.displayName}\nTopic ID: ${topic.id} (unchanged)`,
      );
    });

  topicCommand
    .command('archive <id>')
    .description('Stop a topic being attached to new records, keeping the ones it already has')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const topic = await withProfile(command, (service) => service.topics.archive(id));
      output(io, global.json, topic, `Archived ${topic.displayName} (${topic.id})`);
    });

  topicCommand
    .command('restore <id>')
    .description('Let an archived topic be attached to new records again')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const topic = await withProfile(command, (service) => service.topics.restore(id));
      output(io, global.json, topic, `Restored ${topic.displayName} (${topic.id})`);
    });

  /* ------------------------------------------------------------ skills */

  const skillCommand = program
    .command('skill')
    .description('Install and maintain the packaged agent skill');

  skillCommand
    .command('install')
    .description('Plan or install the skill for detected agent runtimes')
    .option('--runtime <runtime>', `${skillRuntimeHelp} (repeatable)`, collect, [])
    .option('--yes', 'apply the displayed plan', false)
    .option('--force', 'replace a conflicting synomem directory', false)
    .option('--link', 'symlink to the packaged skill instead of copying it', false)
    .action(
      async (
        options: { runtime: string[]; yes: boolean; force: boolean; link: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        const runtimes = skillRuntimes(options.runtime);
        // Only an explicitly named profile is written into registration
        // commands; an inherited default is not something to bake into a harness.
        const profile = global.profile;
        if (profile && !profileStoreFor(global.home).read().profiles[profile]) {
          throw new SynomemError('CONFIG_INVALID', `Unknown profile "${profile}".`);
        }
        const result = installSkill({
          ...(runtimes ? { runtimes } : {}),
          apply: options.yes,
          force: options.force,
          link: options.link,
          ...(profile ? { profile } : {}),
        });
        let bindingWarning: string | undefined;
        if (profile && options.yes) {
          const installed = result.locations
            .filter((location) => location.state !== 'unavailable')
            .map((location) => location.runtime);
          if (installed.length) {
            // Recording where you yourself run is self-service, as the
            // profile's own agent — never on another agent's behalf.
            try {
              await withProfile(command, async (service, context) => {
                if (context.actor.kind !== 'agent') return;
                for (const runtime of installed) {
                  await service.agents.bindRuntime({ agentId: context.actor.id, runtime, profile });
                }
              });
            } catch (error) {
              bindingWarning = `Skill installed, but recording the runtime binding failed: ${asSynomemError(error).message}`;
            }
          }
        }
        output(
          io,
          global.json,
          { ...result, ...(bindingWarning ? { warning: bindingWarning } : {}) },
          `${formatSkillResult(result, 'install')}${bindingWarning ? `\n\n${bindingWarning}` : ''}`,
        );
      },
    );

  skillCommand
    .command('status')
    .description('Show installed, stale, missing, or conflicting skill copies')
    .option('--runtime <runtime>', `${skillRuntimeHelp} (repeatable)`, collect, [])
    .action((options: { runtime: string[] }, command: Command) => {
      const global = globals(command);
      const result = skillStatus({
        runtimes: skillRuntimes(options.runtime),
        ...(global.profile ? { profile: global.profile } : {}),
      });
      output(io, global.json, result, formatSkillResult(result, 'status'));
    });

  skillCommand
    .command('uninstall')
    .description('Plan or remove Synomem-owned skill installations')
    .option('--runtime <runtime>', `${skillRuntimeHelp} (repeatable)`, collect, [])
    .option('--yes', 'apply the displayed plan', false)
    .option('--force', 'remove a conflicting synomem directory', false)
    .action((options: { runtime: string[]; yes: boolean; force: boolean }, command: Command) => {
      const global = globals(command);
      const result = uninstallSkill({
        runtimes: skillRuntimes(options.runtime),
        apply: options.yes,
        force: options.force,
      });
      output(io, global.json, result, formatSkillResult(result, 'uninstall'));
    });

  /* ------------------------------------------------------------ posts */

  const postCommand = program.command('post').description('Publish to everyone in the workspace');

  postCommand
    .command('create')
    .description('Publish a post the whole workspace can read')
    .requiredOption('--title <title>')
    .requiredOption('--body <body>')
    .option('--tag <tag>', 'repeatable', collect, [])
    .option('--topic <id>', 'topic ID (repeatable)', collect, [])
    .option('--reply-to <post-id>')
    .action(
      async (
        options: { title: string; body: string; tag: string[]; topic: string[]; replyTo?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withProfile(command, (service) =>
          service.posts.create({
            title: options.title,
            body: options.body,
            ...(options.tag.length ? { tags: options.tag } : {}),
            ...(options.topic.length ? { topicIds: options.topic } : {}),
            ...(options.replyTo ? { replyTo: options.replyTo } : {}),
          }),
        );
        output(io, global.json, result, `Published ${result.record.event.id}`);
      },
    );

  postCommand
    .command('list')
    .description('List posts in this workspace')
    .option('--limit <n>', 'default 10, maximum 50')
    .action(async (options: { limit?: string }, command: Command) => {
      const global = globals(command);
      const page = await withProfile(command, (service) =>
        service.posts.list(options.limit ? { limit: Number(options.limit) } : {}),
      );
      const human = page.items.length
        ? page.items.map((item) => `${item.id}  ${item.title}`).join('\n')
        : 'No posts yet.';
      output(io, global.json, page, human);
    });

  postCommand
    .command('show <post-id>')
    .description('Show one post with its acknowledgements')
    .action(async (postId: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) => service.posts.get(postId));
      const acks = record.acknowledgments.length
        ? record.acknowledgments
            .map((entry) => `  ${entry.actor.id}${entry.note ? ` — ${entry.note}` : ''}`)
            .join('\n')
        : '  none yet';
      output(
        io,
        global.json,
        record,
        `${record.title}\n\n${record.body}\n\nAcknowledged by:\n${acks}`,
      );
    });

  postCommand
    .command('acknowledge <post-id>')
    .description('Say you have seen a post')
    .option('--note <text>', 'optional context for the author')
    .action(async (postId: string, options: { note?: string }, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) =>
        service.posts.acknowledge({ postId, ...(options.note ? { note: options.note } : {}) }),
      );
      output(io, global.json, record, `Acknowledged ${postId}`);
    });

  postCommand
    .command('roster <post-id>')
    .description('Who has acknowledged a post, and who has not')
    .action(async (postId: string, _options, command: Command) => {
      const global = globals(command);
      const roster = await withProfile(command, (service) => service.posts.roster(postId));
      const lines = [
        `Acknowledged (${roster.acknowledged.length}):`,
        ...(roster.acknowledged.length
          ? roster.acknowledged.map((entry) => `  ${entry.actor.id}`)
          : ['  none yet']),
        `No acknowledgement recorded (${roster.outstanding.length}):`,
        ...(roster.outstanding.length
          ? roster.outstanding.map((entry) => `  ${entry.id}`)
          : ['  none']),
      ];
      if (roster.joinedSince > 0) {
        lines.push(`${roster.joinedSince} agent(s) joined after this was posted.`);
      }
      output(io, global.json, roster, lines.join('\n'));
    });

  postCommand
    .command('archive <post-id>')
    .description('Archive a post you wrote')
    .option('--reason <text>')
    .action(async (postId: string, options: { reason?: string }, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) =>
        service.posts.archive({ postId, ...(options.reason ? { reason: options.reason } : {}) }),
      );
      output(io, global.json, record, `Archived ${postId}`);
    });

  /* ------------------------------------------------------------ kudos */

  const kudosCommand = program.command('kudos').description('Give and manage agent recognition');

  kudosCommand
    .command('give <recipient>')
    .description('Give specific, evidence-based kudos to an agent')
    .requiredOption('--title <title>')
    .requiredOption('--reason <reason>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--topic <id>', 'topic ID (repeatable)', collect, [])
    .option('--evidence <kind:value>', 'sanitized evidence (repeatable)', collect, [])
    .option('--visibility <visibility>', 'private, workspace, or public', 'workspace')
    .option('--idempotency-key <key>')
    .action(
      async (
        recipient: string,
        options: {
          title: string;
          reason: string;
          tag: string[];
          topic: string[];
          evidence: string[];
          visibility: 'private' | 'workspace' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withProfile(command, (service) =>
          service.kudos.give({
            recipientAgentId: recipient,
            title: options.title,
            reason: options.reason,
            visibility: options.visibility,
            ...(options.tag.length ? { tags: options.tag } : {}),
            ...(options.topic.length ? { topicIds: options.topic } : {}),
            ...(options.evidence.length ? { evidence: options.evidence.map(parseEvidence) } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        const event = result.record.event;
        output(
          io,
          global.json,
          result,
          `${result.deduplicated ? 'Found existing' : 'Created'} kudos for ${event.recipientDisplayName}\nTitle: ${event.title}\nDate: ${event.createdAt}\nID: ${event.id}`,
        );
      },
    );

  addListOptions(kudosCommand.command('list').description('List and filter kudos')).action(
    async (options: Record<string, string>, command: Command) => {
      const global = globals(command);
      const page = await withProfile(command, (service) => service.kudos.list(listInput(options)));
      output(
        io,
        global.json,
        page,
        page.items.length
          ? `${page.items.map(lineForSummary).join('\n')}${page.hasMore ? `\nNext cursor: ${page.nextCursor}` : ''}`
          : 'No kudos found.',
      );
    },
  );

  kudosCommand
    .command('show <kudos-id>')
    .description('Show one kudos item and its current state')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) => service.kudos.get(id));
      output(io, global.json, record, showRecord(record));
    });

  kudosCommand
    .command('acknowledge <kudos-id>')
    .description('Record that you (the recipient) reviewed kudos')
    .option('--note <text>')
    .action(async (id: string, options: { note?: string }, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) =>
        service.kudos.acknowledge({ kudosId: id, ...(options.note ? { note: options.note } : {}) }),
      );
      output(io, global.json, record, `Acknowledged ${id}.`);
    });

  kudosCommand
    .command('revoke <kudos-id>')
    .description('Record a revocation while preserving history')
    .requiredOption('--reason <reason>')
    .option('--administrative', 'mark as an administrative revocation', false)
    .action(
      async (
        id: string,
        options: { reason: string; administrative: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withProfile(command, (service) =>
          service.kudos.revoke({
            kudosId: id,
            reason: options.reason,
            administrative: options.administrative,
          }),
        );
        output(io, global.json, record, `Revoked ${id}; the audit trail was preserved.`);
      },
    );

  kudosCommand
    .command('wins [agent]')
    .description('Print the generated WINS.md path or content (local stores)')
    .option('--open', 'open WINS.md in the system GUI', false)
    .option('--print', 'print Markdown content', false)
    .action(
      async (
        agentId: string | undefined,
        options: { open: boolean; print: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        const details = await withManagement(command, async (service, context) => {
          if (context) {
            throw new SynomemError(
              'INVALID_INPUT',
              'Generated WINS.md files are available only for local stores.',
            );
          }
          if (!agentId) throw new SynomemError('INVALID_INPUT', 'Specify an agent.');
          const profile = await service.agents.get(agentId);
          const info = await service.info();
          if (info.backend !== 'local') {
            throw new SynomemError(
              'INVALID_INPUT',
              'Generated WINS.md files are available only for local stores.',
            );
          }
          const capabilities = await service.capabilities();
          const path = join(info.home, profile.handle, 'WINS.md');
          if (!existsSync(path)) {
            const hint = capabilities.projections.writeWinsMarkdown
              ? 'Run `synomem rebuild` to generate it.'
              : 'Enable projection.writeWinsMarkdown and run `synomem rebuild`.';
            throw new SynomemError(
              'INVALID_INPUT',
              `No generated WINS.md exists for ${profile.handle}. ${hint}`,
            );
          }
          return { profile, path, content: readFileSync(path, 'utf8') };
        });
        if (options.open) {
          const commandName =
            process.platform === 'darwin'
              ? 'open'
              : process.platform === 'win32'
                ? 'cmd'
                : 'xdg-open';
          const args =
            process.platform === 'win32' ? ['/c', 'start', '', details.path] : [details.path];
          spawn(commandName, args, { detached: true, stdio: 'ignore' }).unref();
        }
        output(io, global.json, details, options.print ? details.content.trimEnd() : details.path);
      },
    );

  addListOptions(
    kudosCommand.command('stats').description('Show aggregate kudos statistics'),
  ).action(async (options: Record<string, string>, command: Command) => {
    const global = globals(command);
    const stats = await withProfile(command, (service) => service.stats(listInput(options)));
    output(
      io,
      global.json,
      stats,
      `Total: ${stats.total}\nActive: ${stats.active}\nAcknowledged: ${stats.acknowledged}\nRevoked: ${stats.revoked}`,
    );
  });

  /* ------------------------------------------------------------ cross-kind */

  program
    .command('inbox [agent]')
    .description("Show pending kudos, memos, and tasks (the profile's own agent by default)")
    .option('--limit <number>', 'maximum results (default 10, maximum 50)', '10')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(
      async (
        agentId: string | undefined,
        options: { limit: string; cursor?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const page = await withProfile(command, (service, context) => {
          const recipient =
            agentId ?? (context.actor.kind === 'agent' ? context.actor.id : undefined);
          if (!recipient) {
            throw new SynomemError(
              'INVALID_INPUT',
              'This profile is not an agent; name the agent whose inbox to show.',
            );
          }
          return service.items.list({
            participantAgentId: recipient,
            pending: true,
            limit: Number(options.limit),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          });
        });
        output(
          io,
          global.json,
          page,
          page.items.length
            ? `${page.items.map(lineForItem).join('\n')}${page.hasMore ? `\nNext cursor: ${page.nextCursor}` : ''}`
            : 'Inbox is clear.',
        );
      },
    );

  program
    .command('list')
    .description('List compact summaries across all record types')
    .option('--kind <kind>', 'kudos, memo, note, task, todo, or post (repeatable)', collect, [])
    .option('--participant <agent>')
    .option('--author <id>', 'only records written by this actor')
    .option('--tag <tag>')
    .option('--topic <id>', 'only records carrying this topic')
    .option('--status <status>')
    .option('--visibility <visibility>', 'private, workspace, or public')
    .option('--limit <number>', 'maximum results (default 10, maximum 50)', '10')
    .option('--cursor <cursor>')
    .option('--offset <number>', 'deprecated offset', '0')
    .action(async (options: Record<string, string | string[]>, command: Command) => {
      const global = globals(command);
      const page = await withProfile(command, (service) =>
        service.items.list(itemListInput(options)),
      );
      output(
        io,
        global.json,
        page,
        page.items.length
          ? `${page.items.map(lineForItem).join('\n')}${page.hasMore ? `\nNext cursor: ${page.nextCursor}` : ''}`
          : 'No items found.',
      );
    });

  program
    .command('changes')
    .description('List compact changes across all record types after an opaque watermark')
    .option('--kind <kind>', 'filter by kind (repeatable)', collect, [])
    .option('--after <watermark>', 'watermark or change cursor from a previous response')
    .option('--limit <number>', 'maximum changes (default 20, maximum 100)', '20')
    .action(
      async (options: { after?: string; limit: string; kind: string[] }, command: Command) => {
        const global = globals(command);
        const page = await withProfile(command, (service) =>
          service.items.changes({
            limit: Number(options.limit),
            ...(options.kind.length ? { kinds: options.kind as ItemListInput['kinds'] } : {}),
            ...(options.after ? { after: options.after } : {}),
          }),
        );
        const human = page.items.length
          ? `${page.items
              .map(
                (change) =>
                  `${change.sequence}  ${change.createdAt}  ${change.type}  ${change.itemId ?? '-'}`,
              )
              .join('\n')}\nWatermark: ${page.nextCursor}`
          : `No new changes. Watermark: ${page.watermark}`;
        output(io, global.json, page, human);
      },
    );

  /* ------------------------------------------------------------ memos */

  const memoCommand = program.command('memo').description('Send and manage durable messages');

  memoCommand
    .command('send <recipient>')
    .description('Send a durable one-to-one memo')
    .requiredOption('--subject <subject>')
    .requiredOption('--body <body>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--topic <id>', 'topic ID (repeatable)', collect, [])
    .option('--visibility <visibility>', 'private, workspace, or public', 'workspace')
    .option('--idempotency-key <key>')
    .action(
      async (
        recipient: string,
        options: {
          subject: string;
          body: string;
          tag: string[];
          topic: string[];
          visibility: 'private' | 'workspace' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withProfile(command, (service) =>
          service.memos.send({
            recipientAgentId: recipient,
            subject: options.subject,
            body: options.body,
            visibility: options.visibility,
            ...(options.tag.length ? { tags: options.tag } : {}),
            ...(options.topic.length ? { topicIds: options.topic } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        output(
          io,
          global.json,
          result,
          `${result.deduplicated ? 'Found existing' : 'Sent'} memo to ${result.record.event.recipientDisplayName}\nSubject: ${result.record.event.subject}\nID: ${result.record.event.id}`,
        );
      },
    );

  memoCommand
    .command('list')
    .description('List memos')
    .option('--participant <agent>')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .option('--cursor <cursor>')
    .action(
      async (
        options: { participant?: string; status?: string; limit: string; cursor?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const page = await withProfile(command, (service) =>
          service.memos.list({
            ...(options.participant ? { participantAgentId: options.participant } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
        );
        output(io, global.json, page, page.items.map(lineForItem).join('\n') || 'No memos found.');
      },
    );

  memoCommand
    .command('show <memo-id>')
    .description('Show one memo')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) => service.memos.get(id));
      output(
        io,
        global.json,
        record,
        `${record.event.subject}\nID: ${record.event.id}\nStatus: ${record.status}\n\n${record.event.body}`,
      );
    });

  for (const operation of ['read', 'archive'] as const) {
    memoCommand
      .command(`${operation} <memo-id>`)
      .description(
        operation === 'read'
          ? 'Mark a memo addressed to you as read'
          : 'Archive a memo addressed to you',
      )
      .option('--idempotency-key <key>')
      .action(async (id: string, options: { idempotencyKey?: string }, command: Command) => {
        const global = globals(command);
        const record = await withProfile(command, (service) =>
          service.memos[operation]({
            memoId: id,
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        output(io, global.json, record, `Memo ${id} is ${record.status}.`);
      });
  }

  /* ------------------------------------------------------------ notes */

  const noteCommand = program
    .command('note')
    .description('Retain and revise agent-owned knowledge');

  noteCommand
    .command('create')
    .description('Create an owner-private note')
    .option('--owner <agent-id>')
    .requiredOption('--title <title>')
    .requiredOption('--body <body>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--topic <id>', 'topic ID (repeatable)', collect, [])
    .option('--idempotency-key <key>')
    .action(
      async (
        options: {
          owner?: string;
          title: string;
          body: string;
          tag: string[];
          topic: string[];
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withProfile(command, (service) =>
          service.notes.create({
            ...(options.owner ? { ownerAgentId: options.owner } : {}),
            title: options.title,
            body: options.body,
            ...(options.tag.length ? { tags: options.tag } : {}),
            ...(options.topic.length ? { topicIds: options.topic } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        output(
          io,
          global.json,
          result,
          `${result.deduplicated ? 'Found existing' : 'Created'} note\nTitle: ${result.record.current.title}\nID: ${result.record.event.id}`,
        );
      },
    );

  noteCommand
    .command('list')
    .description('List notes')
    .option('--owner <agent>')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .action(
      async (options: { owner?: string; status?: string; limit: string }, command: Command) => {
        const global = globals(command);
        const page = await withProfile(command, (service) =>
          service.notes.list({
            ...(options.owner ? { participantAgentId: options.owner } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit),
          }),
        );
        output(io, global.json, page, page.items.map(lineForItem).join('\n') || 'No notes found.');
      },
    );

  noteCommand
    .command('show <note-id>')
    .description('Show one note')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) => service.notes.get(id));
      output(
        io,
        global.json,
        record,
        `${record.current.title}\nID: ${record.event.id}\nVersion: ${record.current.version}\n\n${record.current.body}`,
      );
    });

  noteCommand
    .command('revise <note-id>')
    .description('Revise a note (optimistic concurrency)')
    .requiredOption('--expected-version <number>')
    .option('--title <title>')
    .option('--body <body>')
    .option('--tag <tag>', 'replace tags', collect, [])
    .option('--idempotency-key <key>')
    .action(
      async (
        id: string,
        options: {
          expectedVersion: string;
          title?: string;
          body?: string;
          tag: string[];
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withProfile(command, (service) =>
          service.notes.revise({
            noteId: id,
            expectedVersion: Number(options.expectedVersion),
            ...(options.title ? { title: options.title } : {}),
            ...(options.body ? { body: options.body } : {}),
            ...(options.tag.length ? { tags: options.tag } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        output(io, global.json, record, `Revised note ${id} to version ${record.current.version}.`);
      },
    );

  noteCommand
    .command('archive <note-id>')
    .description('Archive a note')
    .option('--idempotency-key <key>')
    .action(async (id: string, options: { idempotencyKey?: string }, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) =>
        service.notes.archive({
          noteId: id,
          ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
        }),
      );
      output(io, global.json, record, `Archived note ${id}.`);
    });

  /* ------------------------------------------------------------ todos */

  const todoCommand = program
    .command('todo')
    .description('Create and manage your own private reminders');

  todoCommand
    .command('create')
    .description('Create a private todo')
    .requiredOption('--title <title>')
    .option('--details <text>', 'private working detail')
    .option('--priority <number>', '1 highest, 4 lowest', '3')
    .option('--due-date <date>')
    .option('--due-at <datetime>')
    .option('--time-zone <iana-zone>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--topic <id>', 'topic ID (repeatable)', collect, [])
    .option('--idempotency-key <key>')
    .action(
      async (
        options: {
          title: string;
          details?: string;
          priority: string;
          dueDate?: string;
          dueAt?: string;
          timeZone?: string;
          tag: string[];
          topic: string[];
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withProfile(command, (service) =>
          service.todos.create({
            title: options.title,
            ...(options.details ? { details: options.details } : {}),
            priority: Number(options.priority) as 1 | 2 | 3 | 4,
            ...((due) => (due ? { due } : {}))(taskDue(options)),
            ...(options.tag.length ? { tags: options.tag } : {}),
            ...(options.topic.length ? { topicIds: options.topic } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        output(
          io,
          global.json,
          result,
          `${result.deduplicated ? 'Found existing' : 'Created'} private todo\nTitle: ${result.record.current.title}\nID: ${result.record.event.id}`,
        );
      },
    );

  todoCommand
    .command('list')
    .description('List your todos')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .action(async (options: { status?: string; limit: string }, command: Command) => {
      const global = globals(command);
      const page = await withProfile(command, (service) =>
        service.todos.list({
          ...(options.status ? { status: options.status } : {}),
          limit: Number(options.limit),
        }),
      );
      output(
        io,
        global.json,
        page,
        page.items.length
          ? page.items
              .map((item) => `${item.id}  ${item.status.padEnd(9)}  ${item.title}`)
              .join('\n')
          : 'No todos.',
      );
    });

  todoCommand
    .command('show <todo-id>')
    .description('Show one of your todos')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) => service.todos.get(id));
      output(
        io,
        global.json,
        record,
        `${record.current.title}\nStatus: ${record.status}\nPriority: ${record.current.priority}\nVersion: ${record.current.version}${record.current.details ? `\n\n${record.current.details}` : ''}`,
      );
    });

  for (const operation of ['complete', 'reopen', 'cancel', 'archive'] as const) {
    todoCommand
      .command(`${operation} <todo-id>`)
      .description(`${operation[0]!.toUpperCase()}${operation.slice(1)} one of your todos`)
      .option('--note <text>')
      .option('--reason <text>')
      .option('--idempotency-key <key>')
      .action(
        async (
          id: string,
          options: { note?: string; reason?: string; idempotencyKey?: string },
          command: Command,
        ) => {
          const global = globals(command);
          const key = options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {};
          const record = await withProfile(command, (service) =>
            operation === 'complete'
              ? service.todos.complete({
                  todoId: id,
                  ...(options.note ? { note: options.note } : {}),
                  ...key,
                })
              : operation === 'cancel'
                ? service.todos.cancel({
                    todoId: id,
                    ...(options.reason ? { reason: options.reason } : {}),
                    ...key,
                  })
                : operation === 'archive'
                  ? service.todos.archive({ todoId: id, ...key })
                  : service.todos.reopen({ todoId: id, ...key }),
          );
          output(io, global.json, record, `Todo ${id} is now ${record.status}.`);
        },
      );
  }

  /* ------------------------------------------------------------ tasks */

  const taskCommand = program.command('task').description('Create and manage agent tasks');

  taskCommand
    .command('create <assignee>')
    .description('Assign a task to an agent')
    .requiredOption('--title <title>')
    .option('--description <text>')
    .option('--priority <number>', '1 highest, 4 lowest', '3')
    .option('--due-date <date>')
    .option('--due-at <datetime>')
    .option('--time-zone <iana-zone>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--topic <id>', 'topic ID (repeatable)', collect, [])
    .option('--visibility <visibility>', 'private, workspace, or public', 'workspace')
    .option('--idempotency-key <key>')
    .action(
      async (
        assignee: string,
        options: {
          title: string;
          description?: string;
          priority: string;
          dueDate?: string;
          dueAt?: string;
          timeZone?: string;
          tag: string[];
          topic: string[];
          visibility: 'private' | 'workspace' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withProfile(command, (service) =>
          service.tasks.create({
            assigneeAgentId: assignee,
            title: options.title,
            ...(options.description ? { description: options.description } : {}),
            priority: Number(options.priority) as 1 | 2 | 3 | 4,
            ...((due) => (due ? { due } : {}))(taskDue(options)),
            ...(options.tag.length ? { tags: options.tag } : {}),
            ...(options.topic.length ? { topicIds: options.topic } : {}),
            visibility: options.visibility,
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        output(
          io,
          global.json,
          result,
          `${result.deduplicated ? 'Found existing' : 'Created'} task for ${result.record.event.assigneeDisplayName}\nTitle: ${result.record.current.title}\nID: ${result.record.event.id}`,
        );
      },
    );

  taskCommand
    .command('list')
    .description('List tasks')
    .option('--assignee <agent>')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .action(
      async (options: { assignee?: string; status?: string; limit: string }, command: Command) => {
        const global = globals(command);
        const page = await withProfile(command, (service) =>
          service.tasks.list({
            ...(options.assignee ? { participantAgentId: options.assignee } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit),
          }),
        );
        output(io, global.json, page, page.items.map(lineForItem).join('\n') || 'No tasks found.');
      },
    );

  taskCommand
    .command('show <task-id>')
    .description('Show one task')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withProfile(command, (service) => service.tasks.get(id));
      output(
        io,
        global.json,
        record,
        `${record.current.title}\nID: ${record.event.id}\nStatus: ${record.status}\nVersion: ${record.current.version}`,
      );
    });

  taskCommand
    .command('update <task-id>')
    .description('Update a task (optimistic concurrency)')
    .requiredOption('--expected-version <number>')
    .option('--title <title>')
    .option('--description <text>')
    .option('--priority <number>')
    .option('--due-date <date>')
    .option('--due-at <datetime>')
    .option('--time-zone <iana-zone>')
    .option('--clear-due')
    .option('--visibility <visibility>')
    .option('--idempotency-key <key>')
    .action(
      async (
        id: string,
        options: {
          expectedVersion: string;
          title?: string;
          description?: string;
          priority?: string;
          dueDate?: string;
          dueAt?: string;
          timeZone?: string;
          clearDue?: boolean;
          visibility?: 'private' | 'workspace' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const parsedDue = taskDue(options);
        const record = await withProfile(command, (service) =>
          service.tasks.update({
            taskId: id,
            expectedVersion: Number(options.expectedVersion),
            ...(options.title ? { title: options.title } : {}),
            ...(options.description !== undefined ? { description: options.description } : {}),
            ...(options.priority ? { priority: Number(options.priority) as 1 | 2 | 3 | 4 } : {}),
            ...(options.clearDue ? { due: null } : parsedDue ? { due: parsedDue } : {}),
            ...(options.visibility ? { visibility: options.visibility } : {}),
            ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
          }),
        );
        output(io, global.json, record, `Updated task ${id} to version ${record.current.version}.`);
      },
    );

  for (const operation of ['accept', 'reject', 'complete', 'reopen', 'cancel'] as const) {
    const command_ = taskCommand
      .command(`${operation} <task-id>`)
      .description(`${operation[0]!.toUpperCase()}${operation.slice(1)} a task`)
      .option('--note <text>')
      .option('--reason <text>')
      .option('--idempotency-key <key>');
    // Rejecting requires saying why; accepting may.
    if (operation === 'reject') {
      command_.requiredOption('--response <text>', 'why the task is being refused');
    } else if (operation === 'accept') {
      command_.option('--response <text>', 'conditions, timing, or partial capability');
    }
    command_.action(
      async (
        id: string,
        options: { note?: string; reason?: string; response?: string; idempotencyKey?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const key = options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {};
        const record = await withProfile(command, (service) =>
          operation === 'accept'
            ? service.tasks.accept({
                taskId: id,
                ...(options.response ? { response: options.response } : {}),
                ...key,
              })
            : operation === 'reject'
              ? service.tasks.reject({
                  taskId: id,
                  response: options.response ?? options.reason ?? '',
                  ...key,
                })
              : operation === 'complete'
                ? service.tasks.complete({
                    taskId: id,
                    ...(options.note ? { note: options.note } : {}),
                    ...key,
                  })
                : operation === 'cancel'
                  ? service.tasks.cancel({
                      taskId: id,
                      ...(options.reason ? { reason: options.reason } : {}),
                      ...key,
                    })
                  : service.tasks.reopen({ taskId: id, ...key }),
        );
        output(io, global.json, record, `Task ${id} is ${record.status}.`);
      },
    );
  }

  /* ------------------------------------------------------------ maintenance */

  const projectionCommand = program
    .command('projection')
    .description('Inspect the generated files Synomem derives from events');

  projectionCommand
    .command('status')
    .description('Report whether the generated files match the canonical events (local stores)')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const status = await withManagement(command, (service) => {
        if (!service.projectionStatus) {
          throw new SynomemError(
            'INVALID_INPUT',
            'The hosted API keeps no filesystem projections, so there is nothing to report.',
          );
        }
        return service.projectionStatus();
      });
      const enabled = Object.entries(status.settings)
        .filter(([, on]) => on)
        .map(([name]) => name);
      const lines = [
        `Directory: ${status.directory ?? '(none)'}`,
        `Enabled: ${enabled.length ? enabled.join(', ') : 'none'}`,
        `Last rebuilt: ${status.lastRebuiltAt ?? 'never'}`,
        status.current
          ? `Current: ${status.counts.manifest} generated file(s) match the events.`
          : `Stale: ${status.counts.missing} missing, ${status.counts.unexpected} no longer expected. Run \`synomem rebuild\`.`,
      ];
      for (const path of status.missing) lines.push(`  missing     ${path}`);
      for (const path of status.unexpected) lines.push(`  unexpected  ${path}`);
      output(io, global.json, status, lines.join('\n'));
    });

  program
    .command('rebuild')
    .description('Regenerate current-state and filesystem projections from canonical events')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const result = await withManagement(command, (service) => service.rebuild());
      output(
        io,
        global.json,
        result,
        `Rebuilt ${result.generated.length} file(s); removed ${result.removed.length} stale file(s).`,
      );
    });

  program
    .command('backup <destination>')
    .description('Create a transactionally consistent SQLite backup (local stores)')
    .action(async (destination: string, _options, command: Command) => {
      const global = globals(command);
      const path = await withManagement(command, (service) => {
        if (!service.backup) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Filesystem backup is available only for local stores.',
          );
        }
        return service.backup(destination);
      });
      output(io, global.json, { path }, `Created backup at ${path}`);
    });

  program
    .command('export')
    .description('Export canonical events for portability')
    .addOption(
      new Option('--format <format>').choices(['json', 'jsonl', 'markdown']).default('json'),
    )
    .option('--output <path>', 'write to an explicit destination instead of stdout')
    .action(
      async (
        options: { format: 'json' | 'jsonl' | 'markdown'; output?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const content = await withManagement(command, (service) => service.export(options.format));
        if (options.output) {
          const destination = resolve(options.output);
          atomicWriteFile(destination, content, 0o600);
          output(
            io,
            global.json,
            { path: destination, format: options.format },
            `Exported ${options.format} to ${destination}`,
          );
        } else {
          io.stdout(content);
        }
      },
    );

  program
    .command('doctor')
    .description('Run safe diagnostics')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const result = await withManagement(command, (service) => service.doctor());
      const human = result.diagnostics
        .map((item) => `${item.level.toUpperCase().padEnd(7)} ${item.code}: ${item.message}`)
        .join('\n');
      output(io, global.json, result, human);
      if (!result.healthy) cliExitCodes.set(program, 5);
    });

  /* ------------------------------------------------------------ mcp */

  program
    .command('mcp')
    .description('Run the MCP server over stdio for a profile (fixed) or a preset (explicit)')
    .addOption(
      new Option('--contexts <mode>', 'fixed (a profile) or explicit (a preset)').choices([
        'fixed',
        'explicit',
      ]),
    )
    .action(async (options: { contexts?: 'fixed' | 'explicit' }, command: Command) => {
      const global = globals(command);
      const config = profileStoreFor(global.home).read();
      const selection = selectionFor(global, config);
      if (!selection) throw noSelectionError();
      if (selection.kind === 'preset' && options.contexts !== 'explicit') {
        throw new SynomemError(
          'INVALID_INPUT',
          `Preset ${selection.name} serves several identities; start it with --contexts explicit so every tool call names its context.`,
        );
      }
      if (selection.kind === 'profile' && options.contexts === 'explicit') {
        throw new SynomemError(
          'INVALID_INPUT',
          'A profile is one fixed identity. Use --preset <name> --contexts explicit for several.',
        );
      }
      const deps = resolverDeps(global.home);
      const resolver: ContextResolver =
        selection.kind === 'profile'
          ? profileResolver(global.home, config, selection.name, deps)
          : presetResolver(global.home, config, selection.name, deps);
      await (dependencies.startMcpServer ?? runStdioServer)({ resolver });
    });

  return program;
}

/**
 * Serves one resolver over stdio until the client disconnects.
 *
 * Deliberately not imported from `mcp-server.js`: that file is the
 * `synomem-mcp` entry point and delegates to this module at its own top level,
 * so importing it back from here is a circular top-level await that never
 * settles when `synomem-mcp` is the process entry.
 */
async function runStdioServer(options: { resolver: ContextResolver }): Promise<void> {
  const runtime = await serveStdio(options.resolver, {});
  await new Promise<void>((resolveClosed) => {
    const previous = runtime.server.server.onclose;
    runtime.server.server.onclose = () => {
      previous?.();
      resolveClosed();
    };
    // The stdio transport does not close itself when the client closes stdin;
    // without this the process would exit with this promise unsettled.
    process.stdin.once('end', () => resolveClosed());
  });
  await runtime.close().catch(() => undefined);
  await options.resolver.close?.();
}

export async function runCli(
  argv = process.argv,
  io: CliIo = defaultIo,
  dependencies: CliDependencies = {},
): Promise<number> {
  const env = dependencies.env ?? process.env;
  const json = argv.includes('--json');
  const obsolete = obsoleteIdentityInput(argv, env);
  if (obsolete) {
    const message = `${obsolete} is no longer supported: the acting identity comes from a profile. Pass --profile <name> (see \`synomem profile list\`), or create one with \`synomem profile create\`.`;
    io.stderr(
      json
        ? `${JSON.stringify({ ok: false, error: { code: 'INVALID_INPUT', message } })}\n`
        : `Error [INVALID_INPUT]: ${message}\n`,
    );
    return 2;
  }
  const program = createCli(io, dependencies);
  program.exitOverride();
  try {
    await program.parseAsync(argv);
    return cliExitCodes.get(program) ?? 0;
  } catch (error) {
    if (error instanceof CommanderError && error.exitCode === 0) return 0;
    if (error instanceof CommanderError) {
      if (!error.message.startsWith('error:')) io.stderr(`${error.message}\n`);
      return 2;
    }
    const synomemError = asSynomemError(error);
    io.stderr(
      json
        ? `${JSON.stringify({ ok: false, error: { code: synomemError.code, message: synomemError.message } })}\n`
        : `Error [${synomemError.code}]: ${synomemError.message}\n`,
    );
    return exitCode(synomemError.code);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli();
}
