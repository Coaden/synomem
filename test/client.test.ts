import { describe, expect, it } from 'vitest';
import { SynomemError } from '../src/index.js';
import { tempHome, testClient } from './helpers.js';

async function seed(home: string) {
  const human = await testClient(home);
  await human.agents.create({ handle: 'codex', displayName: 'Codex', aliases: ['reviewer'] });
  await human.agents.create({ handle: 'gracie', displayName: 'Gracie' });
  return human;
}

describe('SynomemClient identities and events', () => {
  it('creates, resolves, lists, and updates identities without rewriting history', async () => {
    const home = tempHome();
    const client = await seed(home);
    expect((await client.agents.get('reviewer')).handle).toBe('codex');
    expect((await client.agents.list()).map((agent) => agent.handle)).toEqual(['codex', 'gracie']);
    const before = client.storage.getEvents();
    await client.agents.update('codex', { displayName: 'Codex Prime', aliases: ['code-reviewer'] });
    expect((await client.agents.get('code-reviewer')).displayName).toBe('Codex Prime');
    expect(client.storage.getEvents()).toHaveLength(before.length + 1);
    expect(client.storage.getEvents()[0]).toEqual(before[0]);
    await client.close();
  });

  it('rejects alias conflicts deterministically', async () => {
    const home = tempHome();
    const client = await seed(home);
    await expect(
      client.agents.create({ handle: 'mycroft', displayName: 'Mycroft', aliases: ['reviewer'] }),
    ).rejects.toMatchObject({ code: 'ALIAS_CONFLICT' });
    await client.close();
  });

  it('deduplicates by actor kind, actor ID, and idempotency key', async () => {
    const home = tempHome();
    const human = await seed(home);
    await human.close();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const first = await gracie.kudos.give({
      recipientAgentId: 'codex',
      title: 'Excellent review',
      reason: 'Caught a consequential contradiction before implementation.',
      idempotencyKey: 'review-e17',
    });
    const retry = await gracie.kudos.give({
      recipientAgentId: 'codex',
      title: 'Ignored replacement title',
      reason: 'This retry returns the original event.',
      idempotencyKey: 'review-e17',
    });
    expect(first.created).toBe(true);
    expect(retry.deduplicated).toBe(true);
    expect(retry.record.event.id).toBe(first.record.event.id);
    expect(retry.record.event.title).toBe('Excellent review');
    await gracie.memos.send({
      recipientAgentId: 'codex',
      subject: 'Cross-domain key',
      body: 'Reserve this idempotency key for a memo.',
      idempotencyKey: 'cross-domain-key',
    });
    await expect(
      gracie.kudos.give({
        recipientAgentId: 'codex',
        title: 'Conflicting key',
        reason: 'Must fail with a stable domain error rather than leaking SQLite details.',
        idempotencyKey: 'cross-domain-key',
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    await gracie.close();

    const troy = await testClient(home, { kind: 'human', id: 'gracie' });
    const otherScope = await troy.kudos.give({
      recipientAgentId: 'codex',
      title: 'Human recognition',
      reason: 'The same textual key is valid for a different actor kind.',
      idempotencyKey: 'review-e17',
    });
    expect(otherScope.created).toBe(true);
    await troy.close();
  });

  it('enforces self-award, acknowledgment, and revocation policies', async () => {
    const home = tempHome();
    const human = await seed(home);
    await human.close();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await expect(
      gracie.kudos.give({ recipientAgentId: 'gracie', title: 'Me', reason: 'Self praise.' }),
    ).rejects.toMatchObject({ code: 'SELF_AWARD_FORBIDDEN' });
    const given = await gracie.kudos.give({
      recipientAgentId: 'codex',
      title: 'Found the bug',
      reason: 'Identified the exact failing invariant.',
    });
    await gracie.close();

    const unrelated = await testClient(home, { kind: 'agent', id: 'gracie' });
    await expect(
      unrelated.kudos.acknowledge({ kudosId: given.record.event.id }),
    ).rejects.toMatchObject({
      code: 'ACKNOWLEDGMENT_FORBIDDEN',
    });
    await unrelated.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    const acknowledged = await codex.kudos.acknowledge({
      kudosId: given.record.event.id,
      note: 'Received with robotic humility.',
    });
    expect(acknowledged.status).toBe('acknowledged');
    await codex.close();

    const giver = await testClient(home, { kind: 'agent', id: 'gracie' });
    const revoked = await giver.kudos.revoke({
      kudosId: given.record.event.id,
      reason: 'The underlying evidence was later corrected.',
    });
    expect(revoked.revocationStatus).toBe('revoked');
    expect(revoked.revocation?.mode).toBe('actor-requested');
    await giver.close();
  });

  it('does not grant system actors implicit agent or administrator authority', async () => {
    const home = tempHome();
    const human = await seed(home);
    const given = await human.kudos.give({
      recipientAgentId: 'codex',
      title: 'Policy boundary',
      reason: 'Provides a record for authorization checks.',
    });
    const privateGiven = await human.kudos.give({
      recipientAgentId: 'codex',
      title: 'Private agent record',
      reason: 'A matching system ID must not inherit agent recipient access.',
      visibility: 'private',
    });
    /*
     * The system actor deliberately takes the AGENT'S CANONICAL ID, not its
     * handle. Opaque IDs make an accidental collision far harder — a system
     * actor called `codex` is now simply a different actor — so the invariant
     * has to be tested against the id that would actually collide.
     */
    const codexId = (await human.agents.get('codex')).id;
    await human.close();

    const system = await testClient(home, { kind: 'system', id: codexId });
    await expect(system.kudos.get(privateGiven.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    expect((await system.kudos.list()).items.map((item) => item.id)).not.toContain(
      privateGiven.record.event.id,
    );
    await expect(
      system.kudos.give({
        recipientAgentId: 'codex',
        title: 'System self award',
        reason: 'A system identity must not impersonate its matching agent ID.',
      }),
    ).rejects.toMatchObject({ code: 'SELF_AWARD_FORBIDDEN' });
    await expect(
      system.kudos.acknowledge({ kudosId: given.record.event.id }),
    ).rejects.toMatchObject({ code: 'ACKNOWLEDGMENT_FORBIDDEN' });
    await expect(
      system.kudos.revoke({
        kudosId: given.record.event.id,
        reason: 'Unauthorized administrative request.',
        administrative: true,
      }),
    ).rejects.toMatchObject({ code: 'REVOCATION_FORBIDDEN' });
    await expect(
      system.kudos.revoke({
        kudosId: given.record.event.id,
        reason: 'Unauthorized non-administrative request.',
      }),
    ).rejects.toMatchObject({ code: 'REVOCATION_FORBIDDEN' });
    await system.close();
  });

  it('enforces private kudos visibility in the public library API', async () => {
    const home = tempHome();
    const human = await seed(home);
    await human.agents.create({ handle: 'mycroft', displayName: 'Mycroft' });
    await human.close();

    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const secret = await gracie.kudos.give({
      recipientAgentId: 'codex',
      title: 'Private recognition',
      reason: 'Confidential contribution details.',
      visibility: 'private',
    });
    await gracie.close();

    const mycroft = await testClient(home, { kind: 'agent', id: 'mycroft' });
    await expect(mycroft.kudos.get(secret.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await mycroft.close();
  });

  it('supports every list filter, deterministic ordering, and pagination', async () => {
    const home = tempHome();
    const human = await seed(home);
    const first = await human.kudos.give({
      recipientAgentId: 'codex',
      title: 'Review',
      reason: 'Reviewed the migration.',
      tags: ['review'],
      visibility: 'public',
    });
    await human.kudos.give({
      recipientAgentId: 'gracie',
      title: 'Research',
      reason: 'Found the primary source.',
      tags: ['research'],
      visibility: 'private',
    });
    await human.kudos.acknowledge({ kudosId: first.record.event.id });
    expect((await human.kudos.list({ recipientAgentId: 'reviewer' })).total).toBe(1);
    expect((await human.kudos.list({ actorId: 'troy', actorKind: 'human' })).total).toBe(2);
    expect((await human.kudos.list({ tag: 'review' })).total).toBe(1);
    expect((await human.kudos.list({ status: 'acknowledged' })).total).toBe(1);
    expect((await human.kudos.list({ visibility: 'private' })).total).toBe(1);
    expect((await human.kudos.list({ revoked: true })).total).toBe(0);
    expect((await human.kudos.list({ from: '2000-01-01T00:00:00.000Z' })).total).toBe(2);
    expect((await human.kudos.list({ to: '2000-01-01T00:00:00.000Z' })).total).toBe(0);
    const page = await human.kudos.list({ limit: 1, offset: 1 });
    expect(page.total).toBe(2);
    expect(page.items).toHaveLength(1);
    const all = await human.kudos.list({ limit: 10 });
    expect(all.items[0]!.createdAt >= all.items[1]!.createdAt).toBe(true);
    expect(all.items[0]).not.toHaveProperty('reason');
    expect(all.items[0]).not.toHaveProperty('evidence');
    const firstPage = await human.kudos.list({ limit: 1 });
    const next = await human.kudos.list({ limit: 1, cursor: firstPage.nextCursor! });
    expect(next.items[0]?.id).not.toBe(firstPage.items[0]?.id);
    const stats = await human.stats();
    expect(stats.total).toBe(1);
    expect(stats.byTag.review).toBe(1);
    await human.close();
  });

  it('supports read-only inspection and rejects writes', async () => {
    const home = tempHome();
    const writable = await seed(home);
    await writable.close();
    const readonly = await testClient(home, { kind: 'system', id: 'auditor' }, { readOnly: true });
    expect(await readonly.agents.list()).toHaveLength(2);
    await expect(
      readonly.agents.create({ handle: 'mycroft', displayName: 'Mycroft' }),
    ).rejects.toBeInstanceOf(SynomemError);
    await readonly.close();
  });

  it('returns only changes after a durable opaque watermark', async () => {
    const home = tempHome();
    const human = await seed(home);
    await human.kudos.give({
      recipientAgentId: 'codex',
      title: 'Baseline contribution',
      reason: 'Establishes the initial synchronization point.',
    });
    const watermark = (await human.kudos.list()).watermark;
    const later = await human.kudos.give({
      recipientAgentId: 'gracie',
      title: 'Later contribution',
      reason: 'Was recorded after the synchronization point.',
    });
    await human.kudos.acknowledge({ kudosId: later.record.event.id });

    const changes = await human.kudos.changes({ after: watermark });
    expect(changes.items.map((item) => item.type)).toEqual(['kudos.given', 'kudos.acknowledged']);
    expect(changes.items.every((item) => item.kudosId === later.record.event.id)).toBe(true);
    expect(changes.items[0]?.summary).not.toHaveProperty('reason');
    const caughtUp = await human.kudos.changes({ after: changes.nextCursor });
    expect(caughtUp.items).toEqual([]);
    expect(caughtUp.nextCursor).toBeDefined();
    await human.close();
  });
});
