import { describe, expect, it } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { localOwnerAuthority } from '../src/policy.js';
import { tempHome, testClient } from './helpers.js';

describe('personal durable inbox', () => {
  it('notifies canonical post mentions once, and edits notify only newly added actors', async () => {
    const home = tempHome(),
      owner = await testClient(home);
    await owner.actors.registerHuman({ id: 'morgan-id', handle: 'morgan', displayName: 'Morgan' });
    await owner.actors.registerHuman({ id: 'alex-id', handle: 'alex', displayName: 'Alex' });
    const morgan = await testClient(
      home,
      { kind: 'human', id: 'morgan-id' },
      { authority: undefined },
    );
    const alex = await testClient(home, { kind: 'human', id: 'alex-id' }, { authority: undefined });
    const post = await owner.posts.create({
      title: 'Mention post',
      body: 'Explicit references',
      mentions: [
        { kind: 'human', id: 'morgan' },
        { kind: 'human', id: 'morgan-id' },
      ],
    });
    expect(post.record.mentions).toEqual([{ kind: 'human', id: 'morgan-id' }]);
    expect((await morgan.notifications.list({ view: 'all' })).items).toHaveLength(1);
    await owner.posts.update({
      postId: post.record.event.id,
      expectedVersion: 1,
      title: 'Updated',
      mentions: [
        { kind: 'human', id: 'morgan-id' },
        { kind: 'human', id: 'alex-id' },
      ],
    });
    expect((await morgan.notifications.list({ view: 'all' })).items).toHaveLength(1);
    expect((await alex.notifications.list({ view: 'all' })).items[0]!.reasonCodes).toEqual([
      'mention',
    ]);
    await owner.posts.update({
      postId: post.record.event.id,
      expectedVersion: 2,
      body: 'No mention changes',
    });
    expect((await owner.posts.get(post.record.event.id)).mentions).toHaveLength(2);
    await expect(
      owner.posts.create({
        title: 'Bad mention',
        body: 'No grant',
        mentions: [{ kind: 'human', id: 'unknown' }],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    await owner.rebuild();
    expect((await morgan.notifications.list({ view: 'all' })).items).toHaveLength(1);
    await Promise.all([owner.close(), morgan.close(), alex.close()]);
  });
  it('separates notification read state from lifecycle actions and binds every read to its actor', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const agent = await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const recipient = await testClient(home, { kind: 'agent', id: agent.id });
    const memo = await owner.memos.send({
      recipient: { kind: 'agent', id: agent.id },
      subject: 'Private memo',
      body: 'Body',
      visibility: 'private',
    });
    expect((await owner.notifications.list({ view: 'all' })).items).toHaveLength(0);
    const inbox = await recipient.notifications.list({ view: 'all' });
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({
      rootId: memo.record.event.id,
      read: false,
      actionRequired: true,
    });
    await expect(owner.notifications.read(inbox.items[0]!.id)).rejects.toMatchObject({
      code: 'ITEM_NOT_FOUND',
    });
    await recipient.notifications.read(inbox.items[0]!.id);
    expect((await recipient.memos.get(memo.record.event.id)).status).toBe('unread');
    expect((await recipient.notifications.list()).items).toHaveLength(1);
    await recipient.memos.read({
      expectedVersion: (await recipient.memos.get(memo.record.event.id)).lifecycleVersion!,
      memoId: memo.record.event.id,
    });
    expect((await owner.notifications.list()).items[0]?.reasonCodes).toContain('response');
    expect((await recipient.notifications.list()).items).toHaveLength(0);
    await Promise.all([owner.close(), recipient.close()]);
  });
  it('freezes followers, publishes delayed deliveries after cursors and honors rendered thread read watermarks', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.actors.registerHuman({
      id: 'follower',
      handle: 'follower',
      displayName: 'Follower',
    });
    await owner.actors.registerHuman({ id: 'late', handle: 'late', displayName: 'Late' });
    const follower = new SynomemClient({ home, actor: { kind: 'human', id: 'follower' } });
    await follower.init();
    const late = new SynomemClient({ home, actor: { kind: 'human', id: 'late' } });
    await late.init();
    const rootId = (await owner.posts.create({ title: 'Post', body: 'Body' })).record.event.id;
    await follower.threads.subscription({ rootId, following: true, muted: false });
    const reply = await owner.replies.create({ rootId, body: 'Frozen followers' });
    await late.threads.subscription({ rootId, following: true, muted: false });
    const thread = await follower.threads.get({ rootId });
    await follower.threads.read({ rootId, through: thread.watermark });
    const page = await follower.notifications.list({ view: 'all' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]).toMatchObject({ replyId: reply.id, read: true });
    expect((await late.notifications.list({ view: 'all' })).items).toHaveLength(0);
    const second = await owner.replies.create({ rootId, body: 'Later followers' });
    expect((await late.notifications.list({ view: 'all' })).items[0]?.replyId).toBe(second.id);
    await Promise.all([owner.close(), follower.close(), late.close()]);
  });
  it('marks only the signed inbox snapshot and never reuses pruned delivery sequences', async () => {
    const home = tempHome();
    let now = new Date('2026-01-01T00:00:00Z');
    const owner = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'owner' },
      authority: localOwnerAuthority(),
      clock: () => now,
    });
    await owner.init();
    const memo = await owner.memos.send({
      recipient: { kind: 'human', id: 'owner' },
      subject: 'First',
      body: 'Self memo',
    });
    const snapshot = await owner.notifications.list({ view: 'all' });
    const second = await owner.memos.send({
      recipient: { kind: 'human', id: 'owner' },
      subject: 'Second',
      body: 'After snapshot',
    });
    await owner.notifications.readThrough(snapshot.watermark);
    const page = await owner.notifications.list({ view: 'all' });
    expect(page.items.find((row) => row.rootId === memo.record.event.id)?.read).toBe(true);
    expect(page.items.find((row) => row.rootId === second.record.event.id)?.read).toBe(false);
    expect(
      await owner.storage.transaction(() =>
        owner.storage.notifications.prune('2027-01-01T00:00:00.000Z'),
      ),
    ).toBe(0);
    await owner.memos.read({
      expectedVersion: (await owner.memos.get(memo.record.event.id)).lifecycleVersion!,
      memoId: memo.record.event.id,
    });
    await owner.memos.read({
      expectedVersion: (await owner.memos.get(second.record.event.id)).lifecycleVersion!,
      memoId: second.record.event.id,
    });
    expect(
      await owner.storage.transaction(() =>
        owner.storage.notifications.prune('2027-01-01T00:00:00.000Z'),
      ),
    ).toBe(2);
    now = new Date('2027-01-01T00:00:00Z');
    await owner.memos.send({
      recipient: { kind: 'human', id: 'owner' },
      subject: 'Third',
      body: 'After pruning',
    });
    const next = await owner.notifications.list({ view: 'all' });
    expect(BigInt(next.items[0]!.deliverySequence)).toBeGreaterThan(
      BigInt(page.items.at(-1)!.deliverySequence),
    );
    await owner.close();
  });
});
