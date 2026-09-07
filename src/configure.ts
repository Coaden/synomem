/**
 * `synomem config` — the onboarding wizard, and its deterministic equivalent.
 *
 * Two rules shape this file. Every interactive step has a non-interactive
 * counterpart, so an agent can configure a machine without a terminal. And the
 * wizard refuses to run at all when nobody is there to answer: a setup program
 * that blocks forever on a pipe is worse than one that says which flags it
 * needs.
 */
import { chmodSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cloudApiUrl } from './cloud.js';
import { SynomemError } from './errors.js';
import { resolveHome } from './config.js';
import { ask, askSecret, confirm, select, type PromptIo } from './prompt.js';

export type BackendChoice = 'local' | 'remote';
export type AuthChoice = 'browser' | 'access-key';
export type CredentialStoreChoice = 'auto' | 'keychain' | 'file' | 'environment';

export interface ConfigInitOptions {
  backend?: BackendChoice;
  home?: string;
  auth?: AuthChoice;
  workspace?: string;
  accessToken?: string;
  credentialStore?: CredentialStoreChoice;
  yes?: boolean;
}

export interface ConfigPlan {
  backend: BackendChoice;
  home: string;
  serviceUrl?: string;
  auth?: AuthChoice;
  workspaceId?: string;
  credentialStore?: CredentialStoreChoice;
}

/**
 * Where a credential can actually be kept on this platform.
 *
 * Reported rather than assumed: offering macOS Keychain on Linux, or a Secret
 * Service that is not running, produces a setup that appears to succeed and
 * then cannot read its own credential back.
 */
export function credentialStoreChoices(
  platform: NodeJS.Platform = process.platform,
): Array<{ value: CredentialStoreChoice; label: string; detail?: string }> {
  const native =
    platform === 'darwin'
      ? { value: 'keychain' as const, label: 'macOS Keychain', detail: 'Recommended.' }
      : platform === 'win32'
        ? /*
           * Windows has no native option here yet, so the restricted file is
           * the recommendation rather than Credential Manager. Offering a
           * store the credential layer cannot actually read back would fail
           * at the first use, after the wizard had already told the person
           * their credential was safely stored.
           */
          {
            value: 'file' as const,
            label: 'A restricted file in the Synomem home',
            detail: 'Recommended on Windows until Credential Manager support lands.',
          }
        : {
            value: 'keychain' as const,
            label: 'Secret Service (libsecret)',
            detail: 'Recommended where a desktop keyring is running.',
          };
  return [
    native,
    ...(native.value === 'file'
      ? []
      : [
          {
            value: 'file' as const,
            label: 'A restricted file in the Synomem home',
            detail: 'Mode 0600. Use on headless machines with no keyring.',
          },
        ]),
    {
      value: 'environment',
      label: 'Print environment-variable instructions',
      detail: 'Nothing is stored. Synomem never edits your shell profile.',
    },
  ];
}

/** Refuses to guess when there is nobody to ask. */
export function assertInteractive(io: PromptIo): void {
  if (io.interactive) return;
  throw new SynomemError(
    'INVALID_INPUT',
    [
      'synomem config needs an interactive terminal.',
      '',
      'For automation, use the deterministic form instead:',
      '',
      '  synomem config init --backend local --yes',
      '',
      '  synomem config init --backend remote --auth access-key \\',
      '    --workspace <workspace-id> --access-token-stdin --yes',
      '',
      'Pipe the token in rather than passing it as an argument: an argument is',
      'kept by both the shell history and the process list.',
    ].join('\n'),
  );
}

/**
 * Stores an access key in a restricted file.
 *
 * Separate from `config.json` so a configuration file can be read, copied or
 * pasted into an issue without carrying a secret with it.
 */
export function writeCredentialFile(home: string, token: string): string {
  const directory = join(home, 'credentials');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const path = join(directory, 'installation.json');
  writeFileSync(path, `${JSON.stringify({ accessToken: token }, null, 2)}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return path;
}

/** A key's identifying prefix. Never the key. */
export function credentialFingerprint(token: string): string {
  const head = token.slice(0, 12);
  return `${head}${token.length > 12 ? '\u2026' : ''}`;
}

export function environmentInstructions(token: string): string {
  return [
    'Set this value for the current shell:',
    '',
    `  export SYNOMEM_ACCESS_TOKEN='${token}'`,
    '',
    'To persist it, add that to a secret-aware shell configuration or to your',
    'agent runtime environment. Synomem will not edit your shell profile for',
    'you: silently rewriting a dotfile is not a thing a setup program should do.',
  ].join('\n');
}

/** The interactive flow, returning the plan it settled on. */
export async function runConfigWizard(
  io: PromptIo,
  options: { home?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<ConfigPlan> {
  assertInteractive(io);
  const env = options.env ?? process.env;

  io.output.write(
    [
      '',
      'Welcome to Synomem',
      '',
      'Synomem gives agents durable notes, messages, tasks, todos, kudos,',
      'and shared coordination.',
      '',
    ].join('\n'),
  );

  const backend = await select<BackendChoice>(io, 'Where should Synomem store canonical state?', [
    {
      value: 'local',
      label: 'Local \u2014 SQLite on this machine',
      detail: 'Nothing is uploaded. One implicit workspace.',
    },
    {
      value: 'remote',
      label: 'Synomem Cloud \u2014 shared across machines and agents',
      detail: 'Organizations, workspaces, roles and administration.',
    },
  ]);

  const home = await ask(io, 'Where should Synomem store its data?', resolveHome(options.home));

  if (backend === 'local') {
    return { backend, home };
  }

  const serviceUrl = cloudApiUrl(env);
  io.output.write(`\nConnecting to Synomem Cloud at ${serviceUrl}\n`);

  const auth = await select<AuthChoice>(io, 'How would you like to sign in?', [
    {
      value: 'browser',
      label: 'Sign in with your browser',
      detail: 'Opens the authorization server and returns through a loopback callback.',
    },
    {
      value: 'access-key',
      label: 'Use an installation access key',
      detail: 'Create one at https://portal.synomem.ai/installations',
    },
  ]);

  /*
   * Deliberately no workspace prompt here.
   *
   * A hosted workspace ID looks like `ws-04psqx2rkt8ttft7a1t2z69r97`, and the
   * credential authorized in the next step already knows which workspace it
   * reaches -- an installation key is bound to exactly one, and a browser
   * sign-in can list the ones the account belongs to. Asking first means
   * asking a person to go and look something up that we are about to be told.
   */

  const credentialStore =
    auth === 'access-key'
      ? await select<CredentialStoreChoice>(
          io,
          'Where should Synomem store this credential?',
          credentialStoreChoices(),
        )
      : 'auto';

  return { backend, home, serviceUrl, auth, credentialStore };
}

/** Reads an access key without ever accepting it as an argument. */
export async function readAccessToken(io: PromptIo): Promise<string> {
  const token = await askSecret(io, 'Installation access key');
  if (!token) throw new SynomemError('INVALID_INPUT', 'No access key was provided.');
  return token;
}

export async function confirmPlan(io: PromptIo, plan: ConfigPlan): Promise<boolean> {
  io.output.write(
    [
      '',
      'Synomem will be configured as:',
      '',
      `  Backend:   ${plan.backend === 'local' ? 'Local SQLite' : 'Synomem Cloud'}`,
      `  Home:      ${plan.home}`,
      ...(plan.serviceUrl ? [`  Service:   ${plan.serviceUrl}`] : []),
      ...(plan.workspaceId ? [`  Workspace: ${plan.workspaceId}`] : []),
      ...(plan.credentialStore && plan.credentialStore !== 'auto'
        ? [`  Credential: ${plan.credentialStore}`]
        : []),
      '',
    ].join('\n'),
  );
  return await confirm(io, 'Apply this?');
}

export function homeExists(home: string): boolean {
  return existsSync(home);
}
