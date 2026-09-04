import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { tempHome, testClient } from './helpers.js';

async function seededHome() {
  const home = tempHome();
  const admin = await testClient(home, { kind: 'human', id: 'troy' });
  await admin.agents.create({ id: 'codex', displayName: 'Codex' });
  await admin.agents.create({ id: 'gracie', displayName: 'Gracie' });
  await admin.agents.create({ id: 'mycroft', displayName: 'Mycroft' });
  await admin.close();
  return home;
}

describe('Synomem domains', () => {
  it('delivers self and peer memos with recipient-scoped state and idempotency', async () => {
    const home = await seededHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const sent = await gracie.memos.send({
      recipientAgentId: 'codex',
      subject: 'Review result',
      body: 'The continuity check is complete.',
      visibility: 'private',
      idempotencyKey: 'memo-1',
    });
    expect(
      (
        await gracie.memos.send({
          recipientAgentId: 'codex',
          subject: 'Review result',
          body: 'The continuity check is complete.',
          visibility: 'private',
          idempotencyKey: 'memo-1',
        })
      ).deduplicated,
    ).toBe(true);
    const self = await gracie.memos.send({
      recipientAgentId: 'gracie',
      subject: 'Future reminder',
      body: 'Recheck the decision after implementation.',
    });
    expect(self.record.status).toBe('unread');
    await gracie.close();

    const mycroft = await testClient(home, { kind: 'agent', id: 'mycroft' });
    await expect(mycroft.memos.get(sent.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await expect(mycroft.memos.read({ memoId: sent.record.event.id })).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await mycroft.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    expect((await codex.memos.read({ memoId: sent.record.event.id })).status).toBe('read');
    expect((await codex.memos.archive({ memoId: sent.record.event.id })).status).toBe('archived');
    expect(existsSync(join(home, 'codex', 'inbox', 'memos', `${sent.record.event.id}.md`))).toBe(
      false,
    );
    await codex.close();
  });

  it('keeps notes owner-scoped, versioned, and separate from human NOTES.md', async () => {
    const home = await seededHome();
    const scratch = join(home, 'codex', 'NOTES.md');
    writeFileSync(scratch, 'Human scratchpad.\n');
    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    const created = await codex.notes.create({
      title: 'Release invariant',
      body: 'Never publish from an automated development session.',
      idempotencyKey: 'note-1',
    });
    expect(created.record.current.version).toBe(1);
    const revised = await codex.notes.revise({
      noteId: created.record.event.id,
      expectedVersion: 1,
      body: 'Never publish without explicit maintainer authorization.',
    });
    expect(revised.current).toMatchObject({
      version: 2,
      body: 'Never publish without explicit maintainer authorization.',
    });
    await expect(
      codex.notes.revise({
        noteId: created.record.event.id,
        expectedVersion: 1,
        body: 'Stale revision.',
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect(readFileSync(scratch, 'utf8')).toBe('Human scratchpad.\n');
    expect(readFileSync(join(home, 'codex', 'MEMORY.md'), 'utf8')).toContain('Release invariant');
    await codex.close();

    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await expect(gracie.notes.get(created.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await gracie.close();
  });

  it('assigns and transitions todos with date-aware due values and conflict checks', async () => {
    const home = await seededHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const created = await gracie.todos.create({
      assigneeAgentId: 'codex',
      title: 'Review migration',
      due: { kind: 'date', date: '2026-09-15' },
      priority: 2,
      idempotencyKey: 'todo-1',
    });
    expect(created.record.status).toBe('assigned');
    await expect(gracie.todos.accept({ todoId: created.record.event.id })).rejects.toMatchObject({
      code: 'MUTATION_FORBIDDEN',
    });
    await expect(gracie.todos.complete({ todoId: created.record.event.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const rejectable = await gracie.todos.create({
      assigneeAgentId: 'codex',
      title: 'Optional review',
    });
    await gracie.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    expect((await codex.todos.accept({ todoId: created.record.event.id })).status).toBe('open');
    expect(
      (
        await codex.todos.reject({
          todoId: rejectable.record.event.id,
          reason: 'Outside current scope.',
        })
      ).status,
    ).toBe('rejected');
    const updated = await codex.todos.update({
      todoId: created.record.event.id,
      expectedVersion: 2,
      description: 'Review schema v3 and rollback behavior.',
      due: { kind: 'datetime', datetime: '2026-09-15T14:00:00-05:00', timeZone: 'America/Chicago' },
    });
    expect(updated.current.version).toBe(3);
    await expect(
      codex.todos.update({ todoId: created.record.event.id, expectedVersion: 2, title: 'Stale' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await codex.todos.complete({ todoId: created.record.event.id })).status).toBe(
      'completed',
    );
    expect((await codex.todos.reopen({ todoId: created.record.event.id })).status).toBe('open');
    expect(
      (await codex.todos.cancel({ todoId: created.record.event.id, reason: 'Superseded.' })).status,
    ).toBe('canceled');
    expect(readFileSync(join(home, 'codex', 'TODOS.md'), 'utf8')).toContain('Review migration');
    await codex.close();
  });

  it('provides one bounded, privacy-aware mixed item feed and change stream', async () => {
    const home = await seededHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await gracie.kudos.give({
      recipientAgentId: 'codex',
      title: 'Good review',
      reason: 'Caught a flaw.',
    });
    await gracie.memos.send({
      recipientAgentId: 'codex',
      subject: 'Follow-up',
      body: 'Please retest.',
    });
    await gracie.todos.create({ assigneeAgentId: 'codex', title: 'Retest' });
    const page = await gracie.items.list({ participantAgentId: 'codex' });
    expect(new Set(page.items.map((item) => item.kind))).toEqual(
      new Set(['kudos', 'memo', 'todo']),
    );
    expect(page.items.every((item) => !('body' in item) && !('reason' in item))).toBe(true);
    const changes = await gracie.items.changes({ after: page.watermark });
    expect(changes.items).toHaveLength(0);
    await gracie.close();

    const readonly = new SynomemClient({
      home,
      actor: { kind: 'agent', id: 'codex' },
      readOnly: true,
    });
    await readonly.init();
    expect((await readonly.items.list()).items.length).toBeGreaterThanOrEqual(3);
    await readonly.close();
  });

  it('filters actionable inbox states before applying the page limit', async () => {
    const home = await seededHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const oldMemo = await gracie.memos.send({
      recipientAgentId: 'codex',
      subject: 'Already read',
      body: 'This should not consume an inbox slot.',
    });
    await gracie.memos.send({
      recipientAgentId: 'codex',
      subject: 'Still unread',
      body: 'This should be returned.',
    });
    const assigned = await gracie.todos.create({
      assigneeAgentId: 'codex',
      title: 'Needs consent',
    });
    await gracie.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    await codex.memos.read({ memoId: oldMemo.record.event.id });
    const first = await codex.items.list({ participantAgentId: 'codex', pending: true, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.items[0]?.status).not.toBe('read');
    const all = await codex.items.list({ participantAgentId: 'codex', pending: true, limit: 10 });
    expect(all.items.map((item) => item.id)).toContain(assigned.record.event.id);
    expect(all.items.some((item) => item.status === 'read')).toBe(false);
    await codex.close();
  });

  it('keeps actor kinds distinct for private item reads and change feeds', async () => {
    const home = await seededHome();
    const admin = await testClient(home, { kind: 'human', id: 'troy' });
    await admin.agents.create({ id: 'bob', displayName: 'Agent Bob' });
    await admin.close();

    const humanBob = await testClient(home, { kind: 'human', id: 'bob' });
    const memo = await humanBob.memos.send({
      recipientAgentId: 'codex',
      subject: 'Human-authored private memo',
      body: 'An agent with the same textual ID is not this author.',
      visibility: 'private',
    });
    await humanBob.close();

    const agentBob = await testClient(home, { kind: 'agent', id: 'bob' });
    await expect(agentBob.memos.get(memo.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    expect((await agentBob.items.list()).items.map((item) => item.id)).not.toContain(
      memo.record.event.id,
    );
    expect((await agentBob.items.changes()).items.map((item) => item.itemId)).not.toContain(
      memo.record.event.id,
    );
    await agentBob.close();
  });
});
