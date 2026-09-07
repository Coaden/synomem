import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { SynomemClient } from './client.js';
import { defaultConfig, mergeConfig, resolveHome } from './config.js';
import { SynomemError } from './errors.js';
import {
  assertNoSymlinkEscape,
  atomicWriteFile,
  ensureDirectory,
  readJsonFile,
} from './fs-utils.js';
import { environmentCredentialProvider, RemoteSynomemService } from './remote.js';
import { credentialReference, OsCredentialStore } from './credentials.js';
import { StoredCredentialProvider } from './oauth.js';
import type { SynomemServiceFactory } from './service.js';
import type {
  ActorIdentity,
  SynomemBackendConfig,
  SynomemClientOptions,
  SynomemConfig,
} from './types.js';

function configLocation(explicitHome?: string): {
  home: string;
  storageDirectory: string;
  configPath: string;
} {
  /*
   * The home IS the storage directory. It used to be `<home>/synomem`, which
   * made sense while the default home was `~/.agents` and Synomem was one
   * tenant inside it. Now that the home is `~/.synomem`, that nesting produces
   * `~/.synomem/synomem` — a path the layout explicitly rules out, and one that
   * makes every documented path wrong by a level.
   */
  const home = resolveHome(explicitHome);
  return { home, storageDirectory: home, configPath: join(home, 'config.json') };
}

export function readSynomemConfig(
  explicitHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): SynomemConfig | undefined {
  const { home, storageDirectory, configPath } = configLocation(explicitHome);
  if (!existsSync(configPath)) return undefined;
  if (!existsSync(home) || lstatSync(home).isSymbolicLink()) {
    throw new SynomemError('UNSAFE_PATH', 'The configured Synomem home is unsafe.');
  }
  assertNoSymlinkEscape(home, storageDirectory);
  return mergeConfig(readJsonFile(configPath), undefined, env);
}

export function writeSynomemBackend(
  backend: SynomemBackendConfig,
  explicitHome?: string,
): SynomemConfig {
  const { home, storageDirectory, configPath } = configLocation(explicitHome);
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  if (lstatSync(home).isSymbolicLink()) {
    throw new SynomemError('UNSAFE_PATH', 'The configured Synomem home cannot be a symbolic link.');
  }
  ensureDirectory(storageDirectory);
  assertNoSymlinkEscape(home, storageDirectory);
  chmodSync(storageDirectory, 0o700);
  const existing = existsSync(configPath)
    ? mergeConfig(readJsonFile(configPath), undefined, {})
    : { ...defaultConfig, workspaceId: ulid() };
  const config = mergeConfig({ ...existing, backend }, undefined, {});
  atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

export function createConfiguredService(
  options: SynomemClientOptions = {},
  env: NodeJS.ProcessEnv = process.env,
) {
  const persisted = readSynomemConfig(options.home, env);
  const backend = options.config?.backend ?? persisted?.backend ?? defaultConfig.backend;
  if (backend.kind === 'local') return new SynomemClient(options);
  const expectedActor: ActorIdentity = options.actor ?? { kind: 'system', id: 'workspace' };
  return new RemoteSynomemService({
    baseUrl: backend.baseUrl,
    workspaceId: backend.workspaceId,
    expectedActor,
    credentialProvider: env.SYNOMEM_ACCESS_TOKEN
      ? environmentCredentialProvider(env)
      : new StoredCredentialProvider(
          credentialReference(backend.baseUrl, backend.workspaceId, expectedActor),
          new OsCredentialStore(),
          env,
        ),
    ...(options.signal ? { signal: options.signal } : {}),
  });
}

export const configuredServiceFactory: SynomemServiceFactory = (options) =>
  createConfiguredService(options);
