import { describe, it, expect } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { resolveAuthority } from '../src/policy.js';
import { tempHome, testClient } from './helpers.js';
describe('personal bookmarks', () => {
  it('is actor scoped, preserves state on rebuild and immediately hides revoked private memory', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.actors.registerHuman({
      id: 'operator',
      handle: 'operator',
      displayName: 'Operator',
    });
    const agent = await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const note = await owner.notes.create({
      owner: { kind: 'agent', id: agent.id },
      title: 'Private saved memory',
      body: 'SECRET',
    });
    const post = await owner.posts.create({ title: 'Shared', body: 'Public discussion' });
    const operator = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'operator' },
      authority: { ...resolveAuthority(), operatedAgentIds: new Set([agent.id]) },
    });
    await operator.init();
    await operator.bookmarks.set({ rootId: note.record.event.id, present: true });
    await operator.bookmarks.set({ rootId: note.record.event.id, present: true });
    await operator.bookmarks.set({ rootId: post.record.event.id, present: true });
    const first = await operator.bookmarks.list({ limit: 1 });
    expect(first.items[0]?.root.title).toBe('Private saved memory');
    expect(first.hasMore).toBe(true);
    expect((await owner.bookmarks.list()).items).toEqual([]);
    await owner.rebuild();
    expect((await operator.bookmarks.list()).items).toHaveLength(2);
    operator.setAuthority(resolveAuthority());
    const visible = await operator.bookmarks.list();
    expect(visible.items.map((entry) => entry.root.id)).toEqual([post.record.event.id]);
    expect(JSON.stringify(visible)).not.toContain('Private saved memory');
    await expect(owner.bookmarks.list({ after: first.nextCursor })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await operator.bookmarks.set({ rootId: post.record.event.id, present: false });
    expect((await operator.bookmarks.list()).items).toEqual([]);
    await operator.close();
    await owner.close();
  });
});
