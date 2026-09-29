import { DatabaseSync } from 'node:sqlite';
/**
 * Local store helpers.
 *
 * A local store is one SQLite home: `<home>/config.json` (its policy and its
 * persistent workspace identity) plus the database beside it. Which store and
 * which actor a command uses is decided by a profile (`profiles.ts`); this
 * module only opens and initializes stores.
 *
 * Remote access no longer passes through here at all. There is no
 * "configured backend" in a store's config any more: a store is always local,
 * and hosted access is a connection plus a context in `profiles.json`.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { ulid } from 'ulid';
import { createLocalOwnerClient, SynomemClient } from './client.js';
import { defaultConfig, mergeConfig, resolveHome } from './config.js';
import { SynomemError } from './errors.js';
import {
  assertNoSymlinkEscape,
  atomicWriteFile,
  ensureDirectory,
  readJsonFile,
} from './fs-utils.js';
import type { ActorIdentity, SynomemConfig } from './types.js';

/**
 * The person at the keyboard of a local store. The filesystem owner is the
 * ultimate authority over a local store, so administrative commands (creating
 * agents, rebuilding, exporting) run as this actor rather than as an agent.
 */
export const LOCAL_OPERATOR: ActorIdentity = {
  kind: 'human',
  id: 'local-cli',
  displayName: 'Local operator',
};

function storeLocation(explicitHome?: string): { home: string; configPath: string } {
  const home = resolveHome(explicitHome);
  return { home, configPath: join(home, 'config.json') };
}

/** A store's config, or undefined when the home has no store yet. */
export function readSynomemConfig(
  explicitHome?: string,
  env: NodeJS.ProcessEnv = process.env,
): SynomemConfig | undefined {
  const { home, configPath } = storeLocation(explicitHome);
  if (!existsSync(configPath)) return undefined;
  if (!existsSync(home) || lstatSync(home).isSymbolicLink()) {
    throw new SynomemError('UNSAFE_PATH', 'The configured Synomem home is unsafe.');
  }
  assertNoSymlinkEscape(home, home);
  const config = mergeConfig(readJsonFile(configPath), undefined, env);
  if (config.backend.kind !== 'local') {
    throw new SynomemError(
      'CONFIG_INVALID',
      `${configPath} selects a remote backend, which is no longer supported. Hosted access is a connection now: run \`synomem connection login\` and \`synomem profile create\`, or \`synomem setup --backend local\` for a local store.`,
    );
  }
  return config;
}

/**
 * Creates the store's config (with a fresh persistent workspace identity) if it
 * does not exist, and returns it. Idempotent: an existing store keeps its
 * identity, which local context ids are derived from.
 */
export function ensureLocalStore(explicitHome?: string): SynomemConfig {
  const { home, configPath } = storeLocation(explicitHome);
  if (!existsSync(home)) mkdirSync(home, { recursive: true, mode: 0o700 });
  if (lstatSync(home).isSymbolicLink()) {
    throw new SynomemError('UNSAFE_PATH', 'The configured Synomem home cannot be a symbolic link.');
  }
  const existing = readSynomemConfig(explicitHome, {});
  if (existing) return existing;
  ensureDirectory(home);
  chmodSync(home, 0o700);
  const config = mergeConfig(
    { ...defaultConfig, backend: { kind: 'local' }, workspaceId: ulid() },
    undefined,
    {},
  );
  atomicWriteFile(configPath, `${JSON.stringify(config, null, 2)}\n`);
  return config;
}

/** The store's persistent workspace identity, creating the store if needed. */
export function localStoreWorkspaceId(explicitHome?: string): string {
  return ensureLocalStore(explicitHome).workspaceId;
}

/** Opens (and initializes) a local store as one actor. The caller closes it. */
export async function openLocalService(
  home: string | undefined,
  actor: ActorIdentity,
): Promise<SynomemClient> {
  ensureLocalStore(home);
  const client = new SynomemClient({ ...(home ? { home } : {}), actor });
  await client.init();
  return client;
}

export async function openLocalOwnerService(home?: string): Promise<SynomemClient> {
  ensureLocalStore(home);
  const client = createLocalOwnerClient({ ...(home ? { home } : {}), actor: LOCAL_OPERATOR });
  await client.init();
  return client;
}

/** Filesystem-owner recovery path: no migration, normalization or writes. */
export function exportRawLocalEvents(home?: string, format: 'json' | 'jsonl' = 'jsonl'): string {
  const root = resolveHome(home);
  const databasePath = join(root, 'synomem.sqlite3');
  assertNoSymlinkEscape(root, databasePath);
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const rows = database.prepare('SELECT payload FROM events ORDER BY rowid').all() as Array<{
      payload: string;
    }>;
    return format === 'jsonl'
      ? rows.map((row) => row.payload).join('\n') + (rows.length ? '\n' : '')
      : `[${rows.map((row) => row.payload).join(',\n')}]\n`;
  } finally {
    database.close();
  }
}
