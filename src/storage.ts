import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  rmdirSync,
  unlinkSync,
} from 'node:fs';
import { ulid } from 'ulid';
import { basename, dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { defaultConfig, mergeConfig } from './config.js';
import type { SynomemRepository } from './ports/repository.js';
import { asSynomemError, SynomemError } from './errors.js';
import {
  assertNoSymlinkEscape,
  atomicWriteFile,
  ensureDirectory,
  readJsonFile,
} from './fs-utils.js';
import { dueInstant } from './projections.js';
import { actorSchema, eventSchema, profileSchema } from './schemas.js';
import type {
  ActorIdentity,
  SynomemConfig,
  SynomemConfigOverrides,
  AgentProfile,
  AgentRuntimeBinding,
  ChangePage,
  PostAcknowledgment,
  PostRoster,
  JsonValue,
  KudosChange,
  SynomemEvent,
  ItemChange,
  ItemListInput,
  ItemSummary,
  RecordKind,
  KudosListInput,
  KudosSummary,
  Page,
} from './types.js';

interface EventRow {
  id: string;
  payload: string;
  sequence?: number;
}

interface CurrentRow {
  kudos_id: string;
  given_sequence: number;
  created_at: string;
  recipient_agent_id: string;
  recipient_display_name: string;
  actor_kind: ActorIdentity['kind'];
  actor_id: string;
  actor_display_name: string | null;
  title: string;
  tags_json: string;
  visibility: KudosSummary['visibility'];
  status: KudosSummary['status'];
  revocation_status: KudosSummary['revocationStatus'];
  updated_sequence: number;
}

interface ItemRow {
  item_id: string;
  kind: RecordKind;
  created_sequence: number;
  updated_sequence: number;
  created_at: string;
  updated_at: string;
  actor_kind: ActorIdentity['kind'];
  actor_id: string;
  actor_display_name: string | null;
  title: string;
  tags_json: string;
  visibility: ItemSummary['visibility'];
  status: string;
  recipient_agent_id: string | null;
  recipient_display_name: string | null;
  owner_agent_id: string | null;
  owner_display_name: string | null;
  assignee_agent_id: string | null;
  assignee_display_name: string | null;
}

export interface EventScan {
  events: SynomemEvent[];
  invalid: Array<{ id: string; error: SynomemError }>;
}

interface ProfileRow {
  profile_json: string;
}

const migrationV1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  profile_json TEXT NOT NULL CHECK (json_valid(profile_json)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE IF NOT EXISTS aliases (
  alias TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT
) STRICT;

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL,
  type TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  recipient_agent_id TEXT,
  kudos_id TEXT,
  visibility TEXT,
  idempotency_key TEXT,
  payload TEXT NOT NULL CHECK (json_valid(payload))
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS events_actor_idempotency
ON events(actor_kind, actor_id, idempotency_key)
WHERE type = 'kudos.given' AND idempotency_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS events_type_created ON events(type, created_at, id);
CREATE INDEX IF NOT EXISTS events_recipient ON events(recipient_agent_id, created_at, id);
CREATE INDEX IF NOT EXISTS events_kudos_id ON events(kudos_id, created_at, id);

CREATE TABLE IF NOT EXISTS projection_manifest (
  path TEXT PRIMARY KEY,
  generated_at TEXT NOT NULL
) STRICT;

CREATE TRIGGER IF NOT EXISTS events_append_only_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TRIGGER IF NOT EXISTS events_append_only_delete
BEFORE DELETE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;
`;

const migrationV2 = `
DROP TRIGGER IF EXISTS events_append_only_update;
ALTER TABLE events ADD COLUMN sequence INTEGER;
UPDATE events SET sequence = rowid;
CREATE UNIQUE INDEX events_sequence ON events(sequence);
CREATE TRIGGER events_sequence_required
BEFORE INSERT ON events WHEN NEW.sequence IS NULL BEGIN
  SELECT RAISE(ABORT, 'events require an ingestion sequence');
END;
CREATE TRIGGER events_append_only_update
BEFORE UPDATE ON events BEGIN
  SELECT RAISE(ABORT, 'events are append-only');
END;

CREATE TABLE kudos_current (
  kudos_id TEXT PRIMARY KEY,
  given_sequence INTEGER NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  recipient_agent_id TEXT NOT NULL,
  recipient_display_name TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  visibility TEXT NOT NULL,
  status TEXT NOT NULL,
  revocation_status TEXT NOT NULL,
  updated_sequence INTEGER NOT NULL
) STRICT;
CREATE INDEX kudos_current_recipient ON kudos_current(recipient_agent_id, given_sequence DESC);
CREATE INDEX kudos_current_actor ON kudos_current(actor_kind, actor_id, given_sequence DESC);
CREATE INDEX kudos_current_status ON kudos_current(status, revocation_status, given_sequence DESC);
`;

/**
 * v4 records a task's or todo's deadline on the item index.
 *
 * The plan asks for "accepted Tasks past their due date" as a bounded query.
 * Answering that from the event log means replaying every task on every call,
 * so the deadline is projected alongside the rest of the summary. It is stored
 * as an ISO instant: a date-only due date resolves to the end of that day, so
 * "overdue" means the day has actually passed rather than merely started.
 */
const migrationV4 = `
ALTER TABLE items_current ADD COLUMN due_at TEXT;
CREATE INDEX items_current_due ON items_current(kind, status, due_at);
`;

/**
 * v5 makes alias lookup case-insensitive and unambiguous.
 *
 * The plan requires that `mycroft`, `Mycroft` and `Mike` may all resolve to one
 * canonical agent, while a name two agents both claim must return candidates
 * rather than guessing. A normalized column with a unique index enforces the
 * second half at write time: the collision is refused when the alias is added,
 * not discovered later by whoever happens to look it up first.
 *
 * Runtime bindings arrive here too. An agent is not one harness forever —
 * Mycroft may run Hermes on two machines, or move between harnesses — so the
 * binding is its own row keyed by agent, installation, runtime and profile
 * rather than a field on the agent.
 */
const migrationV5 = `
ALTER TABLE aliases ADD COLUMN normalized_alias TEXT;
UPDATE aliases SET normalized_alias = lower(alias);
CREATE UNIQUE INDEX aliases_normalized ON aliases(normalized_alias);

CREATE TABLE agent_runtime_bindings (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  installation_id TEXT,
  runtime TEXT NOT NULL,
  profile TEXT,
  capabilities_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(capabilities_json)),
  bound_at TEXT NOT NULL,
  last_seen_at TEXT
) STRICT;
CREATE UNIQUE INDEX agent_runtime_bindings_unique
  ON agent_runtime_bindings(agent_id, runtime, COALESCE(profile, ''), COALESCE(installation_id, ''));
CREATE INDEX agent_runtime_bindings_agent ON agent_runtime_bindings(agent_id);
`;

const migrationV6 = `
-- Acknowledgements are their own rows rather than a column on the post: many
-- actors acknowledge one post independently, and the interesting question is
-- who, not how many.
CREATE TABLE post_acknowledgments (
  post_id TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  note TEXT,
  acknowledged_at TEXT NOT NULL,
  PRIMARY KEY (post_id, actor_kind, actor_id)
) STRICT;
CREATE INDEX post_acknowledgments_post ON post_acknowledgments(post_id);
`;

const migrationV7 = `
-- Opaque canonical IDs, with the handle as a separate mutable name.
--
-- Existing agents keep their name-shaped ID and take it as their handle too.
-- Rewriting the actor ID inside stored events to tidy the format would be
-- exactly the rewrite an append-only log exists to prevent, so history stays
-- as written and only NEW agents get a generated opaque ID.
ALTER TABLE agents ADD COLUMN handle TEXT;
UPDATE agents SET handle = id WHERE handle IS NULL;
CREATE UNIQUE INDEX agents_handle ON agents(handle);

-- Archived agents keep their records and stop being able to act.
ALTER TABLE agents ADD COLUMN status TEXT NOT NULL DEFAULT 'active';
`;

const migrationV3 = `
DROP TRIGGER IF EXISTS events_append_only_update;
DROP TRIGGER IF EXISTS events_append_only_delete;
ALTER TABLE events ADD COLUMN workspace_id TEXT NOT NULL DEFAULT 'legacy-local';
ALTER TABLE events ADD COLUMN aggregate_id TEXT;
ALTER TABLE events ADD COLUMN aggregate_version INTEGER;
ALTER TABLE events ADD COLUMN item_kind TEXT;

UPDATE events SET aggregate_id = CASE
  WHEN type IN ('kudos.acknowledged', 'kudos.revoked') THEN kudos_id
  WHEN type = 'kudos.given' THEN id
  WHEN type = 'agent.created' THEN json_extract(payload, '$.agent.id')
  WHEN type = 'agent.updated' THEN json_extract(payload, '$.agentId')
  ELSE id END;
WITH ranked AS (
  SELECT id, ROW_NUMBER() OVER (
    PARTITION BY workspace_id, aggregate_id ORDER BY sequence
  ) AS version
  FROM events
)
UPDATE events SET aggregate_version = (
  SELECT version FROM ranked WHERE ranked.id = events.id
);
UPDATE events SET item_kind = 'kudos' WHERE type LIKE 'kudos.%';

DROP INDEX IF EXISTS events_actor_idempotency;
CREATE UNIQUE INDEX events_actor_idempotency
ON events(actor_kind, actor_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;
CREATE INDEX events_workspace_sequence ON events(workspace_id, sequence);
CREATE INDEX events_aggregate ON events(workspace_id, aggregate_id, sequence);
CREATE UNIQUE INDEX events_aggregate_version
ON events(workspace_id, aggregate_id, aggregate_version);
CREATE INDEX events_item_kind ON events(item_kind, sequence);

CREATE TABLE items_current (
  item_id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  created_sequence INTEGER NOT NULL UNIQUE,
  updated_sequence INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  actor_kind TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  actor_display_name TEXT,
  title TEXT NOT NULL,
  tags_json TEXT NOT NULL CHECK (json_valid(tags_json)),
  visibility TEXT NOT NULL,
  status TEXT NOT NULL,
  recipient_agent_id TEXT,
  recipient_display_name TEXT,
  owner_agent_id TEXT,
  owner_display_name TEXT,
  assignee_agent_id TEXT,
  assignee_display_name TEXT
) STRICT;
CREATE INDEX items_current_kind_sequence ON items_current(kind, created_sequence DESC);
CREATE INDEX items_current_recipient ON items_current(recipient_agent_id, created_sequence DESC);
CREATE INDEX items_current_owner ON items_current(owner_agent_id, created_sequence DESC);
CREATE INDEX items_current_assignee ON items_current(assignee_agent_id, created_sequence DESC);
CREATE INDEX items_current_status ON items_current(kind, status, created_sequence DESC);

CREATE TRIGGER events_append_only_update
BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_append_only_delete
BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
`;

const CONTEXT_BUDGET_BYTES = 24_576;

function encodeCursor(kind: 'list' | 'items' | 'change', sequence: number): string {
  return Buffer.from(JSON.stringify({ v: 1, kind, sequence }), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, kind: 'list' | 'items' | 'change'): number {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as {
      v?: unknown;
      kind?: unknown;
      sequence?: unknown;
    };
    if (
      value.v !== 1 ||
      value.kind !== kind ||
      typeof value.sequence !== 'number' ||
      !Number.isSafeInteger(value.sequence) ||
      value.sequence < 0
    ) {
      throw new Error('invalid cursor');
    }
    return value.sequence;
  } catch {
    throw new SynomemError('INVALID_INPUT', `Invalid ${kind} cursor.`);
  }
}

function itemSummaryFromRow(row: ItemRow): ItemSummary {
  return {
    id: row.item_id,
    kind: row.kind,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      ...(row.actor_display_name ? { displayName: row.actor_display_name } : {}),
    },
    title: row.title,
    tags: JSON.parse(row.tags_json) as string[],
    visibility: row.visibility,
    status: row.status,
    ...(row.recipient_agent_id ? { recipientAgentId: row.recipient_agent_id } : {}),
    ...(row.owner_agent_id ? { ownerAgentId: row.owner_agent_id } : {}),
    ...(row.assignee_agent_id ? { assigneeAgentId: row.assignee_agent_id } : {}),
  };
}

/**
 * Resolves a due value to a comparable instant.
 *
 * A date-only deadline resolves to the END of that day, so "overdue" means the
 * day has passed rather than merely begun. Treating 2026-09-15 as midnight
 * would report a task due today as already late.
 */
function eventKind(event: SynomemEvent): RecordKind | undefined {
  if (event.type.startsWith('kudos.')) return 'kudos';
  if (event.type.startsWith('memo.')) return 'memo';
  if (event.type.startsWith('note.')) return 'note';
  if (event.type.startsWith('post.')) return 'post';
  if (event.type.startsWith('task.')) return 'task';
  if (event.type.startsWith('todo.')) return 'todo';
  return undefined;
}

function summaryFromRow(row: CurrentRow): KudosSummary {
  return {
    id: row.kudos_id,
    kind: 'kudos',
    createdAt: row.created_at,
    updatedAt: row.created_at,
    recipientAgentId: row.recipient_agent_id,
    recipientDisplayName: row.recipient_display_name,
    actor: {
      kind: row.actor_kind,
      id: row.actor_id,
      ...(row.actor_display_name ? { displayName: row.actor_display_name } : {}),
    },
    title: row.title,
    tags: JSON.parse(row.tags_json) as string[],
    visibility: row.visibility,
    status: row.status,
    revocationStatus: row.revocation_status,
  };
}

export interface StorageOptions {
  home: string;
  readOnly: boolean;
  config?: SynomemConfigOverrides;
}

export class SynomemStorage implements SynomemRepository {
  readonly home: string;
  readonly storageDirectory: string;
  readonly databasePath: string;
  readonly configPath: string;
  readonly readOnly: boolean;
  config: SynomemConfig = defaultConfig;
  private database?: DatabaseSync;
  private readonly configOverrides?: SynomemConfigOverrides;
  private validatedEventSequence = 0;
  private transactionTail: Promise<void> = Promise.resolve();

  constructor(options: StorageOptions) {
    this.home = resolve(options.home);
    this.storageDirectory = join(this.home, 'synomem');
    this.databasePath = join(this.storageDirectory, 'synomem.sqlite3');
    this.configPath = join(this.storageDirectory, 'config.json');
    this.readOnly = options.readOnly;
    this.configOverrides = options.config;
  }

  init(): void {
    try {
      if (this.configOverrides?.backend?.kind === 'remote') {
        throw new SynomemError(
          'CONFIG_INVALID',
          'SynomemClient supports only the local backend. Use RemoteSynomemService for remote workspaces.',
        );
      }
      if (!existsSync(this.home)) {
        if (this.readOnly) throw new SynomemError('READ_ONLY', 'Storage home does not exist.');
        mkdirSync(this.home, { recursive: true, mode: 0o700 });
      }
      if (lstatSync(this.home).isSymbolicLink()) {
        throw new SynomemError(
          'UNSAFE_PATH',
          'The configured Synomem home cannot be a symbolic link.',
        );
      }
      if (!this.readOnly) ensureDirectory(this.storageDirectory);
      assertNoSymlinkEscape(this.home, this.storageDirectory);
      if (!this.readOnly) {
        chmodSync(this.storageDirectory, 0o700);
      }

      const fileConfig = existsSync(this.configPath) ? readJsonFile(this.configPath) : undefined;
      const initialConfig = fileConfig ?? { ...defaultConfig, workspaceId: ulid() };
      this.config = mergeConfig(initialConfig, this.configOverrides);
      if (this.config.backend.kind !== 'local') {
        throw new SynomemError(
          'CONFIG_INVALID',
          'SynomemClient supports only the local backend. Use RemoteSynomemService for remote workspaces.',
        );
      }
      if (this.readOnly && !existsSync(this.databasePath)) {
        throw new SynomemError(
          'READ_ONLY',
          'The Synomem database does not exist in read-only mode.',
        );
      }
      if (!this.readOnly && !existsSync(this.databasePath)) {
        closeSync(openSync(this.databasePath, 'wx', 0o600));
      }
      if (!this.readOnly && !existsSync(this.configPath)) {
        atomicWriteFile(this.configPath, `${JSON.stringify(this.config, null, 2)}\n`);
      } else if (
        !this.readOnly &&
        typeof fileConfig === 'object' &&
        fileConfig !== null &&
        (fileConfig as { schemaVersion?: unknown }).schemaVersion === 2
      ) {
        const migrated = mergeConfig(fileConfig, undefined, {});
        atomicWriteFile(this.configPath, `${JSON.stringify(migrated, null, 2)}\n`);
      }

      this.database = new DatabaseSync(this.databasePath, {
        readOnly: this.readOnly,
        enableForeignKeyConstraints: true,
      });
      this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
      if (!this.readOnly) {
        this.database.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
        this.migrate();
        this.restrictDatabaseFiles();
      } else {
        this.assertSchemaSupported();
      }
    } catch (error) {
      this.close();
      if (error instanceof SynomemError) throw error;
      if (error instanceof SyntaxError) {
        throw new SynomemError('CONFIG_INVALID', 'Could not parse synomem/config.json.');
      }
      throw asSynomemError(error);
    }
  }

  private migrate(): void {
    const db = this.db();
    const version = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (version > 7) {
      throw new SynomemError(
        'UNSUPPORTED_SCHEMA',
        `Database schema version ${version} is newer than this package supports.`,
      );
    }
    if (version === 0) {
      this.transactionSync(() => {
        db.exec(migrationV1);
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(1, new Date().toISOString());
        db.exec('PRAGMA user_version = 1');
      });
    }
    const currentVersion = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (currentVersion === 1) {
      this.transactionSync(() => {
        db.exec(migrationV2);
        this.rebuildKudosCurrentIndex();
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(2, new Date().toISOString());
        db.exec('PRAGMA user_version = 2');
      });
    }
    const afterV2 = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (afterV2 === 2) {
      this.transactionSync(() => {
        db.exec(migrationV3);
        // The item index is left empty here and populated by v4, which adds the
        // due-date column the projection writes. Rebuilding before that column
        // exists fails on the first task.
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(3, new Date().toISOString());
        db.exec('PRAGMA user_version = 3');
      });
    }
    const afterV3 = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (afterV3 === 3) {
      this.transactionSync(() => {
        db.exec(migrationV4);
        this.rebuildItemsCurrentIndex();
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(4, new Date().toISOString());
        db.exec('PRAGMA user_version = 4');
      });
    }
    const afterV4 = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (afterV4 === 4) {
      this.transactionSync(() => {
        db.exec(migrationV5);
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(5, new Date().toISOString());
        db.exec('PRAGMA user_version = 5');
      });
    }
    const afterV5 = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (afterV5 === 5) {
      this.transactionSync(() => {
        db.exec(migrationV6);
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(6, new Date().toISOString());
        db.exec('PRAGMA user_version = 6');
      });
    }
    const afterV6 = Number(
      (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (afterV6 === 6) {
      this.transactionSync(() => {
        db.exec(migrationV7);
        db.prepare(
          'INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (?, ?)',
        ).run(7, new Date().toISOString());
        db.exec('PRAGMA user_version = 7');
      });
    }
  }

  private assertSchemaSupported(): void {
    const version = Number(
      (this.db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    if (version !== 7) {
      if (version >= 1 && version <= 6) {
        throw new SynomemError(
          'UNSUPPORTED_SCHEMA',
          `Database schema version ${version} requires migration. Open this home once with readOnly: false, then retry the read-only client.`,
        );
      }
      throw new SynomemError(
        'UNSUPPORTED_SCHEMA',
        `Expected database schema version 5; found ${version}.`,
      );
    }
  }

  db(): DatabaseSync {
    if (!this.database)
      throw new SynomemError('INTERNAL_ERROR', 'SynomemClient.init() has not completed.');
    return this.database;
  }

  assertWritable(): void {
    if (this.readOnly) throw new SynomemError('READ_ONLY', 'This Synomem client is read-only.');
  }

  transaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const execute = async (): Promise<T> => {
      this.assertWritable();
      const db = this.db();
      let began = false;
      try {
        db.exec('BEGIN IMMEDIATE');
        began = true;
        const result = await operation();
        db.exec('COMMIT');
        began = false;
        this.restrictDatabaseFiles();
        return result;
      } catch (error) {
        if (began) {
          try {
            db.exec('ROLLBACK');
          } catch {
            // Preserve the original failure.
          }
        }
        throw asSynomemError(error);
      }
    };
    const result = this.transactionTail.then(execute, execute);
    this.transactionTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  transactionSync<T>(operation: () => T): T {
    this.assertWritable();
    const db = this.db();
    let began = false;
    try {
      db.exec('BEGIN IMMEDIATE');
      began = true;
      const result = operation();
      db.exec('COMMIT');
      began = false;
      this.restrictDatabaseFiles();
      return result;
    } catch (error) {
      if (began) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // Preserve the original failure.
        }
      }
      throw asSynomemError(error);
    }
  }

  insertEvent(event: SynomemEvent): void {
    const parsed = eventSchema.parse(event);
    const recipientAgentId =
      parsed.type === 'kudos.given' ||
      parsed.type === 'kudos.acknowledged' ||
      parsed.type === 'memo.sent' ||
      parsed.type === 'memo.read' ||
      parsed.type === 'memo.archived'
        ? parsed.recipientAgentId
        : null;
    const kudosId =
      parsed.type === 'kudos.acknowledged' || parsed.type === 'kudos.revoked'
        ? parsed.kudosId
        : null;
    const visibility = 'visibility' in parsed ? parsed.visibility : null;
    const idempotencyKey = parsed.idempotencyKey ?? null;
    const kind = eventKind(parsed) ?? null;
    const sequence = Number(
      (
        this.db().prepare('SELECT COALESCE(MAX(sequence), 0) + 1 AS next FROM events').get() as {
          next: number;
        }
      ).next,
    );
    this.db()
      .prepare(
        `INSERT INTO events(
          id, schema_version, type, created_at, actor_kind, actor_id,
          recipient_agent_id, kudos_id, visibility, idempotency_key, payload, sequence,
          workspace_id, aggregate_id, aggregate_version, item_kind
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.schemaVersion,
        parsed.type,
        parsed.createdAt,
        parsed.actor.kind,
        parsed.actor.id,
        recipientAgentId,
        kudosId,
        visibility,
        idempotencyKey,
        JSON.stringify(parsed),
        sequence,
        parsed.workspaceId,
        parsed.aggregateId,
        parsed.aggregateVersion,
        kind,
      );
    this.applyEventToCurrent(parsed, sequence);
    this.applyEventToItems(parsed, sequence);
  }

  private applyEventToCurrent(event: SynomemEvent, sequence: number): void {
    if (event.type === 'kudos.given') {
      this.db()
        .prepare(
          `INSERT INTO kudos_current(
            kudos_id, given_sequence, created_at, recipient_agent_id, recipient_display_name,
            actor_kind, actor_id, actor_display_name, title, tags_json, visibility,
            status, revocation_status, updated_sequence
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unacknowledged', 'active', ?)`,
        )
        .run(
          event.id,
          sequence,
          event.createdAt,
          event.recipientAgentId,
          event.recipientDisplayName,
          event.actor.kind,
          event.actor.id,
          event.actor.displayName ?? null,
          event.title,
          JSON.stringify(event.tags ?? []),
          event.visibility,
          sequence,
        );
    } else if (event.type === 'kudos.acknowledged') {
      this.db()
        .prepare(
          "UPDATE kudos_current SET status = 'acknowledged', updated_sequence = ? WHERE kudos_id = ?",
        )
        .run(sequence, event.kudosId);
    } else if (event.type === 'kudos.revoked') {
      this.db()
        .prepare(
          "UPDATE kudos_current SET revocation_status = 'revoked', updated_sequence = ? WHERE kudos_id = ?",
        )
        .run(sequence, event.kudosId);
    }
  }

  private applyEventToItems(event: SynomemEvent, sequence: number): void {
    const insert = (values: {
      kind: RecordKind;
      title: string;
      tags?: string[];
      visibility: ItemSummary['visibility'];
      status: string;
      recipientAgentId?: string;
      recipientDisplayName?: string;
      ownerAgentId?: string;
      ownerDisplayName?: string;
      assigneeAgentId?: string;
      assigneeDisplayName?: string;
      dueAt?: string;
    }): void => {
      this.db()
        .prepare(
          `INSERT INTO items_current(
          item_id, kind, created_sequence, updated_sequence, created_at, updated_at,
          actor_kind, actor_id, actor_display_name, title, tags_json, visibility, status,
          recipient_agent_id, recipient_display_name, owner_agent_id, owner_display_name,
          assignee_agent_id, assignee_display_name, due_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          event.aggregateId,
          values.kind,
          sequence,
          sequence,
          event.createdAt,
          event.createdAt,
          event.actor.kind,
          event.actor.id,
          event.actor.displayName ?? null,
          values.title,
          JSON.stringify(values.tags ?? []),
          values.visibility,
          values.status,
          values.recipientAgentId ?? null,
          values.recipientDisplayName ?? null,
          values.ownerAgentId ?? null,
          values.ownerDisplayName ?? null,
          values.assigneeAgentId ?? null,
          values.assigneeDisplayName ?? null,
          values.dueAt ?? null,
        );
    };
    const updateStatus = (status: string): void => {
      this.db()
        .prepare(
          'UPDATE items_current SET status = ?, updated_sequence = ?, updated_at = ? WHERE item_id = ?',
        )
        .run(status, sequence, event.createdAt, event.aggregateId);
    };

    if (event.type === 'kudos.given') {
      insert({
        kind: 'kudos',
        title: event.title,
        tags: event.tags,
        visibility: event.visibility,
        status: 'unacknowledged',
        recipientAgentId: event.recipientAgentId,
        recipientDisplayName: event.recipientDisplayName,
      });
    } else if (event.type === 'kudos.acknowledged') updateStatus('acknowledged');
    else if (event.type === 'kudos.revoked') updateStatus('revoked');
    else if (event.type === 'memo.sent') {
      insert({
        kind: 'memo',
        title: event.subject,
        tags: event.tags,
        visibility: event.visibility,
        status: 'unread',
        recipientAgentId: event.recipientAgentId,
        recipientDisplayName: event.recipientDisplayName,
      });
    } else if (event.type === 'memo.read') updateStatus('read');
    else if (event.type === 'memo.archived') updateStatus('archived');
    else if (event.type === 'note.created') {
      insert({
        kind: 'note',
        title: event.title,
        tags: event.tags,
        visibility: event.visibility,
        status: 'active',
        ownerAgentId: event.ownerAgentId,
        ownerDisplayName: event.ownerDisplayName,
      });
    } else if (event.type === 'post.created') {
      /*
       * A post is addressed to the workspace, so it is recorded as `workspace`
       * visibility rather than carrying a visibility of its own. There is no
       * owner-scoped or recipient-scoped read filter to apply: everyone who can
       * read the workspace can read it, which is the whole point of the domain.
       */
      insert({
        kind: 'post',
        title: event.title,
        tags: event.tags,
        visibility: 'workspace',
        status: 'active',
      });
    } else if (event.type === 'post.edited') {
      this.db()
        .prepare(
          `UPDATE items_current SET title = ?, tags_json = ?,
         updated_sequence = ?, updated_at = ? WHERE item_id = ?`,
        )
        .run(
          event.title,
          JSON.stringify(event.tags ?? []),
          sequence,
          event.createdAt,
          event.postId,
        );
    } else if (event.type === 'post.archived') {
      updateStatus('archived');
    } else if (event.type === 'post.acknowledged') {
      // One row per actor per post: acknowledging twice is the same statement,
      // not a second one.
      this.db()
        .prepare(
          `INSERT INTO post_acknowledgments
             (post_id, actor_kind, actor_id, actor_display_name, note, acknowledged_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(post_id, actor_kind, actor_id) DO UPDATE SET
             note = excluded.note,
             acknowledged_at = excluded.acknowledged_at`,
        )
        .run(
          event.postId,
          event.actor.kind,
          event.actor.id,
          event.actor.displayName ?? null,
          event.note ?? null,
          event.createdAt,
        );
    } else if (event.type === 'post.acknowledgment.withdrawn') {
      this.db()
        .prepare(
          'DELETE FROM post_acknowledgments WHERE post_id = ? AND actor_kind = ? AND actor_id = ?',
        )
        .run(event.postId, event.actor.kind, event.actor.id);
    } else if (event.type === 'note.revised') {
      this.db()
        .prepare(
          `UPDATE items_current SET title = ?, tags_json = ?, visibility = ?,
         updated_sequence = ?, updated_at = ? WHERE item_id = ?`,
        )
        .run(
          event.title,
          JSON.stringify(event.tags ?? []),
          event.visibility,
          sequence,
          event.createdAt,
          event.aggregateId,
        );
    } else if (event.type === 'note.archived') updateStatus('archived');
    else if (event.type === 'task.created') {
      insert({
        kind: 'task',
        title: event.title,
        tags: event.tags,
        visibility: event.visibility,
        status: event.requiresAcceptance ? 'assigned' : 'open',
        assigneeAgentId: event.assigneeAgentId,
        assigneeDisplayName: event.assigneeDisplayName,
        ...((due) => (due ? { dueAt: due } : {}))(dueInstant(event.due)),
      });
    } else if (event.type === 'task.updated') {
      this.db()
        .prepare(
          `UPDATE items_current SET title = ?, tags_json = ?, visibility = ?, due_at = ?,
         updated_sequence = ?, updated_at = ? WHERE item_id = ?`,
        )
        .run(
          event.title,
          JSON.stringify(event.tags ?? []),
          event.visibility,
          dueInstant(event.due) ?? null,
          sequence,
          event.createdAt,
          event.aggregateId,
        );
    } else if (event.type === 'task.accepted') updateStatus('open');
    else if (event.type === 'task.rejected') updateStatus('rejected');
    else if (event.type === 'task.completed') updateStatus('completed');
    else if (event.type === 'task.reopened') updateStatus('open');
    else if (event.type === 'task.canceled') updateStatus('canceled');
    else if (event.type === 'todo.created') {
      // A Todo's owner IS its author, and it is always private. Recording the
      // owner explicitly rather than inferring it from the actor keeps the
      // owner-scoped read filters uniform across notes and todos.
      insert({
        kind: 'todo',
        title: event.title,
        tags: event.tags,
        visibility: 'private',
        status: 'open',
        ownerAgentId: event.actor.id,
        ...(event.actor.displayName ? { ownerDisplayName: event.actor.displayName } : {}),
        ...((due) => (due ? { dueAt: due } : {}))(dueInstant(event.due)),
      });
    } else if (event.type === 'todo.updated') {
      this.db()
        .prepare(
          `UPDATE items_current SET title = ?, tags_json = ?, due_at = ?,
         updated_sequence = ?, updated_at = ? WHERE item_id = ?`,
        )
        .run(
          event.title,
          JSON.stringify(event.tags ?? []),
          dueInstant(event.due) ?? null,
          sequence,
          event.createdAt,
          event.aggregateId,
        );
    } else if (event.type === 'todo.completed') updateStatus('completed');
    else if (event.type === 'todo.reopened') updateStatus('open');
    else if (event.type === 'todo.canceled') updateStatus('canceled');
    else if (event.type === 'todo.archived') updateStatus('archived');
  }

  rebuildItemsCurrentIndex(): void {
    this.db().prepare('DELETE FROM items_current').run();
    const rows = this.db()
      .prepare('SELECT id, payload, sequence FROM events ORDER BY sequence ASC')
      .all() as unknown as Array<EventRow & { sequence: number }>;
    for (const row of rows) {
      try {
        this.applyEventToItems(this.parseEvent(row), row.sequence);
      } catch (error) {
        if (!(error instanceof SynomemError)) throw error;
      }
    }
  }

  rebuildKudosCurrentIndex(): void {
    this.db().prepare('DELETE FROM kudos_current').run();
    const rows = this.db()
      .prepare('SELECT id, payload, sequence FROM events ORDER BY sequence ASC')
      .all() as unknown as Array<EventRow & { sequence: number }>;
    for (const row of rows) {
      try {
        this.applyEventToCurrent(this.parseEvent(row), row.sequence);
      } catch (error) {
        if (!(error instanceof SynomemError)) throw error;
      }
    }
  }

  nextAggregateVersion(aggregateId: string): number {
    return Number(
      (
        this.db()
          .prepare(
            'SELECT COALESCE(MAX(aggregate_version), 0) + 1 AS next FROM events WHERE workspace_id = ? AND aggregate_id = ?',
          )
          .get(this.config.workspaceId, aggregateId) as { next: number }
      ).next,
    );
  }

  listKudosSummaries(
    input: Required<Pick<KudosListInput, 'limit' | 'offset'>> & KudosListInput,
    viewer: ActorIdentity,
  ): Page<KudosSummary> {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    const add = (clause: string, ...values: Array<string | number>): void => {
      where.push(clause);
      parameters.push(...values);
    };

    if (input.recipientAgentId) add('recipient_agent_id = ?', input.recipientAgentId);
    if (input.actorId) add('actor_id = ?', input.actorId);
    if (input.actorKind) add('actor_kind = ?', input.actorKind);
    if (input.tag) add('EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?)', input.tag);
    if (input.status) add('status = ?', input.status);
    if (input.visibility) add('visibility = ?', input.visibility);
    if (input.revoked !== undefined) {
      add('revocation_status = ?', input.revoked ? 'revoked' : 'active');
    }
    if (input.from) add('created_at >= ?', input.from);
    if (input.to) add('created_at <= ?', input.to);
    if (viewer.kind !== 'human') {
      if (viewer.kind === 'agent') {
        add(
          `(visibility != 'private' OR recipient_agent_id = ? OR
            (actor_kind = ? AND actor_id = ?))`,
          viewer.id,
          viewer.kind,
          viewer.id,
        );
      } else {
        add(
          `(visibility != 'private' OR (actor_kind = ? AND actor_id = ?))`,
          viewer.kind,
          viewer.id,
        );
      }
    }

    const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (
        this.db()
          .prepare(`SELECT COUNT(*) AS count FROM kudos_current ${baseWhere}`)
          .get(...parameters) as { count: number }
      ).count,
    );
    const cursorSequence = input.cursor ? decodeCursor(input.cursor, 'list') : undefined;
    const pageWhere = [...where];
    const pageParameters = [...parameters];
    if (cursorSequence !== undefined) {
      pageWhere.push('given_sequence < ?');
      pageParameters.push(cursorSequence);
    }
    const sqlWhere = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
    const offset = cursorSequence === undefined ? input.offset : 0;
    const rows = this.db()
      .prepare(
        `SELECT * FROM kudos_current ${sqlWhere}
         ORDER BY given_sequence DESC LIMIT ? OFFSET ?`,
      )
      .all(...pageParameters, input.limit + 1, offset) as unknown as CurrentRow[];

    const items: KudosSummary[] = [];
    let bytes = 2;
    let contextLimited = false;
    for (const row of rows.slice(0, input.limit)) {
      const item = summaryFromRow(row);
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (items.length > 0 && bytes + itemBytes > CONTEXT_BUDGET_BYTES) {
        contextLimited = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
    }
    const hasMore = contextLimited || rows.length > items.length;
    const last = items.at(-1);
    const lastRow = last ? rows[items.length - 1] : undefined;
    const watermark = encodeCursor('change', this.maxEventSequence());
    return {
      items,
      total,
      limit: input.limit,
      offset,
      ...(hasMore && lastRow ? { nextCursor: encodeCursor('list', lastRow.given_sequence) } : {}),
      hasMore,
      watermark,
      contextLimited,
    };
  }

  listKudosChanges(after: string | undefined, limit: number, viewer: ActorIdentity): ChangePage {
    const afterSequence = after ? decodeCursor(after, 'change') : 0;
    const highWatermark = this.maxEventSequence();
    const privacy =
      viewer.kind === 'human'
        ? ''
        : viewer.kind === 'agent'
          ? `AND (k.visibility != 'private' OR k.recipient_agent_id = ? OR
            (k.actor_kind = ? AND k.actor_id = ?))`
          : `AND (k.visibility != 'private' OR (k.actor_kind = ? AND k.actor_id = ?))`;
    const parameters: Array<string | number> = [afterSequence, highWatermark];
    if (viewer.kind === 'agent') parameters.push(viewer.id, viewer.kind, viewer.id);
    else if (viewer.kind === 'system') parameters.push(viewer.kind, viewer.id);
    parameters.push(limit + 1);
    const rows = this.db()
      .prepare(
        `SELECT e.id AS event_id, e.sequence, e.type, e.created_at AS event_created_at, e.payload, k.*
         FROM events e
         JOIN kudos_current k ON k.kudos_id = CASE
           WHEN e.type = 'kudos.given' THEN e.id ELSE e.kudos_id END
         WHERE e.sequence > ? AND e.sequence <= ?
           AND e.type IN ('kudos.given', 'kudos.acknowledged', 'kudos.revoked')
           ${privacy}
         ORDER BY e.sequence ASC LIMIT ?`,
      )
      .all(...parameters) as unknown as Array<
      CurrentRow &
        EventRow & {
          event_id: string;
          event_created_at: string;
          type: KudosChange['type'];
        }
    >;

    const items: KudosChange[] = [];
    let bytes = 2;
    let contextLimited = false;
    let consumed = 0;
    let lastConsumedSequence = afterSequence;
    for (const row of rows.slice(0, limit)) {
      const sequence = Number(row.sequence);
      let actor: ActorIdentity;
      try {
        const payload = JSON.parse(row.payload) as { actor: ActorIdentity };
        actor = actorSchema.parse(payload.actor);
      } catch {
        consumed += 1;
        lastConsumedSequence = sequence;
        continue;
      }
      const item: KudosChange = {
        cursor: encodeCursor('change', sequence),
        sequence,
        eventId: row.event_id,
        type: row.type,
        createdAt: row.event_created_at,
        actor,
        kudosId: row.kudos_id,
        recipientAgentId: row.recipient_agent_id,
        summary: summaryFromRow(row),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (items.length > 0 && bytes + itemBytes > CONTEXT_BUDGET_BYTES) {
        contextLimited = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
      consumed += 1;
      lastConsumedSequence = sequence;
    }
    const hasMore = contextLimited || rows.length > consumed;
    const nextCursor = encodeCursor('change', hasMore ? lastConsumedSequence : highWatermark);
    return {
      items,
      limit,
      nextCursor,
      hasMore,
      watermark: encodeCursor('change', highWatermark),
      contextLimited,
    };
  }

  listItemSummaries(
    input: Required<Pick<ItemListInput, 'limit' | 'offset'>> & ItemListInput,
    viewer: ActorIdentity,
  ): Page<ItemSummary> {
    const where: string[] = [];
    const parameters: Array<string | number> = [];
    const add = (clause: string, ...values: Array<string | number>): void => {
      where.push(clause);
      parameters.push(...values);
    };
    if (input.kinds?.length) {
      add(`kind IN (${input.kinds.map(() => '?').join(', ')})`, ...input.kinds);
    }
    if (input.participantAgentId) {
      add(
        '(recipient_agent_id = ? OR owner_agent_id = ? OR assignee_agent_id = ?)',
        input.participantAgentId,
        input.participantAgentId,
        input.participantAgentId,
      );
    }
    if (input.actorId) add('actor_id = ?', input.actorId);
    if (input.actorKind) add('actor_kind = ?', input.actorKind);
    if (input.tag) add('EXISTS (SELECT 1 FROM json_each(tags_json) WHERE value = ?)', input.tag);
    if (input.status) add('status = ?', input.status);
    if (input.pending) {
      add(`((kind = 'kudos' AND status = 'unacknowledged') OR
        (kind = 'memo' AND status = 'unread') OR
        (kind = 'task' AND status IN ('assigned', 'open')))`);
    }
    if (input.visibility) add('visibility = ?', input.visibility);
    if (input.from) add('created_at >= ?', input.from);
    if (input.to) add('created_at <= ?', input.to);

    // Unanswered discovery: items still waiting for somebody to respond. Kept
    // distinct from `pending`, which also counts accepted-and-in-progress work.
    if (input.awaitingResponse) {
      add(`((kind = 'kudos' AND status = 'unacknowledged') OR
        (kind = 'memo' AND status = 'unread') OR
        (kind = 'task' AND status = 'assigned'))`);
    }
    if (input.awaitingSince) add('created_at <= ?', input.awaitingSince);

    // Overdue discovery: a deadline that has passed, on work still open. A
    // completed or canceled item is not overdue, however late it was.
    if (input.overdueAsOf) {
      add(
        `(due_at IS NOT NULL AND due_at < ? AND status IN ('assigned', 'open'))`,
        input.overdueAsOf,
      );
    }

    /*
     * Private todos are owner-only for EVERY viewer, including a human.
     *
     * The visibility rules below exempt human actors, on the reasoning that a
     * person operating a local home is its operator. That does not extend to
     * todos: the plan is explicit that a todo is visible only to its owner
     * except through an explicitly authorized administrative capability, and
     * this release has no such capability. Without this clause a human actor
     * would see every agent's private reminders in an item list.
     */
    add(
      `(kind != 'todo' OR (owner_agent_id = ? AND ? = 'agent') OR (actor_id = ? AND actor_kind = ?))`,
      viewer.id,
      viewer.kind,
      viewer.id,
      viewer.kind,
    );

    if (viewer.kind !== 'human') {
      if (viewer.kind === 'agent') {
        add(
          `(visibility != 'private' OR (actor_kind = ? AND actor_id = ?) OR
          recipient_agent_id = ? OR owner_agent_id = ? OR assignee_agent_id = ?)`,
          viewer.kind,
          viewer.id,
          viewer.id,
          viewer.id,
          viewer.id,
        );
      } else {
        add(
          `(visibility != 'private' OR (actor_kind = ? AND actor_id = ?))`,
          viewer.kind,
          viewer.id,
        );
      }
    }
    const baseWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = Number(
      (
        this.db()
          .prepare(`SELECT COUNT(*) AS count FROM items_current ${baseWhere}`)
          .get(...parameters) as { count: number }
      ).count,
    );
    const cursorSequence = input.cursor ? decodeCursor(input.cursor, 'items') : undefined;
    const pageWhere = [...where];
    const pageParameters = [...parameters];
    if (cursorSequence !== undefined) {
      pageWhere.push('created_sequence < ?');
      pageParameters.push(cursorSequence);
    }
    const sqlWhere = pageWhere.length ? `WHERE ${pageWhere.join(' AND ')}` : '';
    const offset = cursorSequence === undefined ? input.offset : 0;
    const rows = this.db()
      .prepare(
        `SELECT * FROM items_current ${sqlWhere} ORDER BY created_sequence DESC LIMIT ? OFFSET ?`,
      )
      .all(...pageParameters, input.limit + 1, offset) as unknown as ItemRow[];
    const items: ItemSummary[] = [];
    let bytes = 2;
    let contextLimited = false;
    for (const row of rows.slice(0, input.limit)) {
      const item = itemSummaryFromRow(row);
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (items.length > 0 && bytes + itemBytes > CONTEXT_BUDGET_BYTES) {
        contextLimited = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
    }
    const hasMore = contextLimited || rows.length > items.length;
    const lastRow = items.length ? rows[items.length - 1] : undefined;
    return {
      items,
      total,
      limit: input.limit,
      offset,
      ...(hasMore && lastRow
        ? { nextCursor: encodeCursor('items', lastRow.created_sequence) }
        : {}),
      hasMore,
      watermark: encodeCursor('change', this.maxEventSequence()),
      contextLimited,
    };
  }

  listItemChanges(
    after: string | undefined,
    limit: number,
    viewer: ActorIdentity,
    kinds?: RecordKind[],
  ): ChangePage {
    const afterSequence = after ? decodeCursor(after, 'change') : 0;
    const highWatermark = this.maxEventSequence();
    const where = ['e.sequence > ?', 'e.sequence <= ?', 'e.item_kind IS NOT NULL'];
    const parameters: Array<string | number> = [afterSequence, highWatermark];
    if (kinds?.length) {
      where.push(`e.item_kind IN (${kinds.map(() => '?').join(', ')})`);
      parameters.push(...kinds);
    }
    if (viewer.kind !== 'human') {
      if (viewer.kind === 'agent') {
        where.push(`(i.visibility != 'private' OR (i.actor_kind = ? AND i.actor_id = ?) OR
          i.recipient_agent_id = ? OR i.owner_agent_id = ? OR i.assignee_agent_id = ?)`);
        parameters.push(viewer.kind, viewer.id, viewer.id, viewer.id, viewer.id);
      } else {
        where.push(`(i.visibility != 'private' OR (i.actor_kind = ? AND i.actor_id = ?))`);
        parameters.push(viewer.kind, viewer.id);
      }
    }
    parameters.push(limit + 1);
    const rows = this.db()
      .prepare(
        `SELECT e.id AS event_id, e.sequence, e.type, e.created_at AS event_created_at,
       e.payload, i.* FROM events e JOIN items_current i ON i.item_id = e.aggregate_id
       WHERE ${where.join(' AND ')} ORDER BY e.sequence ASC LIMIT ?`,
      )
      .all(...parameters) as unknown as Array<
      ItemRow &
        EventRow & {
          event_id: string;
          event_created_at: string;
          type: ItemChange['type'];
        }
    >;
    const items: ItemChange[] = [];
    let bytes = 2;
    let contextLimited = false;
    let consumed = 0;
    let lastConsumedSequence = afterSequence;
    for (const row of rows.slice(0, limit)) {
      const sequence = Number(row.sequence);
      let actor: ActorIdentity;
      try {
        actor = actorSchema.parse((JSON.parse(row.payload) as { actor: unknown }).actor);
      } catch {
        consumed += 1;
        lastConsumedSequence = sequence;
        continue;
      }
      const item: ItemChange = {
        cursor: encodeCursor('change', sequence),
        sequence,
        eventId: row.event_id,
        type: row.type,
        createdAt: row.event_created_at,
        actor,
        itemId: row.item_id,
        kind: row.kind,
        summary: itemSummaryFromRow(row),
      };
      const itemBytes = Buffer.byteLength(JSON.stringify(item), 'utf8') + 1;
      if (items.length > 0 && bytes + itemBytes > CONTEXT_BUDGET_BYTES) {
        contextLimited = true;
        break;
      }
      items.push(item);
      bytes += itemBytes;
      consumed += 1;
      lastConsumedSequence = sequence;
    }
    const hasMore = contextLimited || rows.length > consumed;
    return {
      items,
      limit,
      nextCursor: encodeCursor('change', hasMore ? lastConsumedSequence : highWatermark),
      hasMore,
      watermark: encodeCursor('change', highWatermark),
      contextLimited,
    };
  }

  getItemSummary(id: string): ItemSummary | undefined {
    const row = this.db()
      .prepare('SELECT * FROM items_current WHERE item_id = ?')
      .get(id) as unknown as ItemRow | undefined;
    return row ? itemSummaryFromRow(row) : undefined;
  }

  getReadableItemEvents(id: string): SynomemEvent[] {
    const rows = this.db()
      .prepare('SELECT id, payload FROM events WHERE aggregate_id = ? ORDER BY sequence ASC')
      .all(id) as unknown as EventRow[];
    const events: SynomemEvent[] = [];
    for (const row of rows) {
      try {
        events.push(this.parseEvent(row));
      } catch {
        /* detail is tolerant */
      }
    }
    return events;
  }

  currentIndexHealth(): { given: number; indexed: number; stateMismatches: number } {
    const given = Number(
      (
        this.db()
          .prepare("SELECT COUNT(*) AS count FROM events WHERE type = 'kudos.given'")
          .get() as { count: number }
      ).count,
    );
    const indexed = Number(
      (this.db().prepare('SELECT COUNT(*) AS count FROM kudos_current').get() as { count: number })
        .count,
    );
    const stateMismatches = Number(
      (
        this.db()
          .prepare(
            `SELECT COUNT(*) AS count
             FROM kudos_current k
             WHERE k.status != CASE WHEN EXISTS (
               SELECT 1 FROM events e
               WHERE e.type = 'kudos.acknowledged' AND e.kudos_id = k.kudos_id
             ) THEN 'acknowledged' ELSE 'unacknowledged' END
             OR k.revocation_status != CASE WHEN EXISTS (
               SELECT 1 FROM events e
               WHERE e.type = 'kudos.revoked' AND e.kudos_id = k.kudos_id
             ) THEN 'revoked' ELSE 'active' END`,
          )
          .get() as { count: number }
      ).count,
    );
    return { given, indexed, stateMismatches };
  }

  itemIndexHealth(): { created: number; indexed: number } {
    const created = Number(
      (
        this.db()
          .prepare(
            `SELECT COUNT(*) AS count FROM events WHERE type IN
       ('kudos.given', 'memo.sent', 'note.created', 'post.created', 'task.created')`,
          )
          .get() as { count: number }
      ).count,
    );
    const indexed = Number(
      (this.db().prepare('SELECT COUNT(*) AS count FROM items_current').get() as { count: number })
        .count,
    );
    return { created, indexed };
  }

  migrationState(): { schemaVersion: number; appliedVersions: number[] } {
    const schemaVersion = Number(
      (this.db().prepare('PRAGMA user_version').get() as { user_version: number }).user_version,
    );
    const appliedVersions = (
      this.db()
        .prepare('SELECT version FROM schema_migrations ORDER BY version')
        .all() as unknown as Array<{
        version: number;
      }>
    ).map((row) => Number(row.version));
    return { schemaVersion, appliedVersions };
  }

  /**
   * Aliases that also name an agent directly.
   *
   * Matches against the HANDLE as well as the canonical ID. With opaque IDs an
   * alias can no longer accidentally equal one, but it can easily equal another
   * agent's handle — which is the collision that actually makes a lookup
   * ambiguous now.
   */
  aliasIdentityConflicts(): Array<{ alias: string; agentId: string }> {
    return this.db()
      .prepare(
        `SELECT x.alias, x.agent_id AS agentId
         FROM aliases x
         JOIN agents a ON lower(a.id) = x.normalized_alias
                       OR lower(a.handle) = x.normalized_alias
        WHERE a.id != x.agent_id
        ORDER BY x.alias`,
      )
      .all() as unknown as Array<{ alias: string; agentId: string }>;
  }

  private maxEventSequence(): number {
    return Number(
      (
        this.db().prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events').get() as {
          sequence: number;
        }
      ).sequence,
    );
  }

  getEvent(id: string): SynomemEvent | undefined {
    const row = this.db().prepare('SELECT id, payload FROM events WHERE id = ?').get(id) as
      EventRow | undefined;
    return row ? this.parseEvent(row) : undefined;
  }

  getEventByIdempotency(actorKind: string, actorId: string, key: string): SynomemEvent | undefined {
    const row = this.db()
      .prepare(
        `SELECT id, payload FROM events
         WHERE actor_kind = ? AND actor_id = ? AND idempotency_key = ?`,
      )
      .get(actorKind, actorId, key) as EventRow | undefined;
    return row ? this.parseEvent(row) : undefined;
  }

  getEvents(): SynomemEvent[] {
    const scan = this.scanEvents();
    if (scan.invalid[0]) throw scan.invalid[0].error;
    return scan.events;
  }

  getReadableEvents(): SynomemEvent[] {
    return this.scanEvents().events;
  }

  getReadableSynomemEvents(kudosId: string): SynomemEvent[] {
    const rows = this.db()
      .prepare(
        `SELECT id, payload FROM events
         WHERE (type = 'kudos.given' AND id = ?) OR kudos_id = ?
         ORDER BY sequence ASC`,
      )
      .all(kudosId, kudosId) as unknown as EventRow[];
    const events: SynomemEvent[] = [];
    for (const row of rows) {
      try {
        events.push(this.parseEvent(row));
      } catch {
        // Detail reads remain available when an unrelated or newer row is unreadable.
      }
    }
    return events;
  }

  scanEvents(): EventScan {
    const rows = this.rawEventRows();
    const events: SynomemEvent[] = [];
    const invalid: EventScan['invalid'] = [];
    for (const row of rows) {
      try {
        events.push(this.parseEvent(row));
      } catch (error) {
        const parsed = asSynomemError(error);
        invalid.push({ id: row.id, error: parsed });
      }
    }
    return { events, invalid };
  }

  assertEventCompatibility(): void {
    const rows = this.db()
      .prepare('SELECT id, payload, sequence FROM events WHERE sequence > ? ORDER BY sequence ASC')
      .all(this.validatedEventSequence) as unknown as Array<EventRow & { sequence: number }>;
    const invalid: EventScan['invalid'] = [];
    for (const row of rows) {
      try {
        this.parseEvent(row);
      } catch (error) {
        invalid.push({ id: row.id, error: asSynomemError(error) });
      }
    }
    if (!invalid.length) {
      this.validatedEventSequence = rows.at(-1)?.sequence ?? this.validatedEventSequence;
      return;
    }
    const first = invalid[0]!;
    throw new SynomemError(
      first.error.code,
      `Cannot write while canonical event ${first.id} is unsupported or malformed; upgrade Synomem or inspect with synomem doctor and export.`,
      { eventIds: invalid.map((item) => item.id) },
    );
  }

  rawEventRows(): EventRow[] {
    return this.db()
      .prepare('SELECT id, payload FROM events ORDER BY sequence ASC')
      .all() as unknown as EventRow[];
  }

  private parseEvent(row: EventRow): SynomemEvent {
    try {
      let value = JSON.parse(row.payload) as unknown;
      if (typeof value === 'object' && value !== null) {
        const candidate = value as { schemaVersion?: unknown; type?: unknown };
        const supportedTypes = new Set([
          'agent.created',
          'agent.updated',
          'kudos.given',
          'kudos.acknowledged',
          'kudos.revoked',
          'memo.sent',
          'memo.read',
          'memo.archived',
          'note.created',
          'note.revised',
          'note.archived',
          'post.created',
          'post.edited',
          'post.archived',
          'post.acknowledged',
          'post.acknowledgment.withdrawn',
          'task.created',
          'task.updated',
          'task.completed',
          'task.reopened',
          'task.accepted',
          'task.rejected',
          'task.canceled',
          'todo.created',
          'todo.updated',
          'todo.completed',
          'todo.reopened',
          'todo.canceled',
          'todo.archived',
        ]);
        if (
          (typeof candidate.schemaVersion === 'number' && candidate.schemaVersion > 1) ||
          (typeof candidate.type === 'string' && !supportedTypes.has(candidate.type))
        ) {
          throw new SynomemError(
            'UNSUPPORTED_EVENT',
            `Event ${row.id} was written by a newer or incompatible Synomem version.`,
          );
        }
        const legacy = candidate as Record<string, unknown>;
        if (legacy.workspaceId === undefined) legacy.workspaceId = 'legacy-local';
        if (legacy.aggregateId === undefined) {
          legacy.aggregateId =
            legacy.kudosId ??
            legacy.memoId ??
            legacy.noteId ??
            legacy.taskId ??
            (typeof legacy.agentId === 'string' ? legacy.agentId : undefined) ??
            (typeof legacy.agent === 'object' && legacy.agent !== null
              ? (legacy.agent as { id?: unknown }).id
              : undefined) ??
            legacy.id;
        }
        if (legacy.aggregateVersion === undefined) {
          legacy.aggregateVersion =
            String(legacy.type).endsWith('.given') ||
            String(legacy.type).endsWith('.sent') ||
            String(legacy.type).endsWith('.created')
              ? 1
              : 2;
        }
        if (legacy.visibility === 'local') legacy.visibility = 'workspace';
        value = legacy;
      }
      return eventSchema.parse(value);
    } catch (error) {
      if (error instanceof SynomemError) throw error;
      throw new SynomemError(
        'INVALID_EVENT',
        `Unsupported or malformed event ${row.id} in canonical storage.`,
        {
          cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
  }

  insertAgent(profile: AgentProfile): void {
    const parsed = profileSchema.parse(profile);
    this.db()
      .prepare(
        `INSERT INTO agents(id, handle, status, display_name, profile_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        parsed.id,
        parsed.handle,
        parsed.status,
        parsed.displayName,
        JSON.stringify(parsed),
        parsed.createdAt,
        parsed.createdAt,
      );
    this.insertAliases(parsed.id, parsed.aliases ?? []);
  }

  updateAgent(profile: AgentProfile, updatedAt: string): void {
    const parsed = profileSchema.parse(profile);
    this.db()
      .prepare(
        `UPDATE agents SET handle = ?, status = ?, display_name = ?, profile_json = ?,
           updated_at = ? WHERE id = ?`,
      )
      .run(
        parsed.handle,
        parsed.status,
        parsed.displayName,
        JSON.stringify(parsed),
        updatedAt,
        parsed.id,
      );
    this.db().prepare('DELETE FROM aliases WHERE agent_id = ?').run(parsed.id);
    this.insertAliases(parsed.id, parsed.aliases ?? []);
  }

  getAgent(idOrAlias: string): AgentProfile | undefined {
    const resolved = this.resolveAgent(idOrAlias);
    return resolved.match;
  }

  /**
   * Resolves a name to a canonical agent, reporting ambiguity rather than
   * guessing.
   *
   * The plan is specific: `mycroft`, `Mycroft` and `Mike` may all resolve to one
   * agent, but a name two visible agents both claim must return candidates. An
   * alias that collides with a different agent's canonical ID is exactly that
   * case — silently preferring the ID would attribute work to the wrong agent,
   * and the person who typed the name would never know.
   */
  resolveAgent(query: string): { match?: AgentProfile; candidates: AgentProfile[] } {
    const normalized = query.trim().toLowerCase();
    const rows = this.db()
      .prepare(
        `SELECT DISTINCT a.profile_json
           FROM agents a
           LEFT JOIN aliases x ON x.agent_id = a.id
          WHERE lower(a.id) = ? OR lower(a.handle) = ? OR x.normalized_alias = ?
          ORDER BY a.id ASC`,
      )
      .all(normalized, normalized, normalized) as unknown as ProfileRow[];
    const candidates = rows.map((row) => profileSchema.parse(JSON.parse(row.profile_json)));
    return candidates.length === 1 ? { match: candidates[0]!, candidates } : { candidates };
  }

  /* -------------------------------------------------------- post acknowledgment */

  listPostAcknowledgments(postId: string): PostAcknowledgment[] {
    const rows = this.db()
      .prepare(
        `SELECT actor_kind, actor_id, actor_display_name, note, acknowledged_at
           FROM post_acknowledgments WHERE post_id = ? ORDER BY acknowledged_at ASC`,
      )
      .all(postId) as unknown as Array<{
      actor_kind: string;
      actor_id: string;
      actor_display_name: string | null;
      note: string | null;
      acknowledged_at: string;
    }>;
    return rows.map((row) => ({
      actor: {
        kind: row.actor_kind as ActorIdentity['kind'],
        id: row.actor_id,
        ...(row.actor_display_name ? { displayName: row.actor_display_name } : {}),
      },
      acknowledgedAt: row.acknowledged_at,
      ...(row.note ? { note: row.note } : {}),
    }));
  }

  /**
   * Who has acknowledged a post and who has not.
   *
   * The denominator is agents that existed when the post was written. An agent
   * created afterwards is counted separately rather than listed as
   * outstanding — it was not there, and a roster that says otherwise accuses a
   * newcomer of ignoring something written before it arrived.
   */
  postRoster(postId: string): PostRoster | undefined {
    const post = this.db()
      .prepare("SELECT created_at FROM items_current WHERE item_id = ? AND kind = 'post'")
      .get(postId) as { created_at: string } | undefined;
    if (!post) return undefined;

    const acknowledged = this.listPostAcknowledgments(postId);
    const acknowledgedIds = new Set(acknowledged.map((entry) => entry.actor.id));

    const eligible = this.db()
      .prepare('SELECT id, display_name, created_at FROM agents ORDER BY id ASC')
      .all() as unknown as Array<{ id: string; display_name: string; created_at: string }>;

    const outstanding = eligible
      .filter((agent) => agent.created_at <= post.created_at && !acknowledgedIds.has(agent.id))
      .map((agent) => ({ id: agent.id, displayName: agent.display_name }));
    const joinedSince = eligible.filter((agent) => agent.created_at > post.created_at).length;

    return { postId, acknowledged, outstanding, joinedSince };
  }

  /* ------------------------------------------------------- runtime bindings */

  listRuntimeBindings(agentId: string): AgentRuntimeBinding[] {
    const rows = this.db()
      .prepare(
        `SELECT id, agent_id, installation_id, runtime, profile, capabilities_json,
                bound_at, last_seen_at
           FROM agent_runtime_bindings WHERE agent_id = ? ORDER BY bound_at ASC`,
      )
      .all(agentId) as unknown as Array<{
      id: string;
      agent_id: string;
      installation_id: string | null;
      runtime: string;
      profile: string | null;
      capabilities_json: string;
      bound_at: string;
      last_seen_at: string | null;
    }>;
    return rows.map((row) => ({
      id: row.id,
      agentId: row.agent_id,
      ...(row.installation_id ? { installationId: row.installation_id } : {}),
      runtime: row.runtime,
      ...(row.profile ? { profile: row.profile } : {}),
      capabilities: JSON.parse(row.capabilities_json) as Record<string, JsonValue>,
      boundAt: row.bound_at,
      ...(row.last_seen_at ? { lastSeenAt: row.last_seen_at } : {}),
    }));
  }

  bindRuntime(binding: {
    id: string;
    agentId: string;
    installationId?: string;
    runtime: string;
    profile?: string;
    capabilities?: Record<string, JsonValue>;
    boundAt: string;
  }): void {
    this.db()
      .prepare(
        `INSERT INTO agent_runtime_bindings(
           id, agent_id, installation_id, runtime, profile, capabilities_json, bound_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(agent_id, runtime, COALESCE(profile, ''), COALESCE(installation_id, ''))
         DO UPDATE SET capabilities_json = excluded.capabilities_json`,
      )
      .run(
        binding.id,
        binding.agentId,
        binding.installationId ?? null,
        binding.runtime,
        binding.profile ?? null,
        JSON.stringify(binding.capabilities ?? {}),
        binding.boundAt,
      );
  }

  unbindRuntime(bindingId: string): boolean {
    const result = this.db()
      .prepare('DELETE FROM agent_runtime_bindings WHERE id = ?')
      .run(bindingId);
    return Number(result.changes) > 0;
  }

  /**
   * Advisory only. Records that Synomem observed this binding act — never that
   * the runtime is reachable now, and never that a delivery succeeded.
   */
  touchRuntimeBinding(agentId: string, runtime: string, at: string): void {
    this.db()
      .prepare(
        'UPDATE agent_runtime_bindings SET last_seen_at = ? WHERE agent_id = ? AND runtime = ?',
      )
      .run(at, agentId, runtime);
  }

  /**
   * Writes an agent's aliases, refusing any that would make a name ambiguous.
   *
   * Two collisions matter and both are rejected here rather than at lookup: an
   * alias another agent already claims, and an alias equal to a different
   * agent's canonical ID. Catching them at write means the person adding the
   * alias sees the conflict, instead of a later reader silently getting one of
   * two possible agents.
   */
  private insertAliases(agentId: string, aliases: string[]): void {
    for (const alias of aliases) {
      const normalized = alias.trim().toLowerCase();
      const conflictingAgent = this.db()
        .prepare('SELECT id FROM agents WHERE lower(id) = ? AND id != ?')
        .get(normalized, agentId) as { id: string } | undefined;
      if (conflictingAgent) {
        throw new SynomemError(
          'ALIAS_CONFLICT',
          `Alias "${alias}" is already the canonical ID of agent ${conflictingAgent.id}. Aliases must resolve to exactly one agent.`,
        );
      }
      const conflictingAlias = this.db()
        .prepare('SELECT agent_id FROM aliases WHERE normalized_alias = ? AND agent_id != ?')
        .get(normalized, agentId) as { agent_id: string } | undefined;
      if (conflictingAlias) {
        throw new SynomemError(
          'ALIAS_CONFLICT',
          `Alias "${alias}" already belongs to agent ${conflictingAlias.agent_id}. Aliases must resolve to exactly one agent.`,
        );
      }
      this.db()
        .prepare('INSERT INTO aliases(alias, agent_id, normalized_alias) VALUES (?, ?, ?)')
        .run(alias, agentId, normalized);
    }
  }

  listAgents(): AgentProfile[] {
    const rows = this.db()
      .prepare('SELECT profile_json FROM agents ORDER BY id ASC')
      .all() as unknown as ProfileRow[];
    return rows.map((row) => profileSchema.parse(JSON.parse(row.profile_json)));
  }

  replaceProjectionManifest(paths: string[], generatedAt: string): void {
    this.transactionSync(() => {
      this.db().prepare('DELETE FROM projection_manifest').run();
      const insert = this.db().prepare(
        'INSERT INTO projection_manifest(path, generated_at) VALUES (?, ?)',
      );
      for (const path of paths) insert.run(path, generatedAt);
    });
  }

  /**
   * @param directory the agent's projection directory name, which is its
   * handle rather than its canonical ID: these rows are keyed by the path on
   * disk, and projections are named for people to read.
   */
  replaceAgentProjectionManifest(directory: string, paths: string[], generatedAt: string): void {
    this.transactionSync(() => {
      this.db()
        .prepare('DELETE FROM projection_manifest WHERE path LIKE ? OR path LIKE ?')
        .run(`${directory}/%`, `${directory}\\%`);
      const insert = this.db().prepare(
        'INSERT INTO projection_manifest(path, generated_at) VALUES (?, ?)',
      );
      for (const path of paths) insert.run(path, generatedAt);
    });
  }

  projectionManifest(): string[] {
    return (
      this.db().prepare('SELECT path FROM projection_manifest ORDER BY path').all() as unknown as {
        path: string;
      }[]
    ).map((row) => row.path);
  }

  integrityCheck(): string[] {
    const rows = this.db().prepare('PRAGMA integrity_check').all() as unknown as Record<
      string,
      string
    >[];
    return rows.map((row) => Object.values(row)[0] ?? 'unknown');
  }

  journalMode(): string {
    const row = this.db().prepare('PRAGMA journal_mode').get() as Record<string, string>;
    return Object.values(row)[0] ?? 'unknown';
  }

  async backup(destination: string): Promise<string> {
    this.assertWritable();
    const output = resolve(destination);
    if (existsSync(output)) {
      throw new SynomemError(
        'INVALID_INPUT',
        `Backup destination already exists: ${basename(output)}`,
      );
    }
    ensureDirectory(dirname(output));
    const temporaryDirectory = mkdtempSync(join(dirname(output), '.synomem-backup-'));
    chmodSync(temporaryDirectory, 0o700);
    const temporaryOutput = join(temporaryDirectory, basename(output));
    try {
      const escaped = temporaryOutput.replaceAll("'", "''");
      this.db().exec(`VACUUM INTO '${escaped}'`);
      chmodSync(temporaryOutput, 0o600);
      linkSync(temporaryOutput, output);
      unlinkSync(temporaryOutput);
      return output;
    } finally {
      if (existsSync(temporaryOutput)) unlinkSync(temporaryOutput);
      rmdirSync(temporaryDirectory);
    }
  }

  private restrictDatabaseFiles(): void {
    if (this.readOnly) return;
    for (const path of [
      this.databasePath,
      `${this.databasePath}-wal`,
      `${this.databasePath}-shm`,
    ]) {
      if (existsSync(path)) chmodSync(path, 0o600);
    }
  }

  close(): void {
    this.database?.close();
    this.database = undefined;
  }
}
