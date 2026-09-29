import type { ActorIdentity, ItemSummary } from './types.js';
import type { ActorRef } from './policy.js';
import type { NotificationSql } from './notifications.js';
import { cursorFilter } from './cursors.js';
export interface BookmarkInput {
  after?: string;
  limit?: number;
}
export interface BookmarkPage {
  items: Array<{ root: Pick<ItemSummary, 'id' | 'kind' | 'title'>; savedAt: string }>;
  hasMore: boolean;
  nextCursor?: string;
  watermark: string;
}
export interface BookmarkRepository {
  set(rootId: string, actor: ActorRef, present: boolean): Promise<void>;
  has(rootId: string, actor: ActorRef): Promise<boolean>;
  list(input: BookmarkInput, actor: ActorIdentity): Promise<BookmarkPage>;
}
export const bookmarkTables = `
CREATE TABLE bookmark_sequences(workspace_id TEXT PRIMARY KEY,last_sequence BIGINT NOT NULL);
CREATE TABLE bookmarks(workspace_id TEXT NOT NULL,actor_kind TEXT NOT NULL,actor_id TEXT NOT NULL,root_id TEXT NOT NULL,saved_at TEXT NOT NULL,saved_sequence BIGINT NOT NULL,PRIMARY KEY(workspace_id,actor_kind,actor_id,root_id));
CREATE INDEX bookmarks_actor_sequence ON bookmarks(workspace_id,actor_kind,actor_id,saved_sequence);
`;
export class SqlBookmarkRepository implements BookmarkRepository {
  constructor(private readonly sql: NotificationSql) {}
  async has(rootId: string, actor: ActorRef): Promise<boolean> {
    return (
      (
        await this.sql.query(
          'SELECT 1 FROM bookmarks WHERE workspace_id=? AND actor_kind=? AND actor_id=? AND root_id=?',
          [this.sql.workspaceId, actor.kind, actor.id, rootId],
        )
      ).length > 0
    );
  }
  async set(rootId: string, actor: ActorRef, present: boolean): Promise<void> {
    if (!present) {
      await this.sql.execute(
        'DELETE FROM bookmarks WHERE workspace_id=? AND actor_kind=? AND actor_id=? AND root_id=?',
        [this.sql.workspaceId, actor.kind, actor.id, rootId],
      );
      return;
    }
    if (await this.has(rootId, actor)) return;
    const counter = (
      await this.sql.query(
        'INSERT INTO bookmark_sequences(workspace_id,last_sequence) VALUES(?,1) ON CONFLICT(workspace_id) DO UPDATE SET last_sequence=bookmark_sequences.last_sequence+1 RETURNING last_sequence',
        [this.sql.workspaceId],
      )
    )[0]!;
    await this.sql.execute(
      'INSERT INTO bookmarks(workspace_id,actor_kind,actor_id,root_id,saved_at,saved_sequence) VALUES(?,?,?,?,?,?) ON CONFLICT(workspace_id,actor_kind,actor_id,root_id) DO NOTHING',
      [
        this.sql.workspaceId,
        actor.kind,
        actor.id,
        rootId,
        new Date().toISOString(),
        String(counter.last_sequence),
      ],
    );
  }
  async list(input: BookmarkInput, actor: ActorIdentity): Promise<BookmarkPage> {
    const maximum = String(
      (
        await this.sql.query(
          'SELECT COALESCE((SELECT last_sequence FROM bookmark_sequences WHERE workspace_id=?),0) AS max',
          [this.sql.workspaceId],
        )
      )[0]!.max,
    );
    const binding = {
      purpose: 'bookmarks',
      workspaceId: this.sql.workspaceId,
      actor,
      filter: cursorFilter({}),
    };
    const codec = this.sql.codec();
    const position = input.after ? codec.decode(input.after, binding, maximum) : undefined;
    const high = position?.watermark ?? maximum;
    const policy = this.sql.visibility(actor);
    const limit = input.limit ?? 20;
    const rows = await this.sql.query(
      `SELECT b.saved_sequence,b.saved_at,i.item_id,i.kind,i.title FROM bookmarks b JOIN items_current i ON i.workspace_id=b.workspace_id AND i.item_id=b.root_id WHERE b.workspace_id=? AND b.actor_kind=? AND b.actor_id=? AND b.saved_sequence>? AND b.saved_sequence<=? AND (${policy.sql}) ORDER BY b.saved_sequence LIMIT ?`,
      [
        this.sql.workspaceId,
        actor.kind,
        actor.id,
        position?.sequence ?? '0',
        high,
        ...policy.values,
        limit + 1,
      ],
    );
    const items: BookmarkPage['items'] = [];
    let bytes = 2048;
    for (const row of rows.slice(0, limit)) {
      const entry = {
        root: {
          id: String(row.item_id),
          kind: String(row.kind) as ItemSummary['kind'],
          title: String(row.title),
        },
        savedAt: String(row.saved_at),
      };
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
              sequence: String(rows[items.length - 1]!.saved_sequence),
              watermark: high,
            }),
          }
        : {}),
      watermark: codec.encode(binding, { sequence: high, watermark: high }),
    };
  }
}
