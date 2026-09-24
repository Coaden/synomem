/**
 * Setup helpers shared by `connection` and `setup`.
 *
 * Two rules shape this file. Every interactive step has a non-interactive
 * counterpart, so an agent can configure a machine without a terminal. And a
 * secret is never accepted as a command-line argument: an argument is kept by
 * the shell history and visible in the process list, so access keys arrive on
 * stdin.
 */
import { SynomemError } from './errors.js';
import { askSecret, type PromptIo } from './prompt.js';
import type { CredentialBackendKind } from './credentials.js';

/**
 * Where a credential can be kept on this platform, recommended first.
 *
 * Reported rather than assumed: offering the macOS Keychain on Linux, or a
 * Secret Service that is not running, produces a setup that appears to succeed
 * and then cannot read its own credential back.
 */
export function credentialStoreChoices(
  platform: NodeJS.Platform = process.platform,
): Array<{ value: CredentialBackendKind; label: string; detail?: string }> {
  const native =
    platform === 'darwin'
      ? [{ value: 'keychain' as const, label: 'macOS Keychain', detail: 'Recommended.' }]
      : platform === 'linux'
        ? [
            {
              value: 'keychain' as const,
              label: 'Secret Service (libsecret)',
              detail: 'Recommended where a desktop keyring is running.',
            },
          ]
        : [];
  return [
    ...native,
    {
      value: 'file',
      label: 'A restricted file in the Synomem home',
      detail: 'Mode 0600. Use on headless machines with no keyring.',
    },
    {
      value: 'environment',
      label: 'SYNOMEM_ACCESS_TOKEN (access keys only)',
      detail: 'Nothing is stored; the key is read from the environment each run.',
    },
  ];
}

/** The default store: the OS keychain where one exists, otherwise refused. */
export function defaultCredentialBackend(
  platform: NodeJS.Platform = process.platform,
): CredentialBackendKind {
  if (platform === 'darwin' || platform === 'linux') return 'keychain';
  throw new SynomemError(
    'CONFIG_INVALID',
    'This platform has no supported credential store. Pass --store file (a mode-0600 file), or --store environment for an access key.',
  );
}

export function parseCredentialBackend(
  value: string | undefined,
  platform: NodeJS.Platform = process.platform,
): CredentialBackendKind {
  if (value === undefined) return defaultCredentialBackend(platform);
  if (value === 'keychain' || value === 'file' || value === 'environment') return value;
  throw new SynomemError('INVALID_INPUT', '--store must be keychain, file, or environment.');
}

/** Refuses to guess when there is nobody to ask. */
export function assertInteractive(io: PromptIo, alternative: string): void {
  if (io.interactive) return;
  throw new SynomemError(
    'INVALID_INPUT',
    `This step needs an interactive terminal. For automation: ${alternative}`,
  );
}

/** Reads an access key from stdin (or a prompt), never from an argument. */
export async function readAccessKey(io: PromptIo): Promise<string> {
  const key = await askSecret(io, 'Access key');
  if (!key) throw new SynomemError('INVALID_INPUT', 'No access key was provided on stdin.');
  if (!key.startsWith('syn_')) {
    throw new SynomemError(
      'INVALID_INPUT',
      'That does not look like a Synomem access key (syn_…).',
    );
  }
  return key;
}

/** A key's identifying prefix. Never the key. */
export function credentialFingerprint(token: string): string {
  const head = token.slice(0, 12);
  return `${head}${token.length > 12 ? '…' : ''}`;
}
