import { describe, expect, it } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { tempHome, testClient } from './helpers.js';
describe('exact local sequences and snapshot pagination', () => {
  it('uses a fixed watermark while writes continue and rejects cross-viewer/filter reuse', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.posts.create({ title: 'First', body: 'First' });
    await owner.posts.create({ title: 'Second', body: 'Second' });
    const page = await owner.items.list({ kinds: ['post'], limit: 1 });
    expect(page.nextCursor).toBeDefined();
    await owner.posts.create({ title: 'Third', body: 'Third' });
    const next = await owner.items.list({ kinds: ['post'], limit: 1, cursor: page.nextCursor });
    expect(next.items.map((item) => item.title)).toEqual(['First']);
    const changes = await owner.items.changes({ after: next.watermark, kinds: ['post'] });
    expect(changes.items.map((item) => item.summary?.title)).toEqual(['Third']);
    await expect(
      owner.items.list({ kinds: ['todo'], cursor: page.nextCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const member = new SynomemClient({ home, actor: { kind: 'human', id: 'other' } });
    await member.init();
    await expect(
      member.items.list({ kinds: ['post'], cursor: page.nextCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await member.close();
    await owner.close();
  });
  it('appends, projects and returns sequences beyond JavaScript safe integers exactly', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const first = await owner.posts.create({ title: 'High watermark', body: 'Exact' });
    const original = first.record.event;
    const id = '01K9ABCDEF0123456789ABCDEF';
    const event = { ...original, id, aggregateId: id, title: 'Imported exact boundary' };
    owner.storage
      .db()
      .prepare(
        `INSERT INTO events(id,schema_version,type,created_at,actor_kind,actor_id,payload,sequence,workspace_id,aggregate_id,aggregate_version,item_kind) VALUES(?,2,'post.created',?,'human',?,?,9007199254740993,?,?,1,'post')`,
      )
      .run(id, event.createdAt, event.actor.id, JSON.stringify(event), event.workspaceId, id);
    const added = await owner.posts.create({ title: 'After boundary', body: 'Still exact' });
    const feed = await owner.items.changes({ limit: 50 });
    expect(feed.items.find((item) => item.eventId === added.record.event.id)?.sequence).toBe(
      '9007199254740994',
    );
    expect(feed.items.every((item) => typeof item.sequence === 'string')).toBe(true);
    await owner.close();
  });
});
