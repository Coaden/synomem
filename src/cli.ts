#!/usr/bin/env node
import { existsSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Command, CommanderError, Option } from 'commander';
import { configuredServiceFactory, readSynomemConfig, writeSynomemBackend } from './backend.js';
import { cloudApiUrl } from './cloud.js';
import { resolveHome } from './config.js';
import {
  assertInteractive,
  confirmPlan,
  credentialFingerprint,
  credentialStoreChoices,
  environmentInstructions,
  readAccessToken,
  runConfigWizard,
  writeCredentialFile,
  type AuthChoice,
  type BackendChoice,
  type ConfigPlan,
  type CredentialStoreChoice,
} from './configure.js';
import { discoverBoundWorkspace, discoverOrganizations, workspaceChoices } from './discover.js';
import { DEFAULT_WORKSPACE, listLocalWorkspaces, localWorkspaceHome } from './workspaces.js';
import { defaultPromptIo, type PromptIo } from './prompt.js';
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
  AgentRuntimeBinding,
  EvidenceReference,
  KudosListInput,
  KudosRecord,
  KudosSummary,
  ItemListInput,
  ItemSummary,
  TaskDue,
} from './types.js';
import { packageVersion } from './version.js';
import type { SynomemService, SynomemServiceFactory } from './service.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDependencies {
  /** Injected so the wizard can be driven by a test without a terminal. */
  promptIo?: PromptIo;
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
  /*
   * Injected so setup can be tested without a network. The default asks the
   * service which workspace an access key is bound to.
   */
  discoverBoundWorkspace?: (options: {
    baseUrl: string;
    accessToken: string;
  }) => Promise<{ workspaceId: string }>;
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
  /** `--actor`, which outranks the environment: it is said on this invocation. */
  override?: string,
): ActorIdentity {
  const id = override?.trim() || env.SYNOMEM_ACTOR_ID?.trim();
  if (!id) return actor(fallbackKind, fallbackId);
  const kind = override?.trim()
    ? // An explicit --actor names an agent unless told otherwise; the historical
      // fallbacks here are `system`/`cli`, which is not what somebody means when
      // they name one.
      env.SYNOMEM_ACTOR_KIND?.trim() || 'agent'
    : env.SYNOMEM_ACTOR_KIND?.trim() || fallbackKind;
  return actor(kind, id, env.SYNOMEM_ACTOR_NAME?.trim());
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

/**
 * The resolved global options for a command.
 *
 * `--workspace` is turned into a home HERE, before any service exists, which is
 * the whole reason it costs nothing downstream: a local workspace is a separate
 * database in its own home, and choosing one is choosing a home. Nothing in the
 * domain, the commands, or the MCP tools learns that a workspace was selected.
 *
 * On a remote backend the name means a hosted workspace instead, which
 * `backend use remote --workspace` already handles; passing both here would be
 * two different answers to the same question, so it is refused.
 */
function globals(command: Command): {
  home?: string;
  json: boolean;
  actor?: string;
  workspace?: string;
} {
  const options = command.optsWithGlobals<{
    home?: string;
    json: boolean;
    workspace?: string;
    actor?: string;
  }>();
  if (!options.workspace) return options;
  /*
   * One flag, one meaning — "which workspace" — resolved differently by the
   * handful of commands that CONFIGURE a backend rather than act inside one.
   * For those, the value is a hosted workspace ID to be written to the config,
   * so it is passed through raw and they read `workspace`. Everywhere else it
   * names a local workspace, which is a home.
   *
   * These commands used to declare their own `--workspace`, which does not
   * work: Commander gives a duplicated long flag to the parent, so the
   * subcommand never received it at all.
   */
  if (CONFIGURES_BACKEND.has(commandPath(command))) return options;
  return { ...options, home: localWorkspaceHome(options.workspace, options.home) };
}

/** `parent child`, so a subcommand name cannot be confused with another's. */
function commandPath(command: Command): string {
  const parent = command.parent?.name();
  return parent && parent !== 'synomem' ? `${parent} ${command.name()}` : command.name();
}

/**
 * Commands where `--workspace` names a HOSTED workspace being configured,
 * rather than a local one to act in.
 */
const CONFIGURES_BACKEND = new Set(['config init', 'backend use', 'remote import']);

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

/**
 * The value `--actor` should supply to commands that name an actor.
 *
 * Read from argv directly, before the commands are built, because Commander
 * evaluates option defaults at DECLARATION time: a `--as` declared without one
 * is required, and a `--as` declared with one is already satisfied. Supplying
 * it here is a single change point instead of a fallback threaded through
 * twenty action bodies, and `--as` still wins when both are given because an
 * explicitly passed option overrides its default.
 */
function actorDefault(argv: string[], env: NodeJS.ProcessEnv): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === '--actor') return argv[index + 1]?.trim() || undefined;
    if (argument.startsWith('--actor='))
      return argument.slice('--actor='.length).trim() || undefined;
  }
  return env.SYNOMEM_ACTOR_ID?.trim() || undefined;
}

export function createCli(
  io: CliIo = defaultIo,
  serviceFactory: SynomemServiceFactory = configuredServiceFactory,
  dependencies: CliDependencies = {},
  argv: string[] = process.argv,
): Command {
  const env = dependencies.env ?? process.env;
  const actingDefault = actorDefault(argv, env);
  const credentialStore = dependencies.credentialStore ?? new OsCredentialStore();
  const oauthLogin = dependencies.oauthLogin ?? loginWithOAuth;
  const discoverWorkspace = dependencies.discoverBoundWorkspace ?? discoverBoundWorkspace;
  const promptIo = dependencies.promptIo ?? defaultPromptIo();
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
    .option('--home <path>', 'storage root (defaults to SYNOMEM_HOME or ~/.synomem)')
    // A local workspace is its own database under the root, so this selects a
    // home. On a remote backend the hosted workspace is chosen by
    // `backend use remote --workspace` instead.
    .option('--workspace <name>', 'local workspace to act in (see `synomem workspace list`)')
    .option('--actor <id>', 'act as this agent (overrides SYNOMEM_ACTOR_ID)')
    .option('--json', 'emit stable machine-readable JSON', false)
    .showSuggestionAfterError()
    .configureOutput({ writeOut: io.stdout, writeErr: io.stderr });

  /*
   * Local workspaces.
   *
   * Each is a separate database in its own home, which is what makes the
   * isolation real: SQLite has no row-level security, so a shared file would
   * rest on every query remembering to filter, with nothing to catch a miss.
   * Separate files mean cross-workspace leakage is not something anybody can
   * write by accident.
   */
  const workspaceCommand = program
    .command('workspace')
    .description('Work in a separate local store, isolated from the others');

  workspaceCommand
    .command('list')
    .description('List the local workspaces on this machine')
    .action((_options, command: Command) => {
      const global = globals(command);
      // Read from disk, so nothing is listed that does not exist.
      const workspaces = listLocalWorkspaces(global.home);
      const human = workspaces
        .map(
          (workspace) =>
            `${workspace.name === DEFAULT_WORKSPACE ? '*' : ' '} ${workspace.name.padEnd(24)} ${
              workspace.initialized ? workspace.home : `${workspace.home} (not initialized)`
            }`,
        )
        .join('\n');
      output(
        io,
        global.json,
        { workspaces },
        `${human}\n\nAct in one with --workspace <name>. A local workspace is a separate store on this machine; a hosted workspace is shared, and is selected with \`backend use remote --workspace\`.`,
      );
    });

  workspaceCommand
    .command('create <name>')
    .description('Create a local workspace and initialize its store')
    .action(async (name: string, _options, command: Command) => {
      const global = globals(command);
      const home = localWorkspaceHome(name, global.home);
      if (readSynomemConfig(home)) {
        throw new SynomemError('INVALID_INPUT', `Workspace already exists: ${name}`);
      }
      writeSynomemBackend({ kind: 'local' }, home);
      // Opening it once creates the database, so `list` does not report a
      // workspace that exists in name only.
      await withClient(home, defaultActor(env, 'system', 'cli'), async () => undefined);
      output(
        io,
        global.json,
        { name, home },
        `Created workspace ${name} at ${home}.\nAct in it with --workspace ${name}.`,
      );
    });

  const remoteCommand = program.command('remote').description('Administer a remote workspace');

  /*
   * The browser counterpart to an access key naming its own workspace.
   *
   * A signed-in account may reach several organizations, each with several
   * workspaces, so there is a genuine choice to make -- and no way to make it
   * without seeing the list. Printing the IDs alongside the names is the point:
   * the ID is what `backend use remote --workspace` takes.
   */
  remoteCommand
    .command('workspaces')
    .description('List the organizations and workspaces this credential can reach')
    .option('--url <url>', 'internal: alternate HTTPS origin')
    .action(async (options: { url?: string }, command: Command) => {
      const global = globals(command);
      const config = readSynomemConfig(global.home, env);
      const baseUrl =
        options.url ??
        (config?.backend.kind === 'remote' ? config.backend.baseUrl : cloudApiUrl(env));
      const accessToken = env.SYNOMEM_ACCESS_TOKEN;
      if (!accessToken) {
        throw new SynomemError(
          'AUTH_REQUIRED',
          'Set SYNOMEM_ACCESS_TOKEN, or run `synomem auth login` first.',
        );
      }
      const organizations = await discoverOrganizations({ baseUrl, accessToken });
      const choices = workspaceChoices(organizations);
      const human = organizations.length
        ? organizations
            .map((organization) =>
              [
                `${organization.displayName} (${organization.slug}) — ${organization.role}`,
                ...(organization.workspaces.length
                  ? organization.workspaces.map(
                      (workspace) => `  ${workspace.id}  ${workspace.displayName}`,
                    )
                  : ['  (no workspaces yet)']),
              ].join('\n'),
            )
            .join('\n')
        : 'This account belongs to no organizations yet.';
      output(io, global.json, { organizations, choices }, human);
    });

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

  /*
   * `synomem config` is the canonical entry point. `configure` and `setup` are
   * accepted because people reach for them, and a setup program that rejects
   * the word somebody guessed is needlessly unhelpful.
   */
  const configCommand = program
    .command('config')
    .aliases(['configure', 'setup'])
    .description('Set up Synomem, interactively or deterministically');

  const applyPlan = async (
    plan: ConfigPlan,
    token: string | undefined,
    global: { home?: string; json: boolean },
  ): Promise<void> => {
    const home = plan.home;
    const serviceUrl = plan.serviceUrl ?? cloudApiUrl(env);

    /*
     * The workspace is discovered, not typed.
     *
     * An installation access key is bound to exactly one workspace, so the
     * service can be asked which one rather than the person. An explicit
     * --workspace still wins, because automation should not depend on a
     * network round trip to configure a machine.
     */
    let workspaceId = plan.workspaceId;
    if (plan.backend === 'remote' && !workspaceId && token) {
      const bound = await discoverWorkspace({ baseUrl: serviceUrl, accessToken: token });
      workspaceId = bound.workspaceId;
      io.stdout(`Access key is bound to workspace ${workspaceId}.\n`);
    }
    if (plan.backend === 'remote' && !workspaceId) {
      /*
       * Signing in through a browser needs an actor identity and a client ID,
       * which is `synomem auth login`'s job. Rather than write a remote
       * backend with no workspace -- a configuration that fails on its first
       * real use -- say exactly what remains.
       */
      output(
        io,
        global.json,
        { applied: false, pending: 'sign-in', home, serviceUrl },
        [
          '',
          'Nothing was configured yet: signing in through a browser is a separate step.',
          '',
          'Run, with the actor this machine acts as:',
          '',
          '  synomem auth login --actor-id <agent> --client-id <client>',
          '',
          'Then select the workspace it reports:',
          '',
          '  synomem backend use remote --workspace <workspace-id>',
        ].join('\n'),
      );
      return;
    }

    const config = writeSynomemBackend(
      plan.backend === 'local'
        ? { kind: 'local' }
        : { kind: 'remote', baseUrl: serviceUrl, workspaceId: workspaceId! },
      home,
    );

    let credentialLocation: string | undefined;
    if (token) {
      if (plan.credentialStore === 'environment') {
        io.stdout(`${environmentInstructions(token)}\n`);
        credentialLocation = 'environment';
      } else if (plan.credentialStore === 'file') {
        credentialLocation = writeCredentialFile(home, token);
      } else {
        // The platform store is the default, and a failure falls back to the
        // restricted file rather than leaving the credential nowhere.
        try {
          await credentialStore.set(`synomem:${workspaceId}`, {
            kind: 'installation-key',
            accessToken: token,
          });
          credentialLocation = 'platform credential store';
        } catch {
          credentialLocation = writeCredentialFile(home, token);
        }
      }
    }

    // Diagnostics run before success is claimed: a configuration that cannot
    // open its own database is not a finished setup.
    const diagnostics = await withClient(home, defaultActor(env, 'system', 'cli'), (client) =>
      client.doctor(),
    );

    output(
      io,
      global.json,
      {
        backend: config.backend,
        home,
        ...(credentialLocation ? { credentialSource: credentialLocation } : {}),
        ...(token ? { credential: credentialFingerprint(token) } : {}),
        healthy: diagnostics.healthy,
      },
      [
        '',
        'Synomem is ready.',
        '',
        `  Backend:  ${config.backend.kind === 'local' ? 'Local SQLite' : 'Synomem Cloud'}`,
        `  Home:     ${home}`,
        ...(config.backend.kind === 'remote'
          ? [`  Service:  ${config.backend.baseUrl}`, `  Workspace: ${config.backend.workspaceId}`]
          : []),
        ...(credentialLocation ? [`  Credential: ${credentialLocation}`] : []),
        `  Database: ${diagnostics.healthy ? 'Healthy' : 'Needs attention — run synomem doctor'}`,
      ].join('\n'),
    );
  };

  configCommand.action(async (_options, command: Command) => {
    const global = globals(command);
    assertInteractive(promptIo);
    const plan = await runConfigWizard(promptIo, {
      ...(global.home ? { home: global.home } : {}),
      env,
    });
    const token = plan.auth === 'access-key' ? await readAccessToken(promptIo) : undefined;
    if (!(await confirmPlan(promptIo, plan))) {
      output(io, global.json, { applied: false }, 'Nothing was changed.');
      return;
    }
    await applyPlan(plan, token, global);
  });

  configCommand
    .command('init')
    .description('Configure Synomem without prompting')
    .option('--backend <kind>', 'local or remote')
    .option('--auth <method>', 'browser or access-key')
    .option('--credential-store <where>', 'auto, keychain, file, or environment', 'auto')
    // The token is read from stdin, never taken as an argument: an argument is
    // kept by the shell history and visible in the process list.
    .option('--access-token-stdin', 'read the installation access key from stdin', false)
    .option('--yes', 'apply without confirming', false)
    .action(
      async (
        options: {
          backend?: string;
          auth?: string;
          credentialStore: string;
          accessTokenStdin: boolean;
          yes: boolean;
        },
        command: Command,
      ) => {
        const global = globals(command);
        if (options.backend !== 'local' && options.backend !== 'remote') {
          throw new SynomemError('INVALID_INPUT', 'Pass --backend local or --backend remote.');
        }
        const backend: BackendChoice = options.backend;
        // An access key names its own workspace, so --workspace is only
        // required when there is no key to ask.
        if (backend === 'remote' && !global.workspace && !options.accessTokenStdin) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Remote setup requires --workspace, or --access-token-stdin so the key can name its own.',
          );
        }
        const token = options.accessTokenStdin ? await readAccessToken(promptIo) : undefined;
        if (backend === 'remote' && options.auth === 'access-key' && !token) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Access-key setup requires --access-token-stdin so the key is not passed as an argument.',
          );
        }
        const plan: ConfigPlan = {
          backend,
          home: resolveHome(global.home),
          ...(backend === 'remote'
            ? {
                serviceUrl: cloudApiUrl(env),
                auth: (options.auth as AuthChoice | undefined) ?? 'access-key',
                workspaceId: global.workspace,
                credentialStore: options.credentialStore as CredentialStoreChoice,
              }
            : {}),
        };
        if (!options.yes) {
          throw new SynomemError('INVALID_INPUT', 'Re-run with --yes to apply this configuration.');
        }
        await applyPlan(plan, token, global);
      },
    );

  configCommand
    .command('show')
    .description('Show the current configuration without revealing secrets')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const home = resolveHome(global.home);
      const config = readSynomemConfig(global.home, env);
      const backend = config?.backend ?? { kind: 'local' as const };
      const credentialSource = env.SYNOMEM_ACCESS_TOKEN
        ? 'environment (SYNOMEM_ACCESS_TOKEN)'
        : existsSync(join(home, 'credentials', 'installation.json'))
          ? 'restricted file'
          : 'platform credential store or none';
      output(
        io,
        global.json,
        // Never the secret itself, only where it comes from.
        { backend, home, credentialSource, stores: credentialStoreChoices().map((c) => c.value) },
        [
          `Backend:    ${backend.kind === 'local' ? 'Local SQLite' : 'Synomem Cloud'}`,
          `Home:       ${home}`,
          ...(backend.kind === 'remote'
            ? [`Service:    ${backend.baseUrl}`, `Workspace:  ${backend.workspaceId}`]
            : []),
          `Credential: ${credentialSource}`,
        ].join('\n'),
      );
    });

  program
    .command('reset')
    .description('Remove Synomem configuration, database and credentials')
    // Integrations are opt-in because they live in other tools' directories.
    // Removing somebody's harness configuration as a side effect of resetting
    // Synomem would be a surprise with no undo.
    .option('--integrations', 'also remove installed skills and MCP registrations', false)
    .option('--yes', 'apply the displayed plan', false)
    .action(async (options: { integrations: boolean; yes: boolean }, command: Command) => {
      const global = globals(command);
      const home = resolveHome(global.home);

      /*
       * Every target is an exact path, listed before anything is touched. No
       * recursive delete is ever derived from a variable that might be empty:
       * a reset that computes `rm -rf $HOME/` from an unset home is the
       * failure this shape exists to make impossible.
       */
      const targets = [
        join(home, 'config.json'),
        join(home, 'synomem.sqlite3'),
        join(home, 'synomem.sqlite3-wal'),
        join(home, 'synomem.sqlite3-shm'),
        join(home, 'credentials', 'installation.json'),
      ].filter((path) => existsSync(path));

      const skillPlan = options.integrations ? uninstallSkill({ apply: false }) : undefined;
      const skillTargets =
        skillPlan?.locations
          // Installed Synomem-owned copies only; an unowned directory at
          // the same path is not ours to remove.
          .filter((location) => location.state === 'current' || location.state === 'stale')
          .map((location) => location.target) ?? [];

      if (!options.yes) {
        output(
          io,
          global.json,
          { targets, skillTargets, applied: false },
          [
            'This will remove:',
            ...(targets.length ? targets.map((path) => `  ${path}`) : ['  (nothing found)']),
            ...(skillTargets.length ? ['', 'And these Synomem-owned skills:'] : []),
            ...skillTargets.map((path) => `  ${path}`),
            '',
            ...(options.integrations
              ? []
              : ['Installed skills and MCP registrations are left alone.', '']),
            'Run with --yes to continue.',
          ].join('\n'),
        );
        return;
      }

      const removed: string[] = [];
      for (const path of targets) {
        rmSync(path, { force: true });
        removed.push(path);
      }
      // Only ownership-stamped Synomem skills are removed, which uninstall
      // already enforces — an unowned directory at the same path is left.
      const skillResult = options.integrations ? uninstallSkill({ apply: true }) : undefined;

      output(
        io,
        global.json,
        { removed, skills: skillResult?.locations ?? [] },
        [
          `Removed ${removed.length} file(s).`,
          ...(skillResult
            ? [`Skill locations processed: ${skillResult.locations.length}.`]
            : ['Installed skills and MCP registrations were left alone.']),
        ].join('\n'),
      );
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
    // --url is for development and private deployments. It stays out of the
    // README, the public docs and the packaged skill: public onboarding must
    // never ask for a service address, because a person has no way to tell a
    // real one from a phished one.
    .option('--url <url>', 'internal: alternate HTTPS origin')
    .action((kind: string, options: { url?: string }, command: Command) => {
      const global = globals(command);
      if (kind !== 'local' && kind !== 'remote') {
        throw new SynomemError('INVALID_INPUT', 'Backend kind must be local or remote.');
      }
      if (kind === 'remote' && !global.workspace) {
        throw new SynomemError('INVALID_INPUT', 'Remote backend selection requires --workspace.');
      }
      const config = writeSynomemBackend(
        kind === 'local'
          ? { kind: 'local' }
          : {
              kind: 'remote',
              baseUrl: options.url ?? cloudApiUrl(env),
              workspaceId: global.workspace!,
            },
        global.home,
      );
      output(
        io,
        global.json,
        { backend: config.backend },
        `Selected ${config.backend.kind} Synomem backend.`,
      );
    });

  /*
   * `show` reads the config file; `status` proves the selection actually works.
   *
   * The two are deliberately separate. A person debugging a broken setup needs
   * to know what is configured even when nothing can be reached, and a person
   * checking that a setup is live needs a connection to have been made. One
   * command doing both would make a printed workspace ID look like a reachable
   * workspace.
   */
  backendCommand
    .command('status')
    .description('Connect to the selected backend and report what answered')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const config = readSynomemConfig(global.home);
      if (!config) {
        throw new SynomemError(
          'CONFIG_INVALID',
          'No Synomem home here yet. Run `synomem config init` first.',
        );
      }
      const result = await withClient(
        global.home,
        defaultActor(env, 'system', 'cli'),
        async (client) => ({
          info: await client.info(),
          capabilities: await client.capabilities(),
          diagnostics: (await client.doctor()).diagnostics.filter(
            (item) => item.level === 'error' || item.level === 'warning',
          ),
        }),
      );
      const { info, capabilities, diagnostics } = result;
      const where =
        info.backend === 'local'
          ? `Home: ${info.home}\nDatabase: ${info.databasePath}`
          : `URL: ${info.baseUrl}`;
      const problems = diagnostics.length
        ? diagnostics
            .map((item) => `${item.level.toUpperCase()} ${item.code}: ${item.message}`)
            .join('\n')
        : 'No warnings or errors.';
      const human = [
        `Backend: ${info.backend} (reachable)`,
        where,
        `Workspace: ${capabilities.binding.workspaceId}`,
        `Acting as: ${capabilities.binding.actor.kind} ${capabilities.binding.actor.id}`,
        problems,
      ].join('\n');
      output(io, global.json, { reachable: true, info, capabilities, diagnostics }, human);
      if (diagnostics.some((item) => item.level === 'error')) cliExitCodes.set(program, 5);
    });

  const projectionCommand = program
    .command('projection')
    .description('Inspect the generated files Synomem derives from events');
  projectionCommand
    .command('status')
    .description('Report whether the generated files match the canonical events')
    .action(async (_options, command: Command) => {
      const global = globals(command);
      const status = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) => {
        if (!client.projectionStatus) {
          throw new SynomemError(
            'INVALID_INPUT',
            'The remote backend keeps no filesystem projections, so there is nothing to report.',
          );
        }
        return client.projectionStatus();
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
    .command('create <handle>')
    .description('Create an agent. The canonical ID is generated, not chosen.')
    .requiredOption('--name <display-name>', 'display name')
    .option('--alias <name>', 'alias (repeatable)', collect, [])
    .option('--description <text>')
    .action(
      async (
        handle: string,
        options: { name: string; alias: string[]; description?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const profile = await withClient(
          global.home,
          defaultActor(env, 'system', 'cli'),
          (client) =>
            client.agents.create({
              handle,
              displayName: options.name,
              ...(options.alias.length ? { aliases: options.alias } : {}),
              ...(options.description ? { description: options.description } : {}),
            }),
        );
        // Both are printed because both matter: the handle is what people type,
        // the ID is what every event records and what MCP registration uses.
        output(
          io,
          global.json,
          profile,
          `Created ${profile.displayName}\n\nHandle:   ${profile.handle}\nAgent ID: ${profile.id}`,
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
      const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.addAliases(agent, aliases),
      );
      output(io, global.json, profile, `Aliases: ${(profile.aliases ?? []).join(', ') || 'none'}`);
    });

  aliasCommand
    .command('remove <agent> <alias...>')
    .description('Remove aliases, keeping the rest')
    .action(async (agent: string, aliases: string[], _options, command: Command) => {
      const global = globals(command);
      const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.removeAliases(agent, aliases),
      );
      output(io, global.json, profile, `Aliases: ${(profile.aliases ?? []).join(', ') || 'none'}`);
    });

  agentCommand
    .command('rename <agent> <handle>')
    .description('Change an agent handle. Its canonical ID never changes.')
    .action(async (agent: string, handle: string, _options, command: Command) => {
      const global = globals(command);
      const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.update(agent, { handle }),
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
      const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.archive(agent),
      );
      output(io, global.json, profile, `Archived ${profile.handle} (${profile.id})`);
    });

  agentCommand
    .command('restore <agent>')
    .description('Let an archived agent act again')
    .action(async (agent: string, _options, command: Command) => {
      const global = globals(command);
      const profile = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.restore(agent),
      );
      output(io, global.json, profile, `Restored ${profile.handle} (${profile.id})`);
    });

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
    .option('--agent <id-or-alias>', 'bind this installation to an agent')
    .action(
      async (
        options: {
          runtime: string[];
          yes: boolean;
          force: boolean;
          link: boolean;
          agent?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const runtimes = skillRuntimes(options.runtime);

        /*
         * The agent is resolved BEFORE anything is written. An ambiguous or
         * unknown name then stops the command with a name to fix, rather than
         * leaving a skill installed and pointed at an agent that does not
         * exist.
         */
        let agentId: string | undefined;
        if (options.agent) {
          agentId = await withClient(
            global.home,
            defaultActor(env, 'system', 'cli'),
            async (client) => {
              const resolution = await client.agents.resolve(options.agent!);
              if (!resolution.match) {
                throw new SynomemError(
                  'AGENT_NOT_FOUND',
                  resolution.candidates.length
                    ? `"${options.agent}" matches ${resolution.candidates.length} agents: ${resolution.candidates
                        .map((candidate) => candidate.id)
                        .join(', ')}. Name one of them.`
                    : `Unknown agent: ${options.agent}`,
                );
              }
              return resolution.match.id;
            },
          );
        }

        const result = installSkill({
          ...(runtimes ? { runtimes } : {}),
          apply: options.yes,
          force: options.force,
          link: options.link,
          ...(agentId ? { agentId } : {}),
        });

        // Bindings follow what was actually installed, and only on a real run:
        // a dry run must not claim a binding it did not make, and a runtime
        // whose harness is not present here is not somewhere this agent runs.
        if (agentId && options.yes) {
          const installed = result.locations
            .filter((location) => location.state !== 'unavailable')
            .map((location) => location.runtime);
          if (installed.length) {
            await withClient(global.home, defaultActor(env, 'system', 'cli'), async (client) => {
              for (const runtime of installed) {
                await client.agents.bindRuntime({ agentId, runtime });
              }
            });
          }
        }

        output(io, global.json, result, formatSkillResult(result, 'install'));
      },
    );

  skillCommand
    .command('status')
    .description('Show installed, stale, missing, or conflicting skill copies')
    .option('--runtime <runtime>', `${skillRuntimeHelp} (repeatable)`, collect, [])
    .option('--agent <id>', 'print the registration command for this agent')
    .action((options: { runtime: string[]; agent?: string }, command: Command) => {
      const global = globals(command);
      const result = skillStatus({
        runtimes: skillRuntimes(options.runtime),
        ...(options.agent ? { agentId: options.agent } : {}),
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
                // Handle first: it is what people type. The canonical ID
                // follows because MCP registration needs it.
                `${profile.handle}  ${profile.displayName}${
                  profile.status === 'archived' ? '  [archived]' : ''
                }${profile.aliases?.length ? `  aliases: ${profile.aliases.join(', ')}` : ''}\n  ${profile.id}`,
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
        const profile = await withClient(
          global.home,
          defaultActor(env, 'system', 'cli'),
          (client) =>
            client.agents.update(id, {
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
      const resolution = await withClient(
        global.home,
        defaultActor(env, 'system', 'cli'),
        (client) => client.agents.resolve(name),
      );
      // An ambiguous name is a question, not a failure: exit zero and show the
      // candidates so the caller can pick one.
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
      const entries = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.directory(),
      );
      const human = entries.length
        ? entries
            .map((entry) => {
              const runtimes = entry.runtimeBindings.length
                ? entry.runtimeBindings
                    .map(
                      (binding) =>
                        `    ${binding.runtime}${binding.profile ? `/${binding.profile}` : ''}` +
                        // Last-seen is advisory, so it is labelled as an
                        // observation rather than a status.
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
    .option('--profile <name>', 'named configuration within the runtime')
    .option('--installation <id>', 'hosted installation this binding belongs to')
    .action(
      async (
        agent: string,
        options: { runtime: string; profile?: string; installation?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const binding = await withClient(
          global.home,
          defaultActor(env, 'system', 'cli'),
          (client) =>
            client.agents.bindRuntime({
              agentId: agent,
              runtime: options.runtime,
              ...(options.profile ? { profile: options.profile } : {}),
              ...(options.installation ? { installationId: options.installation } : {}),
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

  /*
   * With no agent named this answers the question people actually arrive with:
   * "where is any of my stuff running?". Naming an agent narrows it. Requiring
   * the agent, as this once did, means you must already know the answer to the
   * question you came to ask.
   */
  runtimeCommand
    .command('list [agent]')
    .description('List runtime bindings for one agent, or for every agent')
    .action(async (agent: string | undefined, _options, command: Command) => {
      const global = globals(command);
      const result = await withClient(
        global.home,
        defaultActor(env, 'system', 'cli'),
        async (client) => {
          if (agent) {
            const profile = await client.agents.get(agent);
            return [{ profile, runtimeBindings: await client.agents.bindings(agent) }];
          }
          return (await client.agents.directory()).filter(
            (entry) => entry.runtimeBindings.length > 0,
          );
        },
      );
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
      const removed = await withClient(global.home, defaultActor(env, 'system', 'cli'), (client) =>
        client.agents.unbindRuntime(bindingId),
      );
      output(
        io,
        global.json,
        { removed },
        removed ? `Removed binding ${bindingId}.` : `No binding ${bindingId}.`,
      );
    });

  const postCommand = program.command('post').description('Publish to everyone in the workspace');

  postCommand
    .command('create')
    .description('Publish a post the whole workspace can read')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .requiredOption('--title <title>')
    .requiredOption('--body <body>')
    .option('--tag <tag>', 'repeatable', collect, [])
    .option('--reply-to <post-id>')
    .action(
      async (
        options: {
          as: string;
          actorKind: string;
          title: string;
          body: string;
          tag: string[];
          replyTo?: string;
        },
        command: Command,
      ) => {
        const global = globals(command);
        const result = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.posts.create({
              title: options.title,
              body: options.body,
              ...(options.tag.length ? { tags: options.tag } : {}),
              ...(options.replyTo ? { replyTo: options.replyTo } : {}),
            }),
        );
        output(io, global.json, result, `Published ${result.record.event.id}`);
      },
    );

  postCommand
    .command('list')
    .description('List posts in this workspace')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .option('--limit <n>', 'default 10, maximum 50')
    .action(
      async (options: { as: string; actorKind: string; limit?: string }, command: Command) => {
        const global = globals(command);
        const page = await withClient(global.home, actor(options.actorKind, options.as), (client) =>
          client.posts.list(options.limit ? { limit: Number(options.limit) } : {}),
        );
        const human = page.items.length
          ? page.items.map((item) => `${item.id}  ${item.title}`).join('\n')
          : 'No posts yet.';
        output(io, global.json, page, human);
      },
    );

  postCommand
    .command('show <post-id>')
    .description('Show one post with its acknowledgements')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .action(
      async (postId: string, options: { as: string; actorKind: string }, command: Command) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) => client.posts.get(postId),
        );
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
      },
    );

  postCommand
    .command('acknowledge <post-id>')
    .description('Say you have seen a post')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .option('--note <text>', 'optional context for the author')
    .action(
      async (
        postId: string,
        options: { as: string; actorKind: string; note?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.posts.acknowledge({
              postId,
              ...(options.note ? { note: options.note } : {}),
            }),
        );
        output(io, global.json, record, `Acknowledged ${postId}`);
      },
    );

  postCommand
    .command('roster <post-id>')
    .description('Who has acknowledged a post, and who has not')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .action(
      async (postId: string, options: { as: string; actorKind: string }, command: Command) => {
        const global = globals(command);
        const roster = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) => client.posts.roster(postId),
        );
        // "Outstanding" means no acknowledgement recorded — never that somebody
        // has not read it, which this cannot know.
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
      },
    );

  postCommand
    .command('archive <post-id>')
    .description('Archive a post you wrote')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .option('--reason <text>')
    .action(
      async (
        postId: string,
        options: { as: string; actorKind: string; reason?: string },
        command: Command,
      ) => {
        const global = globals(command);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.posts.archive({ postId, ...(options.reason ? { reason: options.reason } : {}) }),
        );
        output(io, global.json, record, `Archived ${postId}`);
      },
    );

  const kudosCommand = program.command('kudos').description('Give and manage agent recognition');

  kudosCommand
    .command('give <recipient>')
    .description('Give specific, evidence-based kudos to an agent')
    .requiredOption(
      '--from <actor-id>',
      'stable ID of the giver (defaults to --actor)',
      actingDefault,
    )
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
    .description('Show pending kudos, memos, and tasks for an agent')
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
      const page = await withClient(
        global.home,
        defaultActor(env, 'human', 'local-cli'),
        (client) => client.kudos.list(listInput(options)),
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
    .option('--kind <kind>', 'kudos, memo, note, or task (repeatable)', collect, [])
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
      const page = await withClient(
        global.home,
        defaultActor(env, 'human', 'local-cli'),
        (client) => client.items.list(itemListInput(options)),
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
        const page = await withClient(
          global.home,
          defaultActor(env, 'human', 'local-cli'),
          (client) =>
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
    .requiredOption('--from <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
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
        const page = await withClient(
          global.home,
          defaultActor(env, 'human', 'local-cli'),
          (client) =>
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
    const record = await withClient(
      global.home,
      defaultActor(env, 'human', 'local-cli'),
      (client) => client.memos.get(id),
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
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
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
        const page = await withClient(
          global.home,
          defaultActor(env, 'human', 'local-cli'),
          (client) =>
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
    const record = await withClient(
      global.home,
      defaultActor(env, 'human', 'local-cli'),
      (client) => client.notes.get(id),
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
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
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
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
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

  const todoCommand = program
    .command('todo')
    .description('Create and manage your own private reminders');
  todoCommand
    .command('create')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .requiredOption('--title <title>')
    .option('--details <text>', 'private working detail')
    .option('--priority <number>', '1 highest, 4 lowest', '3')
    .option('--due-date <date>')
    .option('--due-at <datetime>')
    .option('--time-zone <iana-zone>')
    .option('--tag <tag>', 'tag (repeatable)', collect, [])
    .option('--idempotency-key <key>')
    .action(
      async (
        options: {
          as: string;
          actorKind: string;
          title: string;
          details?: string;
          priority: string;
          dueDate?: string;
          dueAt?: string;
          timeZone?: string;
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
            client.todos.create({
              title: options.title,
              ...(options.details ? { details: options.details } : {}),
              priority: Number(options.priority) as 1 | 2 | 3 | 4,
              ...((due) => (due ? { due } : {}))(taskDue(options)),
              ...(options.tag.length ? { tags: options.tag } : {}),
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
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .action(
      async (
        options: { as: string; actorKind: string; status?: string; limit: string },
        command: Command,
      ) => {
        const global = globals(command);
        const page = await withClient(global.home, actor(options.actorKind, options.as), (client) =>
          client.todos.list({
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
      },
    );
  todoCommand
    .command('show <todo-id>')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
    .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
    .action(async (id: string, options: { as: string; actorKind: string }, command: Command) => {
      const global = globals(command);
      const record = await withClient(global.home, actor(options.actorKind, options.as), (client) =>
        client.todos.get(id),
      );
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
      .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
      .option('--actor-kind <kind>', 'human, agent, or system', 'agent')
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
              operation === 'complete'
                ? client.todos.complete({
                    todoId: id,
                    ...(options.note ? { note: options.note } : {}),
                    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
                  })
                : operation === 'cancel'
                  ? client.todos.cancel({
                      todoId: id,
                      ...(options.reason ? { reason: options.reason } : {}),
                      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
                    })
                  : operation === 'archive'
                    ? client.todos.archive({
                        todoId: id,
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
          output(io, global.json, record, `Todo ${id} is now ${record.status}.`);
        },
      );
  }

  const taskCommand = program.command('task').description('Create and manage agent tasks');
  taskCommand
    .command('create <assignee>')
    .requiredOption('--from <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
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
            client.tasks.create({
              assigneeAgentId: assignee,
              title: options.title,
              ...(options.description ? { description: options.description } : {}),
              priority: Number(options.priority) as 1 | 2 | 3 | 4,
              ...((due) => (due ? { due } : {}))(taskDue(options)),
              ...(options.tag.length ? { tags: options.tag } : {}),
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
    .option('--assignee <agent>')
    .option('--status <status>')
    .option('--limit <number>', 'maximum results', '10')
    .action(
      async (options: { assignee?: string; status?: string; limit: string }, command: Command) => {
        const global = globals(command);
        const page = await withClient(
          global.home,
          defaultActor(env, 'human', 'local-cli'),
          (client) =>
            client.tasks.list({
              ...(options.assignee ? { participantAgentId: options.assignee } : {}),
              ...(options.status ? { status: options.status } : {}),
              limit: Number(options.limit),
            }),
        );
        output(io, global.json, page, page.items.map(lineForItem).join('\n') || 'No tasks found.');
      },
    );
  taskCommand.command('show <task-id>').action(async (id: string, _options, command: Command) => {
    const global = globals(command);
    const record = await withClient(
      global.home,
      defaultActor(env, 'human', 'local-cli'),
      (client) => client.tasks.get(id),
    );
    output(
      io,
      global.json,
      record,
      `${record.current.title}\nID: ${record.event.id}\nStatus: ${record.status}\nVersion: ${record.current.version}`,
    );
  });
  taskCommand
    .command('update <task-id>')
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
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
        const parsedDue = taskDue(options);
        const record = await withClient(
          global.home,
          actor(options.actorKind, options.as),
          (client) =>
            client.tasks.update({
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
      .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
      .option('--actor-kind <kind>', 'agent or human', 'agent')
      .option('--note <text>')
      .option('--reason <text>')
      .option('--idempotency-key <key>');
    // Rejecting requires saying why; accepting may. Marked required at the
    // parser so the CLI refuses before touching the store.
    if (operation === 'reject') {
      command_.requiredOption('--response <text>', 'why the task is being refused');
    } else if (operation === 'accept') {
      command_.option('--response <text>', 'conditions, timing, or partial capability');
    }
    command_.action(
      async (
        id: string,
        options: {
          as: string;
          actorKind: string;
          note?: string;
          reason?: string;
          response?: string;
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
              ? client.tasks.accept({
                  taskId: id,
                  ...(options.response ? { response: options.response } : {}),
                  ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
                })
              : operation === 'reject'
                ? client.tasks.reject({
                    taskId: id,
                    response: options.response ?? options.reason ?? '',
                    ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
                  })
                : operation === 'complete'
                  ? client.tasks.complete({
                      taskId: id,
                      ...(options.note ? { note: options.note } : {}),
                      ...(options.idempotencyKey ? { idempotencyKey: options.idempotencyKey } : {}),
                    })
                  : operation === 'cancel'
                    ? client.tasks.cancel({
                        taskId: id,
                        ...(options.reason ? { reason: options.reason } : {}),
                        ...(options.idempotencyKey
                          ? { idempotencyKey: options.idempotencyKey }
                          : {}),
                      })
                    : client.tasks.reopen({
                        taskId: id,
                        ...(options.idempotencyKey
                          ? { idempotencyKey: options.idempotencyKey }
                          : {}),
                      }),
        );
        output(io, global.json, record, `Task ${id} is ${record.status}.`);
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
    .requiredOption('--as <actor-id>', 'actor to act as (defaults to --actor)', actingDefault)
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
        const details = await withClient(
          global.home,
          defaultActor(env, 'system', 'cli'),
          async (client) => {
            const profile = await client.agents.get(agentId);
            const info = await client.info();
            if (info.backend !== 'local') {
              throw new SynomemError(
                'INVALID_INPUT',
                'Generated WINS.md files are available only with the local backend.',
              );
            }
            const capabilities = await client.capabilities();
            // Projections are written under the handle, since they exist to be read.
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
          },
        );
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
        const content = await withClient(
          global.home,
          defaultActor(env, 'system', 'cli'),
          (client) => client.export(options.format),
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
    .option('--agent-id <id>', 'bound agent, whose identity is read from Synomem')
    .option('--actor-id <id>', 'bound non-agent actor ID')
    .option('--actor-kind <kind>', 'human or system')
    .option('--actor-name <display-name>', 'display name for a non-agent actor')
    .action(
      async (
        options: { agentId?: string; actorId?: string; actorKind?: string; actorName?: string },
        command: Command,
      ) => {
        const global = globals(command);
        // An agent's name comes from its profile, never from the command line:
        // the name is written into every event the session appends, and a
        // harness must not be able to sign another agent's name to work.
        const bound = options.agentId
          ? await withClient(global.home, defaultActor(env, 'system', 'cli'), async (client) => {
              const resolution = await client.agents.resolve(options.agentId!);
              if (!resolution.match) {
                throw new SynomemError(
                  'AGENT_NOT_FOUND',
                  resolution.candidates.length
                    ? `"${options.agentId}" matches ${resolution.candidates.length} agents: ${resolution.candidates
                        .map((candidate) => candidate.id)
                        .join(', ')}. Name one of them.`
                    : `Unknown agent: ${options.agentId}`,
                );
              }
              return actor('agent', resolution.match.id, resolution.match.displayName);
            })
          : undefined;
        if (!bound && !(options.actorId && options.actorKind)) {
          throw new SynomemError(
            'INVALID_INPUT',
            'Specify --agent-id, or --actor-id with --actor-kind for a non-agent actor.',
          );
        }
        await startMcpServer({
          ...(global.home ? { home: global.home } : {}),
          actor: bound ?? actor(options.actorKind!, options.actorId!, options.actorName),
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
  const program = createCli(io, serviceFactory, dependencies, argv);
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
