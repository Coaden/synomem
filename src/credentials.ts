import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { SynomemError } from './errors.js';
import type { ActorIdentity } from './types.js';

const serviceName = 'ai.synomem.credentials';
const maximumOutputBytes = 128 * 1024;

/**
 * An installation access key.
 *
 * Not an OAuth credential: it has no refresh, no token endpoint and no client,
 * and it authorizes a MACHINE rather than a person. Keeping it a distinct shape
 * stops code treating it as refreshable, which would mean silently failing to
 * renew something that never expires that way.
 */
export interface StoredInstallationKey {
  kind: 'installation-key';
  accessToken: string;
}

export type StoredCredential = StoredOAuthCredential | StoredInstallationKey;

export interface StoredOAuthCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenEndpoint: string;
  clientId: string;
  resource: string;
  scope: string;
}

export interface CredentialStore {
  get(reference: string): Promise<StoredCredential | undefined>;
  set(reference: string, credential: StoredCredential): Promise<void>;
  delete(reference: string): Promise<boolean>;
}

export function credentialReference(
  baseUrl: string,
  workspaceId: string,
  actor: ActorIdentity,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        baseUrl: new URL(baseUrl).origin,
        workspaceId,
        actor: { kind: actor.kind, id: actor.id },
      }),
    )
    .digest('base64url');
}

interface CommandResult {
  stdout: string;
  stderr: string;
  code: number;
}

export type CredentialCommandRunner = (
  executable: string,
  arguments_: string[],
  input?: string,
) => Promise<CommandResult>;

async function command(
  executable: string,
  arguments_: string[],
  input?: string,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.byteLength;
      if (bytes > maximumOutputBytes) {
        child.kill();
        reject(new SynomemError('INTERNAL_ERROR', 'Credential helper output was too large.'));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    child.once('error', reject);
    child.once('close', (code) =>
      resolve({
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        code: code ?? 1,
      }),
    );
    child.stdin.end(input);
  });
}

function parseCredential(value: string): StoredOAuthCredential {
  try {
    const parsed = JSON.parse(value) as Partial<StoredOAuthCredential>;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.tokenEndpoint !== 'string' ||
      typeof parsed.clientId !== 'string' ||
      typeof parsed.resource !== 'string' ||
      typeof parsed.scope !== 'string'
    ) {
      throw new Error();
    }
    return parsed as StoredOAuthCredential;
  } catch {
    throw new SynomemError('AUTH_REQUIRED', 'Stored Synomem credentials are malformed.');
  }
}

export class OsCredentialStore implements CredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly run: CredentialCommandRunner;

  constructor(options: { platform?: NodeJS.Platform; run?: CredentialCommandRunner } = {}) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? command;
  }

  async get(reference: string): Promise<StoredOAuthCredential | undefined> {
    const result =
      this.platform === 'darwin'
        ? await this.run('/usr/bin/security', [
            'find-generic-password',
            '-a',
            reference,
            '-s',
            serviceName,
            '-w',
          ])
        : this.platform === 'linux'
          ? await this.run('secret-tool', ['lookup', 'service', serviceName, 'account', reference])
          : this.unsupported();
    if (result.code !== 0) return undefined;
    return parseCredential(result.stdout.trim());
  }

  async set(reference: string, credential: StoredOAuthCredential): Promise<void> {
    const serialized = JSON.stringify(credential);
    const result =
      this.platform === 'darwin'
        ? await this.run(
            '/usr/bin/security',
            [
              'add-generic-password',
              '-a',
              reference,
              '-s',
              serviceName,
              '-l',
              'Synomem OAuth credential',
              '-U',
              '-w',
            ],
            `${serialized}\n`,
          )
        : this.platform === 'linux'
          ? await this.run(
              'secret-tool',
              [
                'store',
                '--label=Synomem OAuth credential',
                'service',
                serviceName,
                'account',
                reference,
              ],
              serialized,
            )
          : this.unsupported();
    if (result.code !== 0) {
      throw new SynomemError(
        'AUTH_REQUIRED',
        'The operating-system credential store rejected the credential.',
      );
    }
  }

  async delete(reference: string): Promise<boolean> {
    const result =
      this.platform === 'darwin'
        ? await this.run('/usr/bin/security', [
            'delete-generic-password',
            '-a',
            reference,
            '-s',
            serviceName,
          ])
        : this.platform === 'linux'
          ? await this.run('secret-tool', ['clear', 'service', serviceName, 'account', reference])
          : this.unsupported();
    return result.code === 0;
  }

  private unsupported(): never {
    throw new SynomemError(
      'CONFIG_INVALID',
      'Interactive credential storage is currently supported on macOS and Linux with secret-tool.',
    );
  }
}
