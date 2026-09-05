#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { configuredServiceFactory, readSynomemConfig, writeSynomemBackend } from './backend.js';
import { credentialReference, OsCredentialStore, type CredentialStore } from './credentials.js';
import { asSynomemError, SynomemError, type SynomemErrorCode } from './errors.js';
import { atomicWriteFile } from './fs-utils.js';
import { startMcpServer } from './mcp/index.js';
import { loginWithOAuth, StoredCredentialProvider, type OAuthLoginOptions } from './oauth.js';
import { RemoteSynomemService } from './remote.js';
import {
  createLocalImportBundle,
  RemoteImportClient,
  type ImportBundle,
  type ImportPreview,
  type ImportResult,
} from './import.js';
import {
  formatSkillResult,
  installSkill,
  skillRuntimeNames,
  skillStatus,
  uninstallSkill,
  type SkillRuntime,
} from './skill-install.js';
import type {
  ActorIdentity,
  EvidenceReference,
  KudosListInput,
  KudosRecord,
  KudosSummary,
  ItemListInput,
  ItemSummary,
  TodoDue,
} from './types.js';
import { packageVersion } from './version.js';
import type { SynomemService, SynomemServiceFactory } from './service.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDependencies {
  credentialStore?: CredentialStore;
  oauthLogin?: (options: OAuthLoginOptions) => Promise<void>;
  env?: NodeJS.ProcessEnv;
  verifyRemoteCredential?: (options: {
    baseUrl: string;
    workspaceId: string;
    actor: ActorIdentity;
    reference: string;
    credentialStore: CredentialStore;
  }) => Promise<void>;
  createImportBundle?: (home: string) => Promise<ImportBundle>;
  remoteImport?: (options: {
    baseUrl: string;
    workspaceId: string;
    actor: ActorIdentity;
    bundle: ImportBundle;
    planId?: string;
  }) => Promise<ImportPreview | ImportResult>;
}

const defaultIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

const cliExitCodes = new WeakMap<Command, number>();

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

function actor(kind: string, id: string, displayName?: string): ActorIdentity {
  return {
    kind: kind as ActorIdentity['kind'],
    id,
    ...(displayName ? { displayName } : {}),
  };
}

/**
 * The acting identity for commands that do not take an explicit actor.
 * Local storage accepts any actor, so these fall back to the historical CLI defaults; a remote
 * backend binds the credential to one actor, so SYNOMEM_ACTOR_ID/KIND/NAME must be able to
 * override them or those commands cannot authenticate.
 */
function defaultActor(
  env: NodeJS.ProcessEnv,
  fallbackKind: string,
  fallbackId: string,
): ActorIdentity {
  const id = env.SYNOMEM_ACTOR_ID?.trim();
  if (!id) return actor(fallbackKind, fallbackId);
  return actor(env.SYNOMEM_ACTOR_KIND?.trim() || fallbackKind, id, env.SYNOMEM_ACTOR_NAME?.trim());
}

function todoDue(options: {
  dueDate?: string;
  dueAt?: string;
  timeZone?: string;
}): TodoDue | undefined {
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
    code === 'AUTH_FORBIDDEN'
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
    ...(typeof options.actor === 'string' ? { actorId: options.actor } : {}),
    ...(typeof options.status === 'string' ? { status: options.status } : {}),
    ...(typeof options.tag === 'string' ? { tag: options.tag } : {}),
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

function globals(command: Command): { home?: string; json: boolean } {
  return command.optsWithGlobals<{ home?: string; json: boolean }>();
}

async function withService<T>(
  serviceFactory: SynomemServiceFactory,
  home: string | undefined,
  configuredActor: ActorIdentity,
  operation: (client: SynomemService) => Promise<T>,
): Promise<T> {
  const client = serviceFactory({ ...(home ? { home } : {}), actor: configuredActor });
  await client.init();
  try {
    return await operation(client);
  } finally {
    await client.close();
  }
}

function addListOptions(command: Command): Command {
  return command
    .option('--recipient <agent>')
    .option('--actor <id>')
    .option('--actor-kind <kind>', 'human, agent, or system')
    .option('--tag <tag>')
    .option('--status <status>', 'acknowledged or unacknowledged')
    .option('--visibility <visibility>', 'private, local, or public')
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
    ...(options.actor ? { actorId: options.actor } : {}),
    ...(options.actorKind ? { actorKind: options.actorKind as KudosListInput['actorKind'] } : {}),
    ...(options.tag ? { tag: options.tag } : {}),
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

export function createCli(
  io: CliIo = defaultIo,
  serviceFactory: SynomemServiceFactory = configuredServiceFactory,
  dependencies: CliDependencies = {},
): Command {
  const env = dependencies.env ?? process.env;
  const credentialStore = dependencies.credentialStore ?? new OsCredentialStore();
  const oauthLogin = dependencies.oauthLogin ?? loginWithOAuth;
  const verifyRemoteCredential =
    dependencies.verifyRemoteCredential ??
    (async (options) => {
      const remote = new RemoteSynomemService({
        baseUrl: options.baseUrl,
        workspaceId: options.workspaceId,
        expectedActor: options.actor,
        credentialProvider: new StoredCredentialProvider(
          options.reference,
          options.credentialStore,
          {},
        ),
      });
      try {
        await remote.init();
      } finally {
        await remote.close();
      }
    });

  const program = new Command();
  const withClient = <T>(
    home: string | undefined,
    configuredActor: ActorIdentity,
    operation: (client: SynomemService) => Promise<T>,
  ) => withService(serviceFactory, home, configuredActor, operation);
  cliExitCodes.set(program, 0);
  program
    .name('synomem')
    .description(
      'Local-first communication, memory, recognition, and task infrastructure for agents',
    )
    .version(packageVersion())
    .option('--home <path>', 'storage root (defaults to SYNOMEM_HOME or ~/.agents)')
    .option('--json', 'emit stable machine-readable JSON', false)
    .showSuggestionAfterError()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  const remoteCommand = program.command('remote').description('Administer a remote workspace');
  remoteCommand
    .command('import')
    .description('Preview or confirm a one-way import from a local Synomem home')
    .requiredOption('--from-home <path>', 'source local Synomem home')
    .requiredOption('--actor-id <id>', 'bound human administrator actor ID')
    .option('--actor-name <name>', 'expected administrator display name')
    .option('--preview', 'validate and return a short-lived import plan')
    .option('--confirm <plan-id>', 'commit the exact bundle authorized by a preview')
    .action(
      async (
        options: {
          fromHome: string;
          actorId: string;
          actorName?: string;
          preview?: boolean;
          confirm?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        if (Boolean(options.preview) === Boolean(options.confirm)) {
          throw new SynomemError('INVALID_INPUT', 'Choose exactly one of --preview or --confirm.');
        }
        const config = readSynomemConfig(global.home, env);
        if (config?.backend.kind !== 'remote') {
          throw new SynomemError('INVALID_INPUT', 'Select a remote backend before importing.');
        }
        const backend = config.backend;
        const administrator = actor('human', options.actorId, options.actorName);
        const bundle = await (dependencies.createImportBundle ?? createLocalImportBundle)(
          options.fromHome,
        );
        const result = dependencies.remoteImport
          ? await dependencies.remoteImport({
              baseUrl: backend.baseUrl,
              workspaceId: backend.workspaceId,
              actor: administrator,
              bundle,
              ...(options.confirm ? { planId: options.confirm } : {}),
            })
          : await (async () => {
              const credentialProvider = env.SYNOMEM_ACCESS_TOKEN
                ? { getAccessToken: async () => env.SYNOMEM_ACCESS_TOKEN }
                : new StoredCredentialProvider(
                    credentialReference(backend.baseUrl, backend.workspaceId, administrator),
                    credentialStore,
                    env,
                  );
              const importer = new RemoteImportClient({
                baseUrl: backend.baseUrl,
                workspaceId: backend.workspaceId,
                credentialProvider,
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

  program
    .command('init')
    .description('Initialize the local Synomem database')
    .action(async (_options, command: Command) => {
      const options = globals(command);
      const persisted = readSynomemConfig(options.home);
      if (persisted?.backend.kind === 'remote') {
        throw new SynomemError('INVALID_INPUT', 'The init command requires a local backend.');
      }
      await withClient(options.home, defaultActor(env, 'system', 'cli'), async (client) => {
        const info = await client.info();
        if (info.backend !== 'local') {
          throw new SynomemError('INVALID_INPUT', 'The init command requires a local backend.');
        }
        output(
          io,
          options.json,
          { home: info.home, database: info.databasePath },
          `Initialized Synomem at ${info.home}`,
        );
      });
    });

  const backendCommand = program
    .command('backend')
    .description('Inspect or select the canonical backend');
  backendCommand
    .command('show')
    .description('Show backend selection without connecting')
    .action((_options, command: Command) => {
      const global = globals(command);
      const config = readSynomemConfig(global.home);
      const backend = config?.backend ?? { kind: 'local' as const };
      const human =
        backend.kind === 'local'
          ? `Backend: local${config ? `\nWorkspace: ${config.workspaceId}` : ' (not initialized)'}`
          : `Backend: remote\nURL: ${backend.baseUrl}\nWorkspace: ${backend.workspaceId}`;
      output(io, global.json, { backend, initialized: config !== undefined }, human);
    });
  backendCommand
    .command('use')
    .description('Select local or remote canonical state')
    .argument('<kind>', 'local or remote')
    .option('--url <url>', 'remote HTTPS origin')
    .option('--workspace <id>', 'remote workspace ID')
    .action((kind: string, options: { url?: string; workspace?: string }, command: Command) => {
      const global = globals(command);
      if (kind !== 'local' && kind !== 'remote') {
        throw new SynomemError('INVALID_INPUT', 'Backend kind must be local or remote.');
      }
      if (kind === 'remote' && (!options.url || !options.workspace)) {
        throw new SynomemError(
          'INVALID_INPUT',
          'Remote backend selection requires --url and --workspace.',
        );
      }
      const config = writeSynomemBackend(
        kind === 'local'
          ? { kind: 'local' }
          : { kind: 'remote', baseUrl: options.url!, workspaceId: options.workspace! },
        global.home,
      );
      output(
        io,
        global.json,
        { backend: config.backend },
        `Selected ${config.backend.kind} Synomem backend.`,
      );
    });

  const authCommand = program.command('auth').description('Inspect remote authentication');
  authCommand
    .command('status')
    .description('Report token availability without printing it')
    .option('--actor-id <id>', 'bound actor ID (or SYNOMEM_ACTOR_ID)')
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .action(async (options: { actorId?: string; actorKind: string }, command: Command) => {
      const global = globals(command);
      if (env.SYNOMEM_ACCESS_TOKEN) {
        output(
          io,
          global.json,
          { authenticated: true, source: 'environment' },
          'Remote authentication token is available from SYNOMEM_ACCESS_TOKEN.',
        );
        return;
      }
      const config = readSynomemConfig(global.home, env);
      if (config?.backend.kind !== 'remote') {
        throw new SynomemError(
          'INVALID_INPUT',
          'Select a remote backend before checking authentication.',
        );
      }
      const actorId = options.actorId ?? env.SYNOMEM_ACTOR_ID;
      if (!actorId) throw new SynomemError('INVALID_INPUT', 'Specify --actor-id.');
      const reference = credentialReference(
        config.backend.baseUrl,
        config.backend.workspaceId,
        actor(options.actorKind, actorId),
      );
      const available = Boolean(await credentialStore.get(reference));
      output(
        io,
        global.json,
        { authenticated: available, source: available ? 'os-credential-store' : undefined },
        available
          ? 'A remote credential is available in the operating-system credential store.'
          : 'Remote authentication is not configured.',
      );
    });
  authCommand
    .command('login')
    .description('Authorize this actor with OAuth 2.1 authorization code and PKCE')
    .requiredOption('--actor-id <id>', 'bound actor ID')
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .option('--actor-name <name>', 'expected actor display name')
    .option('--client-id <id>', 'registered public OAuth client ID (or SYNOMEM_OAUTH_CLIENT_ID)')
    .option('--scope <scope>', 'requested OAuth scopes')
    .option('--callback-port <port>', 'loopback callback port', '43817')
    .action(
      async (
        options: {
          actorId: string;
          actorKind: string;
          actorName?: string;
          clientId?: string;
          scope?: string;
          callbackPort: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const config = readSynomemConfig(global.home, env);
        if (config?.backend.kind !== 'remote') {
          throw new SynomemError('INVALID_INPUT', 'Select a remote backend before login.');
        }
        const configuredActor = actor(options.actorKind, options.actorId, options.actorName);
        const clientId = options.clientId ?? env.SYNOMEM_OAUTH_CLIENT_ID;
        if (!clientId) throw new SynomemError('INVALID_INPUT', 'Specify --client-id.');
        const callbackPort = Number(options.callbackPort);
        if (!Number.isSafeInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535) {
          throw new SynomemError('INVALID_INPUT', '--callback-port must be from 1 through 65535.');
        }
        const reference = credentialReference(
          config.backend.baseUrl,
          config.backend.workspaceId,
          configuredActor,
        );
        await oauthLogin({
          baseUrl: config.backend.baseUrl,
          clientId,
          credentialReference: reference,
          credentialStore,
          callbackPort,
          ...(options.scope ? { scope: options.scope } : {}),
        });
        try {
          await verifyRemoteCredential({
            baseUrl: config.backend.baseUrl,
            workspaceId: config.backend.workspaceId,
            actor: configuredActor,
            reference,
            credentialStore,
          });
        } catch (error) {
          await credentialStore.delete(reference);
          throw error;
        }
        output(
          io,
          global.json,
          { authenticated: true, source: 'os-credential-store', actor: configuredActor },
          `Authorized ${configuredActor.kind}:${configuredActor.id}; the credential is stored by the operating system.`,
        );
      },
    );
  authCommand
    .command('logout')
    .description('Remove the stored OAuth credential for one actor')
    .requiredOption('--actor-id <id>', 'bound actor ID')
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .action(async (options: { actorId: string; actorKind: string }, command: Command) => {
      const global = globals(command);
      const config = readSynomemConfig(global.home, env);
      if (config?.backend.kind !== 'remote') {
        throw new SynomemError('INVALID_INPUT', 'Select a remote backend before logout.');
      }
      const configuredActor = actor(options.actorKind, options.actorId);
      const removed = await credentialStore.delete(
        credentialReference(config.backend.baseUrl, config.backend.workspaceId, configuredActor),
      );
      output(
        io,
        global.json,
        { authenticated: false, removed },
        removed
          ? 'Removed the stored Synomem credential.'
          : 'No stored Synomem credential existed.',
      );
    });

  const agentCommand = program
    .command('agent')
    .description('Create and inspect stable agent identities');
  agentCommand
    .command('create <id>')
    .description('Create a stable agent profile')
    .requiredOption('--name <display-name>', 'display name')
    .option('--alias <id>', 'alias (repeatable)', collect, [])
    .option('--description <text>')
    .action(
      async (
        id: string,
        options: { name: string; alias: string[]; description?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
          client.agents.create({
            id,
            displayName: options.name,
            ...(options.alias.length ? { aliases: options.alias } : {}),
            ...(options.description ? { description: options.description } : {}),
          }),
        );
        output(io, global.json, profile, `Created ${profile.displayName} (${profile.id})`);
      },
    );

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
    .option('--actor-id <id>', 'print actor-bound MCP registration commands')
    .option('--actor-name <name>', 'display name used in MCP registration commands')
    .action(
      (
        options: {
          runtime: string[];
          yes: boolean;
          force: boolean;
          link: boolean;
          actorId?: string;
          actorName?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = installSkill({
          runtimes: skillRuntimes(options.runtime),
          apply: options.yes,
          force: options.force,
          link: options.link,
          actorId: options.actorId,
          actorName: options.actorName,
        });
        output(io, global.json, result, formatSkillResult(result, 'install'));
      },
    );

  skillCommand
    .command('status')
    .description('Show installed, stale, missing, or conflicting skill copies')
    .option('--runtime <runtime>', `${skillRuntimeHelp} (repeatable)`, collect, [])
    .option('--actor-id <id>', 'print actor-bound MCP registration commands')
    .option('--actor-name <name>', 'display name used in MCP registration commands')
    .action(
      (options: { runtime: string[]; actorId?: string; actorName?: string }, command: Command) => {
        const global = globals(command);
        const result = skillStatus({
          runtimes: skillRuntimes(options.runtime),
          actorId: options.actorId,
          actorName: options.actorName,
        });
        output(io, global.json, result, formatSkillResult(result, 'status'));
      },
    );

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

  agentCommand
    .command('list')
    .description('List known agent identities')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const agents = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.list(),
      );
      const human = agents.length
        ? agents
            .map(
              (profile) =>
                `${profile.id}  ${profile.displayName}${profile.aliases?.length ? `  aliases: ${profile.aliases.join(', ')}` : ''}`,
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
      const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.get(id),
      );
      output(
        io,
        global.json,
        profile,
        `${profile.displayName} (${profile.id})\n${profile.description ?? 'No description.'}`,
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
        const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
          client.agents.update(id, {
            ...(options.name ? { displayName: options.name } : {}),
            ...(hasAliases ? { aliases: options.clearAliases ? [] : options.alias } : {}),
            ...(options.description !== undefined ? { description: options.description } : {}),
          }),
        );
        output(io, global.json, profile, `Updated ${profile.displayName} (${profile.id})`);
      },
    );

  const kudosCommand = program.command('kudos').description('Give and manage agent recognition');

  kudosCommand
    .command('give <recipient>')
    .description('Give specific, evidence-based kudos to an agent')
    .requiredOption('--from <actor-id>', 'stable ID of the giver')
    .requiredOption('--actor-kind <kind>', 'human, agent, or system')
    .option('--actor-name <display-name>')
    .requiredOption('--title <title>')
    .requiredOption('--reason <reason>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--evidence <kind:value>', 'sanitized evidence (repeatable)', collect, [])
    .option('--visibility <visibility>', 'private, local, or public', 'workspace')
    .option('--idempotency-key <key>')
    .action(
      async (
        recipient: string,
        options: {
          from: string;
          actorKind: string;
          actorName?: string;
          title: string;
          reason: string;
          tag: string[];
          evidence: string[];
          visibility: 'private' | 'workspace' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withClient(
          global.home,
          actor(options.actorKind, options.from, options.actorName),
          (client) =>
            client.kudos.give({
              recipientAgentId: recipient,
              title: options.title,
              reason: options.reason,
              visibility: options.visibility,
              ...(options.tag.length ? { tags: options.tag } : {}),
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

  program
    .command('inbox [agent]')
    .description('Show pending kudos, memos, and todos for an agent')
    .option('--as <agent-id>', 'defaults to the positional agent')
    .option('--limit <number>', 'maximum results (default 10, maximum 50)', '10')
    .option('--cursor <cursor>', 'opaque cursor returned by the previous page')
    .action(
      async (
        agentId: string | undefined,
        options: { as?: string; limit: string; cursor?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const recipient = agentId ?? options.as;
        if (!recipient) throw new SynomemError('INVALID_INPUT', 'Specify an agent inbox.');
        const page = await withClient(
          global.home,
          actor('agent', options.as ?? recipient),
          (client) =>
            client.items.list({
              participantAgentId: recipient,
              pending: true,
              limit: Number(options.limit),
              ...(options.cursor ? { cursor: options.cursor } : {}),
            }),
        );
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

  addListOptions(kudosCommand.command('list').description('List and filter kudos')).action(
    async (options: Record<string, string>, command: Command) => {
      const global = globals(command);
      const page = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
        client.kudos.list(listInput(options)),
      );
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

  program
    .command('list')
    .description('List compact summaries across all record types')
    .option('--kind <kind>', 'kudos, memo, note, or todo (repeatable)', collect, [])
    .option('--participant <agent>')
    .option('--actor <id>')
    .option('--tag <tag>')
    .option('--status <status>')
    .option('--visibility <visibility>', 'private, workspace, or public')
    .option('--limit <number>', 'maximum results (default 10, maximum 50)', '10')
    .option('--cursor <cursor>')
    .option('--offset <number>', 'deprecated offset', '0')
    .action(async (options: Record<string, string | string[]>, command: Command) => {
      const global = globals(command);
      const page = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
        client.items.list(itemListInput(options)),
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
        const page = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
          client.items.changes({
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

  const memoCommand = program.command('memo').description('Send and manage durable messages');
  memoCommand
    .command('send <recipient>')
    .requiredOption('--from <actor-id>')
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .option('--actor-name <name>')
    .requiredOption('--subject <subject>')
    .requiredOption('--body <body>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--visibility <visibility>', 'private, workspace, or public', 'workspace')
    .option('--idempotency-key <key>')
    .action(
      async (
        recipient: string,
        options: {
          from: string;
          actorKind: string;
          actorName?: string;
          subject: string;
          body: string;
          tag: string[];
          visibility: 'private' | 'workspace' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withClient(
          global.home,
          actor(options.actorKind, options.from, options.actorName),
          (client) =>
            client.memos.send({
              recipientAgentId: recipient,
              subject: options.subject,
              body: options.body,
              visibility: options.visibility,
              ...(options.tag.length ? { tags: options.tag } : {}),
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
        const page = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
          client.memos.list({
            ...(options.participant ? { participantAgentId: options.participant } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit),
            ...(options.cursor ? { cursor: options.cursor } : {}),
          }),
        );
        output(io, global.json, page, page.items.map(lineForItem).join('\n') || 'No memos found.');
      },
    );
  memoCommand.command('show <memo-id>').action(async (id: string, _options, command: Command) => {
    const global = globals(command);
    const record = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
      client.memos.get(id),
    );
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
      .requiredOption('--as <agent-id>')
      .option('--actor-kind <kind>', 'agent or human', 'agent')
      .option('--idempotency-key <key>')
      .action(
        async (
          id: string,
          options: { as: string; actorKind: string; idempotencyKey?: string },
          command: Command,
        ) => {
          const global = globals(command);
          const record = await withClient(
            global.home,
            actor(options.actorKind, options.as),
            (client) =>
              client.memos[operation]({
                memoId: id,
                ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
              }),
          );
          output(io, global.json, record, `Memo ${id} is ${record.status}.`);
        },
      );
  }

  const noteCommand = program
    .command('note')
    .description('Retain and revise agent-owned knowledge');
  noteCommand
    .command('create')
    .requiredOption('--as <actor-id>')
    .option('--actor-kind <kind>', 'agent or human', 'agent')
    .option('--owner <agent-id>')
    .requiredOption('--title <title>')
    .requiredOption('--body <body>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--idempotency-key <key>')
    .action(
      async (
        options: {
          as: string;
          actorKind: string;
          owner?: string;
          title: string;
          body: string;
          tag: string[];
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.notes.create({
              ...(options.owner ? { ownerAgentId: options.owner } : {}),
              title: options.title,
              body: options.body,
              ...(options.tag.length ? { tags: options.tag } : {}),
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
    .option('--owner <agent>')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .action(
      async (options: { owner?: string; status?: string; limit: string }, command: Command) => {
        const global = globals(command);
        const page = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
          client.notes.list({
            ...(options.owner ? { participantAgentId: options.owner } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit),
          }),
        );
        output(io, global.json, page, page.items.map(lineForItem).join('\n') || 'No notes found.');
      },
    );
  noteCommand.command('show <note-id>').action(async (id: string, _options, command: Command) => {
    const global = globals(command);
    const record = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
      client.notes.get(id),
    );
    output(
      io,
      global.json,
      record,
      `${record.current.title}\nID: ${record.event.id}\nVersion: ${record.current.version}\n\n${record.current.body}`,
    );
  });
  noteCommand
    .command('revise <note-id>')
    .requiredOption('--as <actor-id>')
    .option('--actor-kind <kind>', 'agent or human', 'agent')
    .requiredOption('--expected-version <number>')
    .option('--title <title>')
    .option('--body <body>')
    .option('--tag <tag>', 'replace tags', collect, [])
    .option('--idempotency-key <key>')
    .action(
      async (
        id: string,
        options: {
          as: string;
          actorKind: string;
          expectedVersion: string;
          title?: string;
          body?: string;
          tag: string[];
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.notes.revise({
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
    .requiredOption('--as <actor-id>')
    .option('--actor-kind <kind>', 'agent or human', 'agent')
    .option('--idempotency-key <key>')
    .action(
      async (
        id: string,
        options: { as: string; actorKind: string; idempotencyKey?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.notes.archive({
              noteId: id,
              ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            }),
        );
        output(io, global.json, record, `Archived note ${id}.`);
      },
    );

  const todoCommand = program.command('todo').description('Create and manage agent todos');
  todoCommand
    .command('create <assignee>')
    .requiredOption('--from <actor-id>')
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .requiredOption('--title <title>')
    .option('--description <text>')
    .option('--priority <number>', '1 highest, 4 lowest', '3')
    .option('--due-date <date>')
    .option('--due-at <datetime>')
    .option('--time-zone <iana-zone>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--visibility <visibility>', 'private, workspace, or public', 'workspace')
    .option('--idempotency-key <key>')
    .action(
      async (
        assignee: string,
        options: {
          from: string;
          actorKind: string;
          title: string;
          description?: string;
          priority: string;
          dueDate?: string;
          dueAt?: string;
          timeZone?: string;
          tag: string[];
          visibility: 'private' | 'workspace' | 'public';
          idempotencyKey?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withClient(
          global.home,
          actor(options.actorKind, options.from),
          (client) =>
            client.todos.create({
              assigneeAgentId: assignee,
              title: options.title,
              ...(options.description ? { description: options.description } : {}),
              priority: Number(options.priority) as 1 | 2 | 3 | 4,
              ...((due) => (due ? { due } : {}))(todoDue(options)),
              ...(options.tag.length ? { tags: options.tag } : {}),
              visibility: options.visibility,
              ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            }),
        );
        output(
          io,
          global.json,
          result,
          `${result.deduplicated ? 'Found existing' : 'Created'} todo for ${result.record.event.assigneeDisplayName}\nTitle: ${result.record.current.title}\nID: ${result.record.event.id}`,
        );
      },
    );
  todoCommand
    .command('list')
    .option('--assignee <agent>')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .action(
      async (options: { assignee?: string; status?: string; limit: string }, command: Command) => {
        const global = globals(command);
        const page = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
          client.todos.list({
            ...(options.assignee ? { participantAgentId: options.assignee } : {}),
            ...(options.status ? { status: options.status } : {}),
            limit: Number(options.limit),
          }),
        );
        output(io, global.json, page, page.items.map(lineForItem).join('\n') || 'No todos found.');
      },
    );
  todoCommand.command('show <todo-id>').action(async (id: string, _options, command: Command) => {
    const global = globals(command);
    const record = await withClient(global.home, defaultActor(env, 'human', 'local-cli'), (client) =>
      client.todos.get(id),
    );
    output(
      io,
      global.json,
      record,
      `${record.current.title}\nID: ${record.event.id}\nStatus: ${record.status}\nVersion: ${record.current.version}`,
    );
  });
  todoCommand
    .command('update <todo-id>')
    .requiredOption('--as <actor-id>')
    .option('--actor-kind <kind>', 'agent or human', 'agent')
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
          as: string;
          actorKind: string;
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
        const parsedDue = todoDue(options);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.todos.update({
              todoId: id,
              expectedVersion: Number(options.expectedVersion),
              ...(options.title ? { title: options.title } : {}),
              ...(options.description !== undefined ? { description: options.description } : {}),
              ...(options.priority ? { priority: Number(options.priority) as 1 | 2 | 3 | 4 } : {}),
              ...(options.clearDue ? { due: null } : parsedDue ? { due: parsedDue } : {}),
              ...(options.visibility ? { visibility: options.visibility } : {}),
              ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
            }),
        );
        output(io, global.json, record, `Updated todo ${id} to version ${record.current.version}.`);
      },
    );
  for (const operation of ['accept', 'reject', 'complete', 'reopen', 'cancel'] as const) {
    todoCommand
      .command(`${operation} <todo-id>`)
      .requiredOption('--as <actor-id>')
      .option('--actor-kind <kind>', 'agent or human', 'agent')
      .option('--note <text>')
      .option('--reason <text>')
      .option('--idempotency-key <key>')
      .action(
        async (
          id: string,
          options: {
            as: string;
            actorKind: string;
            note?: string;
            reason?: string;
            idempotencyKey?: string;
          },
          command: Command,
        ) => {
          const global = globals(command);
          const record = await withClient(
            global.home,
            actor(options.actorKind, options.as),
            (client) =>
              operation === 'accept'
                ? client.todos.accept({
                    todoId: id,
                    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
                  })
                : operation === 'reject'
                  ? client.todos.reject({
                      todoId: id,
                      ...(options.reason ? { reason: options.reason } : {}),
                      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
                    })
                  : operation === 'complete'
                    ? client.todos.complete({
                        todoId: id,
                        ...(options.note ? { note: options.note } : {}),
                        ...(options.idempotencyKey
                          ? { idempotencyKey: options.idempotencyKey }
                          : {}),
                      })
                    : operation === 'cancel'
                      ? client.todos.cancel({
                          todoId: id,
                          ...(options.reason ? { reason: options.reason } : {}),
                          ...(options.idempotencyKey
                            ? { idempotencyKey: options.idempotencyKey }
                            : {}),
                        })
                      : client.todos.reopen({
                          todoId: id,
                          ...(options.idempotencyKey
                            ? { idempotencyKey: options.idempotencyKey }
                            : {}),
                        }),
          );
          output(io, global.json, record, `Todo ${id} is ${record.status}.`);
        },
      );
  }

  kudosCommand
    .command('show <kudos-id>')
    .description('Show one kudos item and its current state')
    .action(async (id: string, _options, command: Command) => {
      const global = globals(command);
      const record = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.kudos.get(id),
      );
      output(io, global.json, record, showRecord(record));
    });

  kudosCommand
    .command('acknowledge <kudos-id>')
    .description('Record that a recipient reviewed kudos')
    .requiredOption('--as <agent-id>', 'recipient agent identity')
    .option('--actor-kind <kind>', 'agent, human, or system', 'agent')
    .option('--name <display-name>')
    .option('--note <text>')
    .action(
      async (
        id: string,
        options: { as: string; actorKind: string; name?: string; note?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as, options.name),
          (client) =>
            client.kudos.acknowledge({
              kudosId: id,
              ...(options.note ? { note: options.note } : {}),
            }),
        );
        output(io, global.json, record, `Acknowledged ${id} as ${options.as}.`);
      },
    );

  kudosCommand
    .command('revoke <kudos-id>')
    .description('Record a revocation while preserving history')
    .requiredOption('--as <actor-id>')
    .option('--actor-kind <kind>', 'human, agent, or system', 'human')
    .requiredOption('--reason <reason>')
    .option('--administrative', 'mark as an administrative revocation', false)
    .action(
      async (
        id: string,
        options: { as: string; actorKind: string; reason: string; administrative: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.kudos.revoke({
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
    .description('Print the generated WINS.md path or content')
    .option('--open', 'open WINS.md in the system GUI', false)
    .option('--print', 'print Markdown content', false)
    .action(
      async (
        agentId: string | undefined,
        options: { open: boolean; print: boolean },
        command: Command,
      ) => {
        const global = globals(command);
        if (!agentId) throw new SynomemError('INVALID_INPUT', 'Specify an agent.');
        const details = await withClient(global.home, defaultActor(env, 'system', 'cli'), async (client) => {
          const profile = await client.agents.get(agentId);
          const info = await client.info();
          if (info.backend !== 'local') {
            throw new SynomemError(
              'INVALID_INPUT',
              'Generated WINS.md files are available only with the local backend.',
            );
          }
          const capabilities = await client.capabilities();
          const path = join(info.home, profile.id, 'WINS.md');
          if (!existsSync(path)) {
            const hint = capabilities.projections.writeWinsMarkdown
              ? 'Run `synomem rebuild` to generate it.'
              : 'Enable projection.writeWinsMarkdown and run `synomem rebuild`.';
            throw new SynomemError(
              'INVALID_INPUT',
              `No generated WINS.md exists for ${profile.id}. ${hint}`,
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
    const stats = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
      client.stats(listInput(options)),
    );
    output(
      io,
      global.json,
      stats,
      `Total: ${stats.total}\nActive: ${stats.active}\nAcknowledged: ${stats.acknowledged}\nRevoked: ${stats.revoked}`,
    );
  });

  program
    .command('rebuild')
    .description('Regenerate current-state and filesystem projections from canonical events')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const result = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.rebuild(),
      );
      output(
        io,
        global.json,
        result,
        `Rebuilt ${result.generated.length} file(s); removed ${result.removed.length} stale file(s).`,
      );
    });

  program
    .command('backup <destination>')
    .description('Create a transactionally consistent SQLite backup')
    .action(async (destination: string, _options, command: Command) => {
      const global = globals(command);
      const path = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) => {
        if (!client.backup) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Filesystem backup is available only with the local backend.',
          );
        }
        return client.backup(destination);
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
        const content = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
          client.export(options.format),
        );
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
      const result = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.doctor(),
      );
      const human = result.diagnostics
        .map((item) => `${item.level.toUpperCase().padEnd(7)} ${item.code}: ${item.message}`)
        .join('\n');
      output(io, global.json, result, human);
      if (!result.healthy) cliExitCodes.set(program, 5);
    });

  program
    .command('mcp')
    .description('Run the actor-bound MCP server over stdio')
    .requiredOption('--actor-id <id>')
    .requiredOption('--actor-kind <kind>', 'human, agent, or system')
    .option('--actor-name <display-name>')
    .action(
      async (
        options: { actorId: string; actorKind: string; actorName?: string },
        command: Command,
      ) => {
        const global = globals(command);
        await startMcpServer({
          ...(global.home ? { home: global.home } : {}),
          actor: actor(options.actorKind, options.actorId, options.actorName),
        });
      },
    );

  return program;
}

export async function runCli(
  argv = process.argv,
  io: CliIo = defaultIo,
  serviceFactory: SynomemServiceFactory = configuredServiceFactory,
  dependencies: CliDependencies = {},
): Promise<number> {
  const program = createCli(io, serviceFactory, dependencies);
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
    const kudosError = asSynomemError(error);
    const json = argv.includes('--json');
    io.stderr(
      json
        ? `${JSON.stringify({ ok: false, error: { code: kudosError.code, message: kudosError.message } })}\n`
        : `Error [${kudosError.code}]: ${kudosError.message}\n`,
    );
    return exitCode(kudosError.code);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  process.exitCode = await runCli();
}
