import { describe, expect, it } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { localOwnerAuthority, resolveAuthority } from '../src/policy.js';
import { tempHome, testClient } from './helpers.js';

describe('root participation', () => {
  it('supports every root, preserves parent tombstones, and never applies lifecycle actions from text', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const agent = await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const roots = [
      (await owner.posts.create({ title: 'Post', body: 'Body' })).record.event.id,
      (
        await owner.memos.send({
          recipient: { kind: 'agent', id: agent.id },
          subject: 'Memo',
          body: 'Body',
        })
      ).record.event.id,
      (await owner.tasks.create({ assignee: { kind: 'agent', id: agent.id }, title: 'Task' }))
        .record.event.id,
      (await owner.todos.create({ title: 'Todo' })).record.event.id,
      (await owner.notes.create({ title: 'Note', body: 'Body' })).record.event.id,
      (
        await owner.kudos.give({
          recipient: { kind: 'agent', id: agent.id },
          title: 'Kudos',
          reason: 'Help',
        })
      ).record.event.id,
    ];
    for (const rootId of roots) {
      const reply = await owner.replies.create({ rootId, body: 'Sure, done, acknowledged.' });
      expect(reply.rootId).toBe(rootId);
    }
    expect((await owner.tasks.get(roots[2]!)).status).toBe('assigned');
    expect((await owner.memos.get(roots[1]!)).status).toBe('unread');
    expect((await owner.kudos.get(roots[5]!)).status).toBe('unacknowledged');
    const parent = await owner.replies.create({
      rootId: roots[0]!,
      body: 'Retained canonical private body',
      idempotencyKey: 'parent',
    });
    const child = await owner.replies.create({
      rootId: roots[0]!,
      parentId: parent.id,
      body: 'Child',
    });
    await expect(
      owner.replies.create({ rootId: roots[1]!, parentId: parent.id, body: 'Wrong root' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await owner.replies.delete({ replyId: parent.id, expectedVersion: 1 });
    expect(await owner.replies.get(parent.id)).toMatchObject({ deleted: true, version: 2 });
    expect((await owner.replies.get(parent.id)).body).toBeUndefined();
    expect((await owner.replies.get(child.id)).parentId).toBe(parent.id);
    await owner.replies.create({
      rootId: roots[0]!,
      parentId: parent.id,
      body: 'Reply to tombstone',
    });
    const thread = await owner.threads.get({ rootId: roots[0]! });
    expect(JSON.stringify(thread)).not.toContain('Retained canonical private body');
    await owner.close();
  });
  it('rechecks private root access, current moderation authority and cursor identity', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const agent = await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const memory = (
      await owner.notes.create({
        owner: { kind: 'agent', id: agent.id },
        title: 'Memory',
        body: 'Private',
      })
    ).record;
    const publicPost = (await owner.posts.create({ title: 'Public', body: 'Body' })).record;
    await owner.actors.registerHuman({
      id: 'ordinary',
      handle: 'ordinary',
      displayName: 'Ordinary',
    });
    const ordinary = new SynomemClient({ home, actor: { kind: 'human', id: 'ordinary' } });
    await ordinary.init();
    await expect(
      ordinary.replies.create({ rootId: memory.event.id, body: 'Cannot read' }),
    ).rejects.toMatchObject({ code: 'POLICY_FORBIDDEN' });
    const reply = await ordinary.replies.create({
      rootId: publicPost.event.id,
      body: 'Public reply',
    });
    await expect(
      owner.replies.delete({ replyId: reply.id, expectedVersion: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await owner.replies.delete({ replyId: reply.id, expectedVersion: 1, reason: 'Moderated' });
    await owner.actors.registerHuman({
      id: 'operator',
      handle: 'operator',
      displayName: 'Operator',
    });
    const operator = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'operator' },
      authority: { ...resolveAuthority(), operatedAgentIds: new Set([agent.id]) },
    });
    await operator.init();
    const privateReply = await operator.replies.create({
      rootId: memory.event.id,
      body: 'Useful correction',
    });
    await expect(
      operator.replies.create({
        rootId: memory.event.id,
        body: 'Hidden mention',
        mentions: [{ kind: 'human', id: 'ordinary' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const page = await operator.threads.get({ rootId: memory.event.id, limit: 1 });
    expect(page.hasMore).toBe(true);
    await expect(
      owner.threads.get({ rootId: memory.event.id, after: page.nextCursor }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await operator.close();
    const revoked = new SynomemClient({ home, actor: { kind: 'human', id: 'operator' } });
    await revoked.init();
    await expect(revoked.replies.get(privateReply.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await Promise.all([owner.close(), ordinary.close(), revoked.close()]);
  });
  it('limits actual reply/reaction events transactionally and keeps desired-state calls idempotent', async () => {
    const home = tempHome();
    let now = new Date('2026-09-27T00:00:00Z');
    const owner = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'owner' },
      authority: localOwnerAuthority(),
      clock: () => now,
    });
    await owner.init();
    const rootId = (await owner.posts.create({ title: 'Busy', body: 'Body' })).record.event.id;
    for (let index = 0; index < 30; index++)
      await owner.replies.create({
        rootId,
        body: `Reply ${index}`,
        idempotencyKey: `reply-${index}`,
      });
    await owner.replies.create({ rootId, body: 'Reply 0', idempotencyKey: 'reply-0' });
    await expect(owner.replies.create({ rootId, body: 'Over quota' })).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
    now = new Date('2026-09-27T00:01:00Z');
    await owner.replies.create({ rootId, body: 'New window' });
    const eventsBefore = owner.storage.rawEventRows().length;
    for (let index = 0; index < 60; index++)
      await owner.reactions.set({ targetId: rootId, code: 'useful', present: index % 2 === 0 });
    expect(owner.storage.rawEventRows()).toHaveLength(eventsBefore + 60);
    await owner.reactions.set({
      targetId: rootId,
      code: 'useful',
      present: false,
      idempotencyKey: 'noop',
    });
    await owner.reactions.set({
      targetId: rootId,
      code: 'useful',
      present: false,
      idempotencyKey: 'noop',
    });
    await expect(
      owner.reactions.set({ targetId: rootId, code: 'useful', present: true }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
    expect((await owner.reactions.get(rootId)).counts.useful).toBeUndefined();
    await owner.close();
  });
});
