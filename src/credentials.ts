/**
 * Credential storage, indexed by connection — never by actor or workspace.
 *
 * One stored secret serves every profile that routes through its connection:
 * adding a profile for another agent or workspace never copies a refresh
 * token, and rotating a credential updates exactly one entry. Which actor and
 * workspace an operation uses is the profile's business (see `profiles.ts`),
 * and the server authorizes it on every request regardless of what is stored
 * here.
 *
 * Two credential kinds, deliberately distinct so nothing tries to refresh a
 * key or treat an OAuth family as a static secret:
 *
 *   - `oauth`: an authorization-code family for one connection, refreshed
 *     under a cross-process lock with a generation counter;
 *   - `access-key`: a member-owned `syn_…` key, used exactly as stored.
 *
 * Backends: the macOS Keychain, Linux Secret Service (`secret-tool`), an
 * explicit restricted file, or the process environment. There is no silent
 * fallback from one to another: a keychain that refuses a write is an error
 * that names the explicit alternative.
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SynomemError } from './errors.js';
import { atomicWriteFile } from './fs-utils.js';

const serviceName = 'ai.synomem.credentials';
const maximumOutputBytes = 128 * 1024;

export const storedOAuthCredentialSchema = z.object({
  kind: z.literal('oauth'),
  issuer: z.string().min(1),
  resource: z.string().min(1),
  clientId: z.string().min(1),
  tokenEndpoint: z.string().min(1),
  scope: z.string(),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1).optional(),
  /** Epoch milliseconds, already reduced by a safety margin. */
  expiresAt: z.number().int().nonnegative(),
  /** Incremented on every successful refresh; the compare-and-swap token. */
  generation: z.number().int().nonnegative(),
});

export const storedAccessKeySchema = z.object({
  kind: z.literal('access-key'),
  secret: z.string().min(1),
});

export const storedCredentialSchema = z.discriminatedUnion('kind', [
  storedOAuthCredentialSchema,
  storedAccessKeySchema,
]);

export type StoredOAuthCredential = z.infer<typeof storedOAuthCredentialSchema>;
export type StoredAccessKey = z.infer<typeof storedAccessKeySchema>;
export type StoredCredential = z.infer<typeof storedCredentialSchema>;

/** Where a connection's secret lives. `environment` stores nothing. */
export type CredentialBackendKind = 'keychain' | 'file' | 'environment';

export interface CredentialStore {
  get(reference: string): Promise<StoredCredential | undefined>;
  set(reference: string, credential: StoredCredential): Promise<void>;
  delete(reference: string): Promise<boolean>;
}

/** An opaque, non-secret handle for a stored secret. Never derived from names. */
export function newSecretReference(): string {
  return `synomem-${randomUUID()}`;
}

export function parseStoredCredential(value: string): StoredCredential {
  let raw: unknown;
  try {
    raw = JSON.parse(value);
  } catch {
    throw new SynomemError('AUTH_REQUIRED', 'Stored Synomem credential is malformed.');
  }
  const parsed = storedCredentialSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SynomemError(
      'AUTH_REQUIRED',
      'Stored Synomem credential is in an unsupported format. Run `synomem connection login` (or `connection add-key`) again.',
    );
  }
  return parsed.data;
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

/** macOS Keychain or Linux Secret Service. */
export class OsCredentialStore implements CredentialStore {
  private readonly platform: NodeJS.Platform;
  private readonly run: CredentialCommandRunner;

  constructor(options: { platform?: NodeJS.Platform; run?: CredentialCommandRunner } = {}) {
    this.platform = options.platform ?? process.platform;
    this.run = options.run ?? command;
  }

  async get(reference: string): Promise<StoredCredential | undefined> {
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
    return parseStoredCredential(result.stdout.trim());
  }

  async set(reference: string, credential: StoredCredential): Promise<void> {
    const serialized = JSON.stringify(storedCredentialSchema.parse(credential));
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
              'Synomem credential',
              '-U',
              '-w',
            ],
            `${serialized}\n`,
          )
        : this.platform === 'linux'
          ? await this.run(
              'secret-tool',
              ['store', '--label=Synomem credential', 'service', serviceName, 'account', reference],
              serialized,
            )
          : this.unsupported();
    if (result.code !== 0) {
      throw new SynomemError(
        'CONFIG_INVALID',
        'The operating-system credential store rejected the credential. Re-run with --store file to use a restricted file instead.',
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

  /*
   * Windows Credential Manager is not implemented: `cmdkey` can write a generic
   * credential but will not read the secret back, so a store built on it would
   * accept a credential and never return it.
   */
  private unsupported(): never {
    throw new SynomemError(
      'CONFIG_INVALID',
      this.platform === 'win32'
        ? 'Windows Credential Manager storage is not supported yet. Use --store file, or --store environment with SYNOMEM_ACCESS_TOKEN.'
        : 'Operating-system credential storage needs the macOS Keychain, or secret-tool on Linux. Use --store file, or --store environment with SYNOMEM_ACCESS_TOKEN.',
    );
  }
}

/**
 * One restricted file per secret under `<home>/credentials/`, mode 0600 in a
 * 0700 directory. Chosen explicitly (`--store file`), never as a fallback.
 */
export class FileCredentialStore implements CredentialStore {
  private readonly directory: string;

  constructor(home: string) {
    this.directory = join(home, 'credentials');
  }

  private path(reference: string): string {
    if (!/^[A-Za-z0-9_-]{1,100}$/.test(reference)) {
      throw new SynomemError('CONFIG_INVALID', 'Credential reference is malformed.');
    }
    return join(this.directory, `${reference}.json`);
  }

  async get(reference: string): Promise<StoredCredential | undefined> {
    const path = this.path(reference);
    if (!existsSync(path)) return undefined;
    return parseStoredCredential(readFileSync(path, 'utf8'));
  }

  async set(reference: string, credential: StoredCredential): Promise<void> {
    if (!existsSync(this.directory)) mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    chmodSync(this.directory, 0o700);
    atomicWriteFile(
      this.path(reference),
      `${JSON.stringify(storedCredentialSchema.parse(credential))}\n`,
      0o600,
    );
  }

  async delete(reference: string): Promise<boolean> {
    const path = this.path(reference);
    if (!existsSync(path)) return false;
    rmSync(path, { force: true });
    return true;
  }
}

export interface CredentialStores {
  keychain: CredentialStore;
  file: CredentialStore;
}

export function defaultCredentialStores(home: string): CredentialStores {
  return { keychain: new OsCredentialStore(), file: new FileCredentialStore(home) };
}

/**
 * A cross-process lock around one credential's refresh.
 *
 * `O_EXCL` creation is the mutual exclusion; a lock older than `staleMs` is
 * from a crashed process and is broken. The lock only serializes refreshes —
 * correctness against a concurrent writer is the generation compare-and-swap
 * in `refreshCredential`.
 */
export async function withCredentialLock<T>(
  home: string,
  name: string,
  operation: () => Promise<T>,
  options: { staleMs?: number; timeoutMs?: number; pollMs?: number } = {},
): Promise<T> {
  if (!/^[A-Za-z0-9_.-]{1,100}$/.test(name)) {
    throw new SynomemError('CONFIG_INVALID', 'Credential name is malformed.');
  }
  const directory = join(home, 'locks');
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, `${name}.lock`);
  const staleMs = options.staleMs ?? 60_000;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const pollMs = options.pollMs ?? 50;
  let descriptor: number | undefined;
  while (descriptor === undefined) {
    try {
      descriptor = openSync(path, 'wx', 0o600);
      writeSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      try {
        if (Date.now() - statSync(path).mtimeMs > staleMs) {
          unlinkSync(path);
          continue;
        }
      } catch {
        // Removed between the failed open and the stat: try again at once.
        continue;
      }
      if (Date.now() > deadline) {
        throw new SynomemError(
          'DATABASE_BUSY',
          `Another Synomem process is refreshing the ${name} credential. Try again.`,
        );
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }
  try {
    return await operation();
  } finally {
    closeSync(descriptor);
    rmSync(path, { force: true });
  }
}
