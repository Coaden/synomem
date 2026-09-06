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

  it('assigns and transitions tasks with date-aware due values and conflict checks', async () => {
    const home = await seededHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const created = await gracie.tasks.create({
      assigneeAgentId: 'codex',
      title: 'Review migration',
      due: { kind: 'date', date: '2026-09-15' },
      priority: 2,
      idempotencyKey: 'task-1',
    });
    expect(created.record.status).toBe('assigned');
    await expect(gracie.tasks.accept({ taskId: created.record.event.id })).rejects.toMatchObject({
      code: 'MUTATION_FORBIDDEN',
    });
    await expect(gracie.tasks.complete({ taskId: created.record.event.id })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const rejectable = await gracie.tasks.create({
      assigneeAgentId: 'codex',
      title: 'Optional review',
    });
    await gracie.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    expect((await codex.tasks.accept({ taskId: created.record.event.id })).status).toBe('open');
    expect(
      (
        await codex.tasks.reject({
          taskId: rejectable.record.event.id,
          response: 'Outside current scope.',
        })
      ).status,
    ).toBe('rejected');
    const updated = await codex.tasks.update({
      taskId: created.record.event.id,
      expectedVersion: 2,
      description: 'Review schema v3 and rollback behavior.',
      due: { kind: 'datetime', datetime: '2026-09-15T14:00:00-05:00', timeZone: 'America/Chicago' },
    });
    expect(updated.current.version).toBe(3);
    await expect(
      codex.tasks.update({ taskId: created.record.event.id, expectedVersion: 2, title: 'Stale' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    expect((await codex.tasks.complete({ taskId: created.record.event.id })).status).toBe(
      'completed',
    );
    expect((await codex.tasks.reopen({ taskId: created.record.event.id })).status).toBe('open');
    expect(
      (await codex.tasks.cancel({ taskId: created.record.event.id, reason: 'Superseded.' })).status,
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
    await gracie.tasks.create({ assigneeAgentId: 'codex', title: 'Retest' });
    const page = await gracie.items.list({ participantAgentId: 'codex' });
    expect(new Set(page.items.map((item) => item.kind))).toEqual(
      new Set(['kudos', 'memo', 'task']),
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
    const assigned = await gracie.tasks.create({
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

describe('task responses', () => {
  it('requires a reason when rejecting and keeps it in the durable history', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await gracie.agents.create({ id: 'codex', displayName: 'Codex' });
    const assigned = await gracie.tasks.create({
      assigneeAgentId: 'codex',
      title: 'Send the migration notice',
    });
    await gracie.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });

    // A refusal with no reason tells the assigner only that the work will not
    // happen — not whether to reassign it, wait, or change the request.
    await expect(
      // @ts-expect-error a response is required by the type as well as at runtime
      codex.tasks.reject({ taskId: assigned.record.event.id }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const rejected = await codex.tasks.reject({
      taskId: assigned.record.event.id,
      response: 'This Hermes profile has no outbound messaging connection.',
    });
    expect(rejected.status).toBe('rejected');
    expect(rejected.responses).toEqual([
      expect.objectContaining({
        kind: 'rejected',
        response: 'This Hermes profile has no outbound messaging connection.',
      }),
    ]);
    await codex.close();
  });

  it('allows an acceptance response but does not demand one', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await gracie.agents.create({ id: 'codex', displayName: 'Codex' });
    const plain = await gracie.tasks.create({ assigneeAgentId: 'codex', title: 'Plain' });
    const conditional = await gracie.tasks.create({
      assigneeAgentId: 'codex',
      title: 'Conditional',
    });
    await gracie.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    expect((await codex.tasks.accept({ taskId: plain.record.event.id })).status).toBe('open');

    const accepted = await codex.tasks.accept({
      taskId: conditional.record.event.id,
      response: 'Accepted; I can send email but do not have iMessage access.',
    });
    expect(accepted.responses).toEqual([
      expect.objectContaining({
        kind: 'accepted',
        response: 'Accepted; I can send email but do not have iMessage access.',
      }),
    ]);
    await codex.close();
  });
});

describe('private todos', () => {
  it('is owned by its author and readable by nobody else', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await gracie.agents.create({ id: 'codex', displayName: 'Codex' });
    const todo = await gracie.todos.create({
      title: 'Draft the migration checklist',
      details: 'Check the rollback path before the Friday window.',
      priority: 2,
    });
    expect(todo.record.status).toBe('open');
    await gracie.close();

    // Another agent holding the id still cannot read it. Ownership is asserted
    // on the record, not left to a visibility filter.
    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    await expect(codex.todos.get(todo.record.event.id)).rejects.toMatchObject({
      code: 'MUTATION_FORBIDDEN',
    });
    await codex.close();
  });

  it('has no assignee and no acceptance lifecycle', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });

    // Assigning a todo is not a thing that exists. The input rejects it rather
    // than quietly creating a private reminder the "assignee" never sees.
    await expect(
      // @ts-expect-error assigneeAgentId is deliberately absent from the input
      gracie.todos.create({ title: 'Not yours', assigneeAgentId: 'codex' }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });

    const todo = await gracie.todos.create({ title: 'Mine' });
    expect(Object.keys(gracie.todos)).not.toContain('accept');
    expect(Object.keys(gracie.todos)).not.toContain('reject');

    const completed = await gracie.todos.complete({ todoId: todo.record.event.id });
    expect(completed.status).toBe('completed');
    const reopened = await gracie.todos.reopen({ todoId: todo.record.event.id });
    expect(reopened.status).toBe('open');
    const archived = await gracie.todos.archive({ todoId: todo.record.event.id });
    expect(archived.status).toBe('archived');
    await gracie.close();
  });

  it('keeps todos out of another actor’s item list', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    await gracie.agents.create({ id: 'codex', displayName: 'Codex' });
    await gracie.todos.create({ title: 'Private reminder' });
    const own = await gracie.todos.list();
    expect(own.items).toHaveLength(1);
    await gracie.close();

    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    const others = await codex.todos.list();
    expect(others.items).toHaveLength(0);
    await codex.close();
  });

  it('versions updates optimistically like every other record', async () => {
    const home = tempHome();
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const todo = await gracie.todos.create({ title: 'First' });
    const updated = await gracie.todos.update({
      todoId: todo.record.event.id,
      expectedVersion: 1,
      title: 'Second',
      priority: 1,
    });
    expect(updated.current.title).toBe('Second');
    expect(updated.current.priority).toBe(1);
    expect(updated.current.version).toBe(2);
    await expect(
      gracie.todos.update({ todoId: todo.record.event.id, expectedVersion: 1, title: 'Stale' }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    await gracie.close();
  });
});
