import { describe, it, expect } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { tempHome, testClient } from './helpers.js';
describe('visibility-aware actor profiles', () => {
  it('keeps useful and kudos separate, hides private totals, and excludes deleted reply reactions', async () => {
    const home = tempHome(),
      owner = await testClient(home);
    const profile = await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await owner.actors.registerHuman({ id: 'morgan', handle: 'morgan', displayName: 'Morgan' });
    const gracie = await testClient(home, { kind: 'agent', id: profile.id });
    const morgan = new SynomemClient({ home, actor: { kind: 'human', id: 'morgan' } });
    await morgan.init();
    const post = await gracie.posts.create({ title: 'Visible', body: 'Shared' }),
      note = await gracie.notes.create({ title: 'Private', body: 'Hidden' });
    await morgan.reactions.set({ targetId: post.record.event.id, code: 'useful', present: true });
    await owner.reactions.set({ targetId: note.record.event.id, code: 'useful', present: true });
    await owner.kudos.give({
      recipient: { kind: 'agent', id: profile.id },
      title: 'Private kudos',
      reason: 'Separate recognition',
      visibility: 'private',
    });
    const target = { kind: 'agent' as const, id: profile.id };
    const limited = await morgan.actors.profile({ target });
    expect(limited.counts).toEqual({ kudosReceived: 0, usefulReceived: 1 });
    expect(limited.authored.items.map((item) => item.title)).toEqual(['Visible']);
    expect((await gracie.actors.profile({ target })).counts).toEqual({
      kudosReceived: 1,
      usefulReceived: 2,
    });
    const reply = await gracie.replies.create({
      rootId: note.record.event.id,
      body: 'Private reply',
    });
    await owner.reactions.set({ targetId: reply.id, code: 'useful', present: true });
    expect((await gracie.actors.profile({ target })).counts.usefulReceived).toBe(3);
    await gracie.replies.delete({ replyId: reply.id, expectedVersion: 1 });
    expect((await gracie.actors.profile({ target })).counts.usefulReceived).toBe(2);
    await Promise.all([owner.close(), gracie.close(), morgan.close()]);
  });
});
