import { SynomemError } from './errors.js';
import type { SignedCursorCodec } from './cursors.js';
import { cursorFilter } from './cursors.js';
import type { ActorRef } from './policy.js';
import type { ActorIdentity, SynomemEvent } from './types.js';
import type {
  ParticipationRepository,
  ReplyRecord,
  ThreadInput,
  ThreadPage,
  ReactionCode,
  ReactionSummary,
} from './participation.js';

export interface ParticipationBudgets {
  reply: { minute: number; hour: number; workspaceDay: number };
  reaction: { minute: number; hour: number; workspaceDay: number };
}
export const defaultParticipationBudgets: ParticipationBudgets = {
  reply: { minute: 30, hour: 300, workspaceDay: 10000 },
  reaction: { minute: 60, hour: 600, workspaceDay: 50000 },
};
export function validateParticipationBudgets(budgets: ParticipationBudgets): ParticipationBudgets {
  for (const kind of ['reply', 'reaction'] as const) {
    const values = budgets?.[kind];
    if (
      !values ||
      Object.keys(values).some((key) => !['minute', 'hour', 'workspaceDay'].includes(key)) ||
      ['minute', 'hour', 'workspaceDay'].some(
        (key) =>
          !Number.isSafeInteger(values[key as keyof typeof values]) ||
          values[key as keyof typeof values] < 1,
      )
    )
      throw new SynomemError(
        'CONFIG_INVALID',
        'Participation budgets require positive integer minute, hour and workspaceDay limits.',
      );
  }
  return { reply: { ...budgets.reply }, reaction: { ...budgets.reaction } };
}
/** Trusted storage adapter. SQL uses positional question marks; hosted adapters bind parameters. */
export interface ParticipationSql {
  query(sql: string, values: unknown[]): Promise<Array<Record<string, unknown>>>;
  execute(sql: string, values: unknown[]): Promise<void>;
  codec(): SignedCursorCodec;
  workspaceId: string;
  budgets?: ParticipationBudgets;
}
export const participationTables = `
CREATE TABLE replies_current (
 workspace_id TEXT NOT NULL, reply_id TEXT NOT NULL, root_id TEXT NOT NULL, parent_id TEXT,
 author_json TEXT NOT NULL, created_at TEXT NOT NULL, created_sequence BIGINT NOT NULL,
 updated_sequence BIGINT NOT NULL, version INTEGER NOT NULL, body TEXT, mentions_json TEXT NOT NULL,
 deleted_at TEXT, PRIMARY KEY(workspace_id,reply_id), UNIQUE(workspace_id,root_id,reply_id),
 FOREIGN KEY(workspace_id,root_id,parent_id) REFERENCES replies_current(workspace_id,root_id,reply_id)
);
CREATE INDEX replies_root_sequence ON replies_current(workspace_id,root_id,created_sequence,reply_id);
CREATE INDEX replies_root_changes ON replies_current(workspace_id,root_id,updated_sequence,reply_id);
CREATE TABLE thread_entries (
 workspace_id TEXT NOT NULL, root_id TEXT NOT NULL, event_id TEXT NOT NULL, sequence BIGINT NOT NULL,
 PRIMARY KEY(workspace_id,event_id)
);
CREATE INDEX thread_entries_root_sequence ON thread_entries(workspace_id,root_id,sequence,event_id);
CREATE TABLE thread_members (
 workspace_id TEXT NOT NULL, root_id TEXT NOT NULL, actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL,
 following INTEGER NOT NULL CHECK(following IN (0,1)), muted INTEGER NOT NULL CHECK(muted IN (0,1)),
 last_read_sequence BIGINT NOT NULL DEFAULT 0, joined_sequence BIGINT NOT NULL DEFAULT 0,
 PRIMARY KEY(workspace_id,root_id,actor_kind,actor_id)
);
CREATE TABLE reactions_current (
 workspace_id TEXT NOT NULL, target_id TEXT NOT NULL, root_id TEXT NOT NULL,
 actor_kind TEXT NOT NULL, actor_id TEXT NOT NULL, code TEXT NOT NULL,
 event_id TEXT NOT NULL, created_at TEXT NOT NULL,
 PRIMARY KEY(workspace_id,target_id,actor_kind,actor_id,code)
);
CREATE INDEX reactions_root ON reactions_current(workspace_id,root_id,target_id);
CREATE TABLE record_mentions (
 workspace_id TEXT NOT NULL,source_event_id TEXT NOT NULL,root_id TEXT NOT NULL,reply_id TEXT,
 mentioned_kind TEXT NOT NULL,mentioned_id TEXT NOT NULL,
 PRIMARY KEY(workspace_id,source_event_id,mentioned_kind,mentioned_id)
);
CREATE INDEX record_mentions_root ON record_mentions(workspace_id,root_id,source_event_id);
CREATE TABLE mutation_budgets (
 workspace_id TEXT NOT NULL, bucket_key TEXT NOT NULL, bucket_start BIGINT NOT NULL,
 window_seconds INTEGER NOT NULL, used INTEGER NOT NULL,
 PRIMARY KEY(workspace_id,bucket_key,bucket_start,window_seconds)
);
CREATE INDEX mutation_budgets_retention ON mutation_budgets(workspace_id,bucket_start);
`;
const text = (value: unknown): string => String(value);
export class SqlParticipationRepository implements ParticipationRepository {
  constructor(private readonly sql: ParticipationSql) {}
  private get workspace(): string {
    return this.sql.workspaceId;
  }
  async apply(event: SynomemEvent, sequence: bigint, replay = false): Promise<void> {
    if (
      event.type === 'reply.created' ||
      event.type === 'post.created' ||
      event.type === 'post.edited'
    )
      for (const mention of event.mentions ?? [])
        await this.sql.execute(
          'INSERT INTO record_mentions(workspace_id,source_event_id,root_id,reply_id,mentioned_kind,mentioned_id) VALUES(?,?,?,?,?,?) ON CONFLICT DO NOTHING',
          [
            this.workspace,
            event.id,
            event.type === 'reply.created' ? event.rootId : event.aggregateId,
            event.type === 'reply.created' ? event.id : null,
            mention.kind,
            mention.id,
          ],
        );
    if (event.type === 'reply.deleted')
      await this.sql.execute(
        'DELETE FROM record_mentions WHERE workspace_id=? AND source_event_id=?',
        [this.workspace, event.replyId],
      );
    for (const command of participationStatements(event, sequence, this.workspace))
      if (!replay || !command.sql.includes('thread_members'))
        await this.sql.execute(command.sql, command.values);
  }
  async getReply(id: string): Promise<ReplyRecord | undefined> {
    const row = (
      await this.sql.query('SELECT * FROM replies_current WHERE workspace_id=? AND reply_id=?', [
        this.workspace,
        id,
      ])
    )[0];
    if (!row) return undefined;
    const deleted = row.deleted_at != null;
    return {
      id: text(row.reply_id),
      rootId: text(row.root_id),
      parentId: row.parent_id == null ? null : text(row.parent_id),
      author: JSON.parse(text(row.author_json)) as ActorIdentity,
      createdAt: text(row.created_at),
      createdSequence: text(row.created_sequence),
      updatedSequence: text(row.updated_sequence),
      version: Number(row.version),
      deleted,
      ...(!deleted
        ? { body: text(row.body), mentions: JSON.parse(text(row.mentions_json)) as ActorRef[] }
        : {}),
    };
  }
  async thread(input: ThreadInput, actor: ActorIdentity, purpose = 'thread'): Promise<ThreadPage> {
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const maxRow = (
      await this.sql.query(
        'SELECT COALESCE(MAX(sequence),0) AS max FROM events WHERE workspace_id=?',
        [this.workspace],
      )
    )[0]!;
    const max = BigInt(text(maxRow.max));
    const binding = {
      purpose,
      workspaceId: this.workspace,
      actor,
      filter: cursorFilter({ rootId: input.rootId }),
    };
    const codec = this.sql.codec();
    const position = input.after ? codec.decode(input.after, binding, max.toString()) : undefined;
    const watermark =
      purpose === 'reply-changes' ? max.toString() : (position?.watermark ?? max.toString());
    const rows = await this.sql.query(
      `SELECT e.payload,e.sequence,r.deleted_at FROM thread_entries t JOIN events e ON e.workspace_id=t.workspace_id AND e.id=t.event_id LEFT JOIN replies_current r ON r.workspace_id=t.workspace_id AND r.reply_id=e.aggregate_id WHERE t.workspace_id=? AND t.root_id=? AND t.sequence>? AND t.sequence<=? ORDER BY t.sequence,t.event_id LIMIT ?`,
      [this.workspace, input.rootId, position?.sequence ?? '0', watermark, limit + 1],
    );
    const entries: ThreadPage['entries'] = [];
    let bytes = 0;
    for (const row of rows.slice(0, limit)) {
      const event = (
        typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
      ) as SynomemEvent;
      if (event.type === 'reply.created' && row.deleted_at != null) {
        // Return the tombstone shape; never carry the retained canonical body into a timeline.
        const { body: _body, mentions: _mentions, ...base } = event;
        void _body;
        void _mentions;
        const tombstone = { ...base, type: 'reply.deleted' as const, replyId: event.id };
        const entry = { sequence: text(row.sequence), event: tombstone };
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (entries.length && bytes + size > 24576) break;
        entries.push(entry);
        bytes += size;
      } else {
        let entry: ThreadPage['entries'][number] = { sequence: text(row.sequence), event };
        if (Buffer.byteLength(JSON.stringify(entry)) > 20000) {
          const preview = { ...event } as unknown as Record<string, unknown>;
          for (const key of ['body', 'description', 'details', 'reason', 'response'])
            if (typeof preview[key] === 'string') preview[key] = preview[key].slice(0, 1000);
          for (const key of ['source', 'metadata', 'evidence']) delete preview[key];
          entry = { ...entry, event: preview as unknown as SynomemEvent, detailRequired: true };
        }
        const size = Buffer.byteLength(JSON.stringify(entry));
        if (entries.length && bytes + size > 24576) break;
        entries.push(entry);
        bytes += size;
      }
    }
    const hasMore = rows.length > entries.length;
    const checkpoint = entries.at(-1)?.sequence ?? position?.sequence ?? '0';
    const member = (
      await this.sql.query(
        'SELECT following,muted,last_read_sequence FROM thread_members WHERE workspace_id=? AND root_id=? AND actor_kind=? AND actor_id=?',
        [this.workspace, input.rootId, actor.kind, actor.id],
      )
    )[0];
    return {
      rootId: input.rootId,
      entries,
      hasMore,
      subscription: {
        following: Number(member?.following) === 1,
        muted: Number(member?.muted) === 1,
        lastReadSequence: text(member?.last_read_sequence ?? 0),
      },
      ...(hasMore || purpose === 'reply-changes'
        ? {
            nextCursor: codec.encode(binding, {
              sequence: purpose === 'reply-changes' && !hasMore ? watermark : checkpoint,
              watermark,
            }),
          }
        : {}),
      watermark: codec.encode(
        { ...binding, purpose: 'thread-read' },
        { sequence: checkpoint, watermark },
      ),
      contextLimited: hasMore,
    };
  }
  async changes(input: ThreadInput, actor: ActorIdentity): Promise<ThreadPage> {
    return this.thread(input, actor, 'reply-changes');
  }
  async read(rootId: string, through: string, actor: ActorRef): Promise<void> {
    const max = String(
      (
        await this.sql.query(
          'SELECT COALESCE(MAX(sequence),0) AS max FROM events WHERE workspace_id=?',
          [this.workspace],
        )
      )[0]!.max,
    );
    const position = this.sql.codec().decode(
      through,
      {
        purpose: 'thread-read',
        workspaceId: this.workspace,
        actor,
        filter: cursorFilter({ rootId }),
      },
      max,
    );
    await this.sql.execute(
      `INSERT INTO thread_members(workspace_id,root_id,actor_kind,actor_id,following,muted,last_read_sequence) VALUES(?,?,?,?,0,0,?) ON CONFLICT(workspace_id,root_id,actor_kind,actor_id) DO UPDATE SET last_read_sequence=CASE WHEN thread_members.last_read_sequence<excluded.last_read_sequence THEN excluded.last_read_sequence ELSE thread_members.last_read_sequence END`,
      [this.workspace, rootId, actor.kind, actor.id, position.sequence],
    );
    await this.sql.execute(
      `UPDATE inbox_notifications SET read_at=COALESCE(read_at,?) WHERE workspace_id=? AND root_id=? AND recipient_kind=? AND recipient_id=? AND source_sequence<=?`,
      [new Date().toISOString(), this.workspace, rootId, actor.kind, actor.id, position.sequence],
    );
  }
  async hasReaction(targetId: string, actor: ActorRef, code: ReactionCode): Promise<boolean> {
    return (
      (
        await this.sql.query(
          'SELECT 1 FROM reactions_current WHERE workspace_id=? AND target_id=? AND actor_kind=? AND actor_id=? AND code=?',
          [this.workspace, targetId, actor.kind, actor.id, code],
        )
      ).length > 0
    );
  }
  async reactions(targetId: string, actor: ActorRef): Promise<ReactionSummary> {
    const rows = await this.sql.query(
      'SELECT code,COUNT(*) AS count FROM reactions_current WHERE workspace_id=? AND target_id=? GROUP BY code',
      [this.workspace, targetId],
    );
    const selected = await this.sql.query(
      'SELECT code FROM reactions_current WHERE workspace_id=? AND target_id=? AND actor_kind=? AND actor_id=? ORDER BY code',
      [this.workspace, targetId, actor.kind, actor.id],
    );
    return {
      targetId,
      counts: Object.fromEntries(rows.map((row) => [text(row.code), Number(row.count)])),
      selected: selected.map((row) => text(row.code) as ReactionCode),
    };
  }
  async subscription(
    rootId: string,
    actor: ActorRef,
    following: boolean,
    muted: boolean,
  ): Promise<void> {
    await this.sql.execute(
      `INSERT INTO thread_members(workspace_id,root_id,actor_kind,actor_id,following,muted) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,root_id,actor_kind,actor_id) DO UPDATE SET following=excluded.following,muted=excluded.muted`,
      [this.workspace, rootId, actor.kind, actor.id, Number(following), Number(muted)],
    );
  }
  async reserveBudget(kind: 'reply' | 'reaction', actor: ActorRef, at: string): Promise<void> {
    const seconds = Math.floor(new Date(at).getTime() / 1000);
    const limits = this.sql.budgets ?? defaultParticipationBudgets;
    const budgets = [
      { key: `${kind}:workspace`, window: 86400, limit: limits[kind].workspaceDay },
      {
        key: `${kind}:${actor.kind}:${actor.id}`,
        window: 3600,
        limit: limits[kind].hour,
      },
      { key: `${kind}:${actor.kind}:${actor.id}`, window: 60, limit: limits[kind].minute },
    ];
    for (const budget of budgets) {
      const bucket = Math.floor(seconds / budget.window) * budget.window;
      const row = (
        await this.sql.query(
          'SELECT used FROM mutation_budgets WHERE workspace_id=? AND bucket_key=? AND bucket_start=? AND window_seconds=?',
          [this.workspace, budget.key, bucket, budget.window],
        )
      )[0];
      if (Number(row?.used ?? 0) >= budget.limit)
        throw new SynomemError('RATE_LIMITED', 'The mutation rate budget is exhausted.', {
          retryAfter: bucket + budget.window - seconds,
        });
      await this.sql.execute(
        `INSERT INTO mutation_budgets(workspace_id,bucket_key,bucket_start,window_seconds,used) VALUES(?,?,?,?,1) ON CONFLICT(workspace_id,bucket_key,bucket_start,window_seconds) DO UPDATE SET used=mutation_budgets.used+1`,
        [this.workspace, budget.key, bucket, budget.window],
      );
    }
  }
}
export function participationStatements(
  event: SynomemEvent,
  sequence: bigint,
  workspace: string,
): Array<{ sql: string; values: unknown[] }> {
  const commands: Array<{ sql: string; values: unknown[] }> = [];
  const write = (sql: string, values: unknown[]): void => {
    commands.push({ sql, values });
  };
  let rootId: string | undefined;
  if ('rootId' in event) rootId = event.rootId;
  else if (/^(kudos|memo|post|note|task|todo)\./.test(event.type)) rootId = event.aggregateId;
  if (!rootId) return commands;
  write('INSERT INTO thread_entries(workspace_id,root_id,event_id,sequence) VALUES(?,?,?,?)', [
    workspace,
    rootId,
    event.id,
    sequence.toString(),
  ]);
  if (event.type === 'reply.created') {
    write(
      `INSERT INTO replies_current(workspace_id,reply_id,root_id,parent_id,author_json,created_at,created_sequence,updated_sequence,version,body,mentions_json) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        workspace,
        event.id,
        event.rootId,
        event.parentId,
        JSON.stringify(event.actor),
        event.createdAt,
        sequence.toString(),
        sequence.toString(),
        1,
        event.body,
        JSON.stringify(event.mentions),
      ],
    );
    write(
      `INSERT INTO thread_members(workspace_id,root_id,actor_kind,actor_id,following,muted,joined_sequence) VALUES(?,?,?,?,1,0,?) ON CONFLICT(workspace_id,root_id,actor_kind,actor_id) DO UPDATE SET following=1`,
      [workspace, rootId, event.actor.kind, event.actor.id, sequence.toString()],
    );
  } else if (event.type === 'reply.deleted') {
    write(
      'UPDATE replies_current SET body=NULL,mentions_json=?,deleted_at=?,version=?,updated_sequence=? WHERE workspace_id=? AND reply_id=?',
      [
        '[]',
        event.createdAt,
        event.aggregateVersion,
        sequence.toString(),
        workspace,
        event.replyId,
      ],
    );
  } else if (event.type === 'reaction.added') {
    write(
      `INSERT INTO reactions_current(workspace_id,target_id,root_id,actor_kind,actor_id,code,event_id,created_at) VALUES(?,?,?,?,?,?,?,?)`,
      [
        workspace,
        event.targetId,
        rootId,
        event.actor.kind,
        event.actor.id,
        event.code,
        event.id,
        event.createdAt,
      ],
    );
  } else if (event.type === 'reaction.removed') {
    write(
      'DELETE FROM reactions_current WHERE workspace_id=? AND target_id=? AND actor_kind=? AND actor_id=? AND code=?',
      [workspace, event.targetId, event.actor.kind, event.actor.id, event.code],
    );
  }
  return commands;
}
