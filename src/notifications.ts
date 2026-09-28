import type { ActorRef } from './policy.js';
import type { ActorIdentity, ItemSummary, SynomemEvent } from './types.js';
import type { ParticipationSql } from './participation-repository.js';
import { cursorFilter } from './cursors.js';
import { SynomemError } from './errors.js';
export interface Notification {
  id: string;
  rootId: string;
  replyId?: string;
  eventId: string;
  sourceSequence: string;
  deliverySequence: string;
  reasonCodes: string[];
  publishedAt: string;
  read: boolean;
  dismissed: boolean;
  actionRequired: boolean;
  root?: Pick<ItemSummary, 'id' | 'kind' | 'title'>;
}
export interface NotificationInput {
  after?: string;
  limit?: number;
  view?: 'all' | 'unread' | 'action_required' | 'default';
}
export interface NotificationPage {
  items: Notification[];
  hasMore: boolean;
  nextCursor?: string;
  watermark: string;
}
export interface NotificationRepository {
  apply(event: SynomemEvent, sequence: bigint): Promise<void>;
  drain(limit?: number): Promise<{ delivered: number; suppressed: number }>;
  list(input: NotificationInput, actor: ActorIdentity): Promise<NotificationPage>;
  read(id: string, actor: ActorRef): Promise<void>;
  dismiss(id: string, actor: ActorRef): Promise<void>;
  readThrough(through: string, actor: ActorRef): Promise<void>;
  prune(at: string): Promise<number>;
  metrics(): Promise<{ pending: string; oldest: string | null }>;
}
export interface NotificationSql extends ParticipationSql {
  canRead(rootId: string, actor: ActorRef): Promise<boolean>;
  visibility(actor: ActorIdentity): { sql: string; values: string[] };
}
export const notificationTables = `
CREATE TABLE notification_sequences(workspace_id TEXT PRIMARY KEY,last_sequence BIGINT NOT NULL);
CREATE TABLE inbox_notifications (
 workspace_id TEXT NOT NULL, notification_id TEXT NOT NULL, event_id TEXT NOT NULL,root_id TEXT NOT NULL,reply_id TEXT,
 recipient_kind TEXT NOT NULL,recipient_id TEXT NOT NULL,source_sequence BIGINT NOT NULL,delivery_sequence BIGINT NOT NULL,
 reasons_json TEXT NOT NULL,published_at TEXT NOT NULL,read_at TEXT,dismissed_at TEXT,
 PRIMARY KEY(workspace_id,notification_id),UNIQUE(workspace_id,event_id,recipient_kind,recipient_id),UNIQUE(workspace_id,delivery_sequence)
);
CREATE INDEX inbox_actor_delivery ON inbox_notifications(workspace_id,recipient_kind,recipient_id,delivery_sequence);
CREATE INDEX inbox_retention ON inbox_notifications(workspace_id,published_at);
CREATE TABLE notification_fanout_jobs (
 workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,root_id TEXT NOT NULL,source_sequence BIGINT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','complete')),created_at TEXT NOT NULL,completed_at TEXT,
 PRIMARY KEY(workspace_id,event_id)
);
CREATE TABLE notification_fanout_targets (
 workspace_id TEXT NOT NULL,event_id TEXT NOT NULL,recipient_kind TEXT NOT NULL,recipient_id TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','delivered','suppressed')),completed_at TEXT,
 PRIMARY KEY(workspace_id,event_id,recipient_kind,recipient_id),
 FOREIGN KEY(workspace_id,event_id) REFERENCES notification_fanout_jobs(workspace_id,event_id)
);
CREATE INDEX fanout_pending ON notification_fanout_targets(workspace_id,state,event_id,recipient_kind,recipient_id);
`;
const value = (entry: unknown): string => String(entry);
const actionable = `((i.kind='memo' AND i.status='unread' AND i.recipient_kind=n.recipient_kind AND i.recipient_id=n.recipient_id) OR (i.kind='task' AND i.status='assigned' AND i.assignee_kind=n.recipient_kind AND i.assignee_id=n.recipient_id) OR (i.kind='kudos' AND i.status='unacknowledged' AND i.recipient_kind=n.recipient_kind AND i.recipient_id=n.recipient_id))`;
export class SqlNotificationRepository implements NotificationRepository {
  constructor(private readonly sql: NotificationSql) {}
  private get workspace(): string {
    return this.sql.workspaceId;
  }
  private async publish(
    eventId: string,
    rootId: string,
    replyId: string | undefined,
    source: string,
    actor: ActorRef,
    reasons: string[],
    at: string,
  ): Promise<void> {
    if (!(await this.sql.canRead(rootId, actor))) return;
    const muted = (
      await this.sql.query(
        'SELECT muted,last_read_sequence FROM thread_members WHERE workspace_id=? AND root_id=? AND actor_kind=? AND actor_id=?',
        [this.workspace, rootId, actor.kind, actor.id],
      )
    )[0];
    if (
      Number(muted?.muted) === 1 &&
      !reasons.includes('direct') &&
      !reasons.includes('intervention') &&
      !reasons.includes('mention')
    )
      return;
    const read = BigInt(value(muted?.last_read_sequence ?? '0')) >= BigInt(source);
    const max = (
      await this.sql.query(
        'INSERT INTO notification_sequences(workspace_id,last_sequence) VALUES(?,1) ON CONFLICT(workspace_id) DO UPDATE SET last_sequence=notification_sequences.last_sequence+1 RETURNING last_sequence AS next',
        [this.workspace],
      )
    )[0]!;
    // Deterministic tuple-derived ID; no content or endpoint secrets enter notification state.
    const id = `ntf-${cursorFilter({ eventId, actor })}`;
    await this.sql.execute(
      `INSERT INTO inbox_notifications(workspace_id,notification_id,event_id,root_id,reply_id,recipient_kind,recipient_id,source_sequence,delivery_sequence,reasons_json,published_at,read_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,event_id,recipient_kind,recipient_id) DO NOTHING`,
      [
        this.workspace,
        id,
        eventId,
        rootId,
        replyId ?? null,
        actor.kind,
        actor.id,
        source,
        value(max.next),
        JSON.stringify(reasons),
        at,
        read ? at : null,
      ],
    );
  }
  async apply(event: SynomemEvent, sequence: bigint): Promise<void> {
    if (event.type.startsWith('reaction.') || event.type === 'reply.deleted') return;
    const rootId =
      'rootId' in event
        ? event.rootId
        : /^(memo|task|kudos|post|note|todo)\./.test(event.type)
          ? event.aggregateId
          : undefined;
    if (!rootId) return;
    const row = (
      await this.sql.query(
        'SELECT payload FROM events WHERE workspace_id=? AND aggregate_id=? ORDER BY sequence LIMIT 1',
        [this.workspace, rootId],
      )
    )[0];
    if (!row) return;
    const root = (
      typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload
    ) as SynomemEvent;
    const targets: ActorRef[] = [];
    const add = (actor: ActorIdentity | ActorRef | undefined): void => {
      if (
        actor &&
        actor.kind !== 'system' &&
        !targets.some((target) => target.kind === actor.kind && target.id === actor.id)
      )
        targets.push({ kind: actor.kind, id: actor.id });
    };
    add(root.actor);
    if ('recipient' in root) add(root.recipient);
    if ('assignee' in root) add(root.assignee);
    if ('owner' in root) add(root.owner);
    if (root.id === event.id)
      for (const actor of targets)
        await this.sql.execute(
          `INSERT INTO thread_members(workspace_id,root_id,actor_kind,actor_id,following,muted,joined_sequence) VALUES(?,?,?,?,1,0,?) ON CONFLICT(workspace_id,root_id,actor_kind,actor_id) DO NOTHING`,
          [this.workspace, rootId, actor.kind, actor.id, sequence.toString()],
        );
    const immediate = new Map<string, { actor: ActorRef; reasons: Set<string> }>();
    const notify = (
      actor: ActorIdentity | ActorRef | undefined,
      reason: string,
      self = false,
    ): void => {
      if (
        !actor ||
        actor.kind === 'system' ||
        (!self && actor.kind === event.actor.kind && actor.id === event.actor.id)
      )
        return;
      const key = `${actor.kind}:${actor.id}`;
      const entry = immediate.get(key) ?? {
        actor: { kind: actor.kind, id: actor.id },
        reasons: new Set<string>(),
      };
      entry.reasons.add(reason);
      immediate.set(key, entry);
    };
    if (event.type === 'memo.sent') notify(event.recipient, 'direct', true);
    else if (event.type === 'kudos.given') notify(event.recipient, 'direct');
    else if (event.type === 'task.created') notify(event.assignee, 'direct');
    else if (
      event.type === 'memo.read' ||
      event.type === 'kudos.acknowledged' ||
      event.type === 'post.acknowledged' ||
      event.type === 'post.acknowledgment.withdrawn'
    )
      notify(root.actor, 'response');
    else if (event.type.startsWith('task.'))
      for (const target of targets) notify(target, 'lifecycle');
    if (event.intervention)
      for (const target of targets) if (target.kind === 'agent') notify(target, 'intervention');
    if (event.type === 'post.created' || event.type === 'post.edited') {
      const prior =
        event.type === 'post.edited'
          ? (
              await this.sql.query(
                "SELECT payload FROM events WHERE workspace_id=? AND aggregate_id=? AND type IN ('post.created','post.edited') AND id<>? ORDER BY sequence DESC LIMIT 1",
                [this.workspace, rootId, event.id],
              )
            )[0]
          : undefined;
      const previous = prior
        ? ((typeof prior.payload === 'string' ? JSON.parse(prior.payload) : prior.payload) as {
            mentions?: ActorRef[];
          })
        : undefined;
      for (const mention of event.mentions ?? [])
        if (
          !previous?.mentions?.some(
            (actor) => actor.kind === mention.kind && actor.id === mention.id,
          )
        )
          notify(mention, 'mention');
    }
    if (event.type === 'reply.created') {
      for (const target of targets) notify(target, 'reply');
      for (const mention of event.mentions) notify(mention, 'mention');
      if (event.parentId) {
        const parent = (
          await this.sql.query(
            'SELECT author_json FROM replies_current WHERE workspace_id=? AND reply_id=?',
            [this.workspace, event.parentId],
          )
        )[0];
        if (parent) notify(JSON.parse(value(parent.author_json)) as ActorIdentity, 'reply');
      }
    }
    for (const recipient of immediate.values())
      await this.publish(
        event.id,
        rootId,
        event.type === 'reply.created' ? event.id : undefined,
        sequence.toString(),
        recipient.actor,
        [...recipient.reasons].sort(),
        event.createdAt,
      );
    if (event.type === 'reply.created') {
      await this.sql.execute(
        `INSERT INTO notification_fanout_jobs(workspace_id,event_id,root_id,source_sequence,state,created_at) VALUES(?,?,?,?,'pending',?) ON CONFLICT(workspace_id,event_id) DO NOTHING`,
        [this.workspace, event.id, rootId, sequence.toString(), event.createdAt],
      );
      await this.sql.execute(
        `INSERT INTO notification_fanout_targets(workspace_id,event_id,recipient_kind,recipient_id,state) SELECT m.workspace_id,?,m.actor_kind,m.actor_id,'pending' FROM thread_members m WHERE m.workspace_id=? AND m.root_id=? AND m.following=1 AND m.muted=0 AND NOT(m.actor_kind=? AND m.actor_id=?) AND NOT EXISTS(SELECT 1 FROM inbox_notifications n WHERE n.workspace_id=m.workspace_id AND n.event_id=? AND n.recipient_kind=m.actor_kind AND n.recipient_id=m.actor_id) ON CONFLICT(workspace_id,event_id,recipient_kind,recipient_id) DO NOTHING`,
        [event.id, this.workspace, rootId, event.actor.kind, event.actor.id, event.id],
      );
    }
  }
  async drain(limit = 200): Promise<{ delivered: number; suppressed: number }> {
    const targets = await this.sql.query(
      `SELECT t.event_id,t.recipient_kind,t.recipient_id,j.root_id,j.source_sequence FROM notification_fanout_targets t JOIN notification_fanout_jobs j ON j.workspace_id=t.workspace_id AND j.event_id=t.event_id WHERE t.workspace_id=? AND t.state='pending' ORDER BY j.source_sequence,t.recipient_kind,t.recipient_id LIMIT ?`,
      [this.workspace, Math.min(200, Math.max(1, limit))],
    );
    let delivered = 0,
      suppressed = 0;
    const at = new Date().toISOString();
    for (const target of targets) {
      const actor = {
        kind: value(target.recipient_kind) as ActorRef['kind'],
        id: value(target.recipient_id),
      };
      const muted = (
        await this.sql.query(
          'SELECT muted,following FROM thread_members WHERE workspace_id=? AND root_id=? AND actor_kind=? AND actor_id=?',
          [this.workspace, value(target.root_id), actor.kind, actor.id],
        )
      )[0];
      const allowed =
        Number(muted?.muted) !== 1 &&
        Number(muted?.following) === 1 &&
        (await this.sql.canRead(value(target.root_id), actor));
      if (allowed) {
        await this.publish(
          value(target.event_id),
          value(target.root_id),
          value(target.event_id),
          value(target.source_sequence),
          actor,
          ['reply'],
          at,
        );
        delivered++;
      } else suppressed++;
      await this.sql.execute(
        'UPDATE notification_fanout_targets SET state=?,completed_at=? WHERE workspace_id=? AND event_id=? AND recipient_kind=? AND recipient_id=?',
        [
          allowed ? 'delivered' : 'suppressed',
          at,
          this.workspace,
          value(target.event_id),
          actor.kind,
          actor.id,
        ],
      );
    }
    await this.sql.execute(
      `UPDATE notification_fanout_jobs SET state='complete',completed_at=? WHERE workspace_id=? AND state='pending' AND NOT EXISTS(SELECT 1 FROM notification_fanout_targets t WHERE t.workspace_id=notification_fanout_jobs.workspace_id AND t.event_id=notification_fanout_jobs.event_id AND t.state='pending')`,
      [at, this.workspace],
    );
    return { delivered, suppressed };
  }
  async list(input: NotificationInput, actor: ActorIdentity): Promise<NotificationPage> {
    const view = input.view ?? 'default';
    const limit = Math.min(100, Math.max(1, input.limit ?? 20));
    const visibility = this.sql.visibility(actor);
    const codec = this.sql.codec();
    const binding = {
      purpose: 'inbox',
      workspaceId: this.workspace,
      actor,
      filter: cursorFilter({ view }),
    };
    const maximum = value(
      (
        await this.sql.query(
          'SELECT COALESCE((SELECT last_sequence FROM notification_sequences WHERE workspace_id=?),0) AS max',
          [this.workspace],
        )
      )[0]!.max,
    );
    const position = input.after ? codec.decode(input.after, binding, maximum) : undefined;
    const high = position?.watermark ?? maximum;
    const filter =
      view === 'unread'
        ? ' AND n.read_at IS NULL'
        : view === 'action_required'
          ? ` AND ${actionable}`
          : view === 'default'
            ? ` AND (n.read_at IS NULL OR ${actionable})`
            : '';
    const rows = await this.sql.query(
      `SELECT n.*,i.kind AS root_kind,i.title AS root_title,${actionable} AS action_required FROM inbox_notifications n JOIN items_current i ON i.workspace_id=n.workspace_id AND i.item_id=n.root_id WHERE n.workspace_id=? AND n.recipient_kind=? AND n.recipient_id=? AND n.delivery_sequence>? AND n.delivery_sequence<=? AND n.dismissed_at IS NULL AND (${visibility.sql})${filter} ORDER BY n.delivery_sequence LIMIT ?`,
      [
        this.workspace,
        actor.kind,
        actor.id,
        position?.sequence ?? '0',
        high,
        ...visibility.values,
        limit + 1,
      ],
    );
    const selected = rows.slice(0, limit);
    const mapped = selected.map((row) => ({
      root: {
        id: value(row.root_id),
        kind: value(row.root_kind) as ItemSummary['kind'],
        title: value(row.root_title),
      },
      id: value(row.notification_id),
      rootId: value(row.root_id),
      ...(row.reply_id ? { replyId: value(row.reply_id) } : {}),
      eventId: value(row.event_id),
      sourceSequence: value(row.source_sequence),
      deliverySequence: value(row.delivery_sequence),
      reasonCodes: JSON.parse(value(row.reasons_json)) as string[],
      publishedAt: value(row.published_at),
      read: row.read_at != null,
      dismissed: row.dismissed_at != null,
      actionRequired: row.action_required === true || Number(row.action_required) === 1,
    }));
    const items: Notification[] = [];
    let bytes = 2048;
    for (const entry of mapped) {
      const size = Buffer.byteLength(JSON.stringify(entry));
      if (items.length && bytes + size > 24576) break;
      items.push(entry);
      bytes += size;
    }
    const hasMore = rows.length > items.length;
    return {
      items,
      hasMore,
      ...(hasMore
        ? {
            nextCursor: codec.encode(binding, {
              sequence: items.at(-1)!.deliverySequence,
              watermark: high,
            }),
          }
        : {}),
      watermark: codec.encode(
        { purpose: 'inbox-read', workspaceId: this.workspace, actor, filter: cursorFilter({}) },
        { sequence: high, watermark: high },
      ),
    };
  }
  async read(id: string, actor: ActorRef): Promise<void> {
    const row = (
      await this.sql.query(
        'SELECT root_id FROM inbox_notifications WHERE workspace_id=? AND notification_id=? AND recipient_kind=? AND recipient_id=?',
        [this.workspace, id, actor.kind, actor.id],
      )
    )[0];
    if (!row || !(await this.sql.canRead(value(row.root_id), actor)))
      throw new SynomemError('ITEM_NOT_FOUND', 'Unknown notification.');
    await this.sql.execute(
      'UPDATE inbox_notifications SET read_at=COALESCE(read_at,?) WHERE workspace_id=? AND notification_id=? AND recipient_kind=? AND recipient_id=?',
      [new Date().toISOString(), this.workspace, id, actor.kind, actor.id],
    );
  }
  async dismiss(id: string, actor: ActorRef): Promise<void> {
    await this.read(id, actor);
    await this.sql.execute(
      'UPDATE inbox_notifications SET dismissed_at=COALESCE(dismissed_at,?) WHERE workspace_id=? AND notification_id=? AND recipient_kind=? AND recipient_id=?',
      [new Date().toISOString(), this.workspace, id, actor.kind, actor.id],
    );
  }
  async readThrough(through: string, actor: ActorRef): Promise<void> {
    const max = value(
      (
        await this.sql.query(
          'SELECT COALESCE((SELECT last_sequence FROM notification_sequences WHERE workspace_id=?),0) AS max',
          [this.workspace],
        )
      )[0]!.max,
    );
    const position = this.sql
      .codec()
      .decode(
        through,
        { purpose: 'inbox-read', workspaceId: this.workspace, actor, filter: cursorFilter({}) },
        max,
      );
    const visibility = this.sql.visibility(actor);
    await this.sql.execute(
      `UPDATE inbox_notifications SET read_at=COALESCE(read_at,?) WHERE workspace_id=? AND recipient_kind=? AND recipient_id=? AND delivery_sequence<=? AND root_id IN(SELECT i.item_id FROM items_current i WHERE i.workspace_id=? AND (${visibility.sql}))`,
      [
        new Date().toISOString(),
        this.workspace,
        actor.kind,
        actor.id,
        position.sequence,
        this.workspace,
        ...visibility.values,
      ],
    );
  }
  async metrics(): Promise<{ pending: string; oldest: string | null }> {
    const row = (
      await this.sql.query(
        `SELECT COUNT(*) AS pending,MIN(j.created_at) AS oldest FROM notification_fanout_targets t JOIN notification_fanout_jobs j ON j.workspace_id=t.workspace_id AND j.event_id=t.event_id WHERE t.workspace_id=? AND t.state='pending'`,
        [this.workspace],
      )
    )[0]!;
    return { pending: value(row.pending), oldest: row.oldest == null ? null : value(row.oldest) };
  }
  async prune(at: string): Promise<number> {
    const time = new Date(at).getTime();
    const readBefore = new Date(time - 90 * 86400000).toISOString();
    const unreadBefore = new Date(time - 180 * 86400000).toISOString();
    const rows = await this.sql.query(
      `SELECT n.notification_id FROM inbox_notifications n JOIN items_current i ON i.workspace_id=n.workspace_id AND i.item_id=n.root_id WHERE n.workspace_id=? AND NOT ${actionable} AND (((n.read_at IS NOT NULL OR n.dismissed_at IS NOT NULL) AND n.published_at<?) OR (n.read_at IS NULL AND n.published_at<?)) ORDER BY n.delivery_sequence LIMIT 1000`,
      [this.workspace, readBefore, unreadBefore],
    );
    for (const row of rows)
      await this.sql.execute(
        'DELETE FROM inbox_notifications WHERE workspace_id=? AND notification_id=?',
        [this.workspace, value(row.notification_id)],
      );
    // Keep completed jobs as permanent source-event dedupe identities; only target detail expires.
    const expired = await this.sql.query(
      `SELECT t.event_id,t.recipient_kind,t.recipient_id FROM notification_fanout_targets t JOIN notification_fanout_jobs j ON j.workspace_id=t.workspace_id AND j.event_id=t.event_id WHERE t.workspace_id=? AND t.state!='pending' AND t.completed_at<? AND j.state='complete' LIMIT 1000`,
      [this.workspace, new Date(time - 30 * 86400000).toISOString()],
    );
    for (const target of expired)
      await this.sql.execute(
        'DELETE FROM notification_fanout_targets WHERE workspace_id=? AND event_id=? AND recipient_kind=? AND recipient_id=?',
        [
          this.workspace,
          value(target.event_id),
          value(target.recipient_kind),
          value(target.recipient_id),
        ],
      );
    return rows.length;
  }
}
