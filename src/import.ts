import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { SynomemClient } from './client.js';
import { readSynomemConfig } from './backend.js';
import { asSynomemError, SynomemError } from './errors.js';
import { eventSchema, profileSchema } from './schemas.js';
import type { SynomemCredentialProvider } from './remote.js';
import type { SynomemEvent } from './types.js';

export const importBundleSchema = z
  .object({
    version: z.literal(1),
    sourceWorkspaceId: z.string().trim().min(1).max(100),
    checksum: z.string().regex(/^[a-f0-9]{64}$/),
    events: z.array(eventSchema).max(100_000),
    profiles: z.array(profileSchema).max(10_000),
  })
  .strict();

export type ImportBundle = z.infer<typeof importBundleSchema>;

export interface ImportPreview {
  planId: string;
  expiresAt: string;
  sourceWorkspaceId: string;
  targetWorkspaceId: string;
  checksum: string;
  events: number;
  profiles: number;
  bytes: number;
}

export interface ImportResult extends Omit<ImportPreview, 'planId' | 'expiresAt' | 'bytes'> {
  importedAt: string;
}

function content(bundle: Omit<ImportBundle, 'checksum'>): string {
  return JSON.stringify(bundle);
}

export function importBundleChecksum(bundle: Omit<ImportBundle, 'checksum'>): string {
  return createHash('sha256').update(content(bundle)).digest('hex');
}

export function validateImportBundle(value: unknown, maximumBytes = 5 * 1024 * 1024): ImportBundle {
  const parsed = importBundleSchema.parse(value);
  const unsigned = {
    version: parsed.version,
    sourceWorkspaceId: parsed.sourceWorkspaceId,
    events: parsed.events,
    profiles: parsed.profiles,
  } as const;
  const bytes = Buffer.byteLength(content(unsigned));
  if (bytes > maximumBytes) {
    throw new SynomemError('INVALID_INPUT', 'The import bundle exceeds the 5 MiB limit.');
  }
  if (importBundleChecksum(unsigned) !== parsed.checksum) {
    throw new SynomemError('INVALID_INPUT', 'The import bundle checksum is invalid.');
  }
  const eventIds = new Set<string>();
  const versions = new Map<string, number>();
  for (const event of parsed.events) {
    if (event.workspaceId !== parsed.sourceWorkspaceId) {
      throw new SynomemError('INVALID_INPUT', 'An event has the wrong source workspace identity.');
    }
    if (eventIds.has(event.id))
      throw new SynomemError('INVALID_INPUT', 'Event IDs must be unique.');
    eventIds.add(event.id);
    const expected = (versions.get(event.aggregateId) ?? 0) + 1;
    if (event.aggregateVersion !== expected) {
      throw new SynomemError(
        'INVALID_INPUT',
        `Aggregate ${event.aggregateId} has a non-contiguous version history.`,
      );
    }
    versions.set(event.aggregateId, expected);
  }
  const profileIds = new Set(parsed.profiles.map((profile) => profile.id));
  if (profileIds.size !== parsed.profiles.length) {
    throw new SynomemError('INVALID_INPUT', 'Imported agent profiles must have unique IDs.');
  }
  for (const profile of parsed.profiles) {
    if (
      !parsed.events.some(
        (event) => event.type === 'agent.created' && event.agent.id === profile.id,
      )
    ) {
      throw new SynomemError(
        'INVALID_INPUT',
        `Agent profile ${profile.id} has no canonical creation event.`,
      );
    }
  }
  return parsed;
}

/** Create a consistent, read-only SQLite snapshot and derive an import bundle from that snapshot. */
export async function createLocalImportBundle(fromHome: string): Promise<ImportBundle> {
  const sourceHome = resolve(fromHome);
  const config = readSynomemConfig(sourceHome, {});
  if (!config)
    throw new SynomemError('CONFIG_INVALID', 'The source Synomem home is not initialized.');
  const client = new SynomemClient({
    home: sourceHome,
    readOnly: true,
    config: { backend: { kind: 'local' } },
  });
  await client.init();
  const temporaryDirectory = mkdtempSync(join(tmpdir(), 'synomem-import-'));
  const snapshotPath = join(temporaryDirectory, 'snapshot.sqlite3');
  try {
    client.storage.db().prepare('VACUUM INTO ?').run(snapshotPath);
    const snapshot = new DatabaseSync(snapshotPath, {
      readOnly: true,
      enableForeignKeyConstraints: true,
    });
    try {
      const integrity = snapshot.prepare('PRAGMA integrity_check').get() as Record<string, string>;
      if (Object.values(integrity)[0] !== 'ok') {
        throw new SynomemError(
          'DATABASE_CORRUPT',
          'The local import snapshot failed integrity check.',
        );
      }
      const rows = snapshot
        .prepare('SELECT id,payload FROM events ORDER BY sequence')
        .all() as Array<{
        id: string;
        payload: string;
      }>;
      const events: SynomemEvent[] = [];
      for (const row of rows) {
        try {
          events.push(eventSchema.parse(JSON.parse(row.payload)));
        } catch (error) {
          throw new SynomemError(
            'UNSUPPORTED_EVENT',
            `Local event ${row.id} cannot be imported; use raw JSONL export for recovery.`,
            { eventIds: [row.id], cause: asSynomemError(error).code },
          );
        }
      }
      const profiles = snapshot
        .prepare('SELECT profile_json FROM agents ORDER BY id')
        .all()
        .map((row) =>
          profileSchema.parse(JSON.parse((row as { profile_json: string }).profile_json)),
        );
      const unsigned = {
        version: 1 as const,
        sourceWorkspaceId: config.workspaceId,
        events,
        profiles,
      };
      return validateImportBundle({ ...unsigned, checksum: importBundleChecksum(unsigned) });
    } finally {
      snapshot.close();
    }
  } finally {
    await client.close();
    if (existsSync(temporaryDirectory)) rmSync(temporaryDirectory, { recursive: true });
  }
}

export interface RemoteImportClientOptions {
  baseUrl: string;
  workspaceId: string;
  credentialProvider: SynomemCredentialProvider;
  fetch?: typeof fetch;
}

export class RemoteImportClient {
  private readonly baseUrl: URL;
  private readonly workspaceId: string;
  private readonly credentialProvider: SynomemCredentialProvider;
  private readonly fetchImplementation: typeof fetch;

  constructor(options: RemoteImportClientOptions) {
    this.baseUrl = new URL(options.baseUrl);
    const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(this.baseUrl.hostname);
    if (this.baseUrl.protocol !== 'https:' && !(this.baseUrl.protocol === 'http:' && loopback)) {
      throw new SynomemError('CONFIG_INVALID', 'Remote imports require HTTPS.');
    }
    if (
      this.baseUrl.pathname !== '/' ||
      this.baseUrl.username ||
      this.baseUrl.password ||
      this.baseUrl.search ||
      this.baseUrl.hash
    ) {
      throw new SynomemError('CONFIG_INVALID', 'Remote import baseUrl must be an origin.');
    }
    this.workspaceId = options.workspaceId;
    this.credentialProvider = options.credentialProvider;
    this.fetchImplementation = options.fetch ?? fetch;
  }

  preview(bundle: ImportBundle): Promise<ImportPreview> {
    return this.request<ImportPreview>('preview', { bundle });
  }

  confirm(bundle: ImportBundle, planId: string): Promise<ImportResult> {
    return this.request<ImportResult>('confirm', { bundle, planId });
  }

  private async request<T>(action: 'preview' | 'confirm', payload: object): Promise<T> {
    const token = await this.credentialProvider.getAccessToken();
    if (!token) throw new SynomemError('AUTH_REQUIRED', 'Remote authentication is required.');
    const url = new URL(
      `v1/workspaces/${encodeURIComponent(this.workspaceId)}/imports/${action}`,
      this.baseUrl,
    );
    let response: Response;
    try {
      response = await this.fetchImplementation(url, {
        method: 'POST',
        redirect: 'manual',
        signal: AbortSignal.timeout(60_000),
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (error) {
      throw new SynomemError('REMOTE_UNAVAILABLE', 'The remote import request failed.', {
        cause: error instanceof Error ? error.name : 'network_error',
      });
    }
    if (response.status >= 300 && response.status < 400) {
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote redirects are not followed.');
    }
    if (!response.body)
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote import returned no body.');
    const reader = response.body.getReader() as unknown as {
      read(): Promise<{ done: boolean; value?: Uint8Array }>;
      cancel(): Promise<void>;
    };
    const chunks: Uint8Array[] = [];
    let length = 0;
    while (true) {
      const item = await reader.read();
      if (item.done) break;
      if (!item.value)
        throw new SynomemError('REMOTE_PROTOCOL', 'Remote import returned a malformed stream.');
      length += item.value.byteLength;
      if (length > 1024 * 1024) {
        await reader.cancel();
        throw new SynomemError('REMOTE_PROTOCOL', 'Remote import response exceeded 1 MiB.');
      }
      chunks.push(item.value);
    }
    const combined = new Uint8Array(length);
    let offset = 0;
    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const text = new TextDecoder().decode(combined);
    let envelope: { ok: boolean; data?: T; error?: { code?: string; message?: string } };
    try {
      envelope = JSON.parse(text) as typeof envelope;
    } catch {
      throw new SynomemError('REMOTE_PROTOCOL', 'Remote import returned invalid JSON.');
    }
    if (!response.ok || !envelope.ok || envelope.data === undefined) {
      const code =
        response.status === 401
          ? 'AUTH_REQUIRED'
          : response.status === 403
            ? 'AUTH_FORBIDDEN'
            : response.status === 409
              ? 'REVISION_CONFLICT'
              : 'REMOTE_PROTOCOL';
      throw new SynomemError(code, envelope.error?.message ?? 'Remote import failed.');
    }
    return envelope.data;
  }
}
