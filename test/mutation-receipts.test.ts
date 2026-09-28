import { describe, expect, it } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { resolveAuthority } from '../src/policy.js';
import { tempHome, testClient } from './helpers.js';
describe('durable mutation receipts', () => {
  it('compares normalized payloads and preserves the original response across later mutations', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const request = {
      recipient: { kind: 'agent' as const, id: 'gracie' },
      title: 'A useful review',
      reason: 'Reviewed the release.',
      idempotencyKey: 'same-key',
    };
    const first = await owner.kudos.give(request);
    const second = await owner.kudos.give({ ...request, title: ' A useful review ', tags: [] });
    expect(second.record).toEqual(first.record);
    expect(second.deduplicated).toBe(true);
    await expect(owner.kudos.give({ ...request, reason: 'Changed reason' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    const note = await owner.notes.create({
      owner: { kind: 'agent', id: 'gracie' },
      title: 'Original',
      body: 'Original',
      idempotencyKey: 'note-create',
    });
    const revision = {
      noteId: note.record.event.id,
      expectedVersion: 1,
      body: 'Revised',
      idempotencyKey: 'revision',
    };
    const revised = await owner.notes.revise(revision);
    await owner.notes.revise({ noteId: note.record.event.id, expectedVersion: 2, body: 'Later' });
    expect(await owner.notes.revise(revision)).toEqual(revised);
    await expect(owner.notes.revise({ ...revision, body: 'Different' })).rejects.toMatchObject({
      code: 'IDEMPOTENCY_CONFLICT',
    });
    await owner.close();
  });
  it('persists no-event receipts and refuses expired or now-unauthorized retries', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const gracie = await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const note = await owner.notes.create({
      owner: { kind: 'agent', id: gracie.id },
      title: 'Knowledge',
      body: 'Private',
    });
    await owner.actors.registerHuman({
      id: 'operator',
      handle: 'operator',
      displayName: 'Operator',
    });
    await owner.close();
    const operator = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'operator' },
      authority: { ...resolveAuthority(), operatedAgentIds: new Set([gracie.id]) },
    });
    await operator.init();
    const request = {
      noteId: note.record.event.id,
      expectedVersion: 1,
      body: 'Managed',
      idempotencyKey: 'operator-edit',
    };
    await operator.notes.revise(request);
    await operator.close();
    const revoked = new SynomemClient({ home, actor: { kind: 'human', id: 'operator' } });
    await revoked.init();
    await expect(revoked.notes.revise(request)).rejects.toMatchObject({ code: 'POLICY_FORBIDDEN' });
    await revoked.close();
    const agent = await testClient(home, { kind: 'agent', id: gracie.id });
    const memo = await agent.memos.send({
      recipient: { kind: 'agent', id: gracie.id },
      subject: 'Self',
      body: 'Read',
    });
    await agent.memos.read({
      expectedVersion: (await agent.memos.get(memo.record.event.id)).lifecycleVersion!,
      memoId: memo.record.event.id,
      idempotencyKey: 'read-once',
    });
    const eventCount = agent.storage.rawEventRows().length;
    const noop = {
      expectedVersion: (await agent.memos.get(memo.record.event.id)).lifecycleVersion!,
      memoId: memo.record.event.id,
      idempotencyKey: 'read-noop',
    };
    await agent.memos.read(noop);
    await agent.memos.read(noop);
    expect(agent.storage.rawEventRows()).toHaveLength(eventCount);
    expect(agent.storage.compactMutationReceipts('9999-01-01T00:00:00.000Z')).toBeGreaterThan(0);
    await expect(agent.memos.read(noop)).rejects.toMatchObject({ code: 'IDEMPOTENCY_EXPIRED' });
    expect(agent.storage.rawEventRows()).toHaveLength(eventCount);
    await agent.close();
  });
  it('checks competing revisions after acquiring the write transaction', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const note = await owner.notes.create({ title: 'Memory', body: 'Original' });
    const other = await testClient(home);
    const results = await Promise.allSettled([
      owner.notes.revise({ noteId: note.record.event.id, expectedVersion: 1, body: 'First' }),
      other.notes.revise({ noteId: note.record.event.id, expectedVersion: 1, body: 'Second' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect((await owner.notes.get(note.record.event.id)).current.version).toBe(2);
    await owner.close();
    await other.close();
  });
});
