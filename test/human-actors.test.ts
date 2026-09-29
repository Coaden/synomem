import { describe, expect, it } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { tempHome, testClient } from './helpers.js';

describe('human participation targets', () => {
  it('finds active typed actors beyond the first directory page with bounded queries', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    for (let index = 0; index < 105; index++)
      await owner.actors.registerHuman({
        id: `person-${index}`,
        handle: `person_${String(index).padStart(3, '0')}`,
        displayName: `Person ${index}`,
      });
    const first = await owner.actors.list();
    expect(first.items).toHaveLength(20);
    expect(first.nextCursor).toBeTruthy();
    const seen = new Set(first.items.map((actor) => `${actor.kind}:${actor.id}`));
    let cursor = first.nextCursor;
    while (cursor) {
      const page = await owner.actors.list({ cursor });
      for (const actor of page.items) {
        expect(seen.has(`${actor.kind}:${actor.id}`)).toBe(false);
        seen.add(`${actor.kind}:${actor.id}`);
      }
      cursor = page.nextCursor;
    }
    expect(seen.size).toBeGreaterThan(100);
    expect(
      (await owner.actors.list({ query: 'person_104', kind: 'human', limit: 5 })).items,
    ).toEqual([expect.objectContaining({ kind: 'human', id: 'person-104' })]);
    await expect(
      owner.actors.list({ cursor: first.nextCursor, kind: 'agent' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    const other = new SynomemClient({ home, actor: { kind: 'human', id: 'person-1' } });
    await other.init();
    await expect(other.actors.list({ cursor: first.nextCursor })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await other.close();
    await expect(owner.actors.list({ query: 'x'.repeat(101) })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await expect(owner.actors.list({ limit: 51 })).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await owner.close();
  });
  it('delivers kudos, memos and tasks to a registered human and keeps memory owner-only', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.actors.registerHuman({ id: 'morgan', handle: 'morgan', displayName: 'Morgan' });
    await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const morgan = new SynomemClient({ home, actor: { kind: 'human', id: 'morgan' } });
    await morgan.init();
    const kudos = await owner.kudos.give({
      recipient: { kind: 'human', id: 'morgan' },
      title: 'Review complete',
      reason: 'Checked the release.',
    });
    const memo = await owner.memos.send({
      recipient: { kind: 'human', id: 'morgan' },
      subject: 'Release',
      body: 'Please review.',
    });
    const task = await owner.tasks.create({
      assignee: { kind: 'human', id: 'morgan' },
      title: 'Review release',
    });
    const note = await morgan.notes.create({ title: 'My memory', body: 'Personal context.' });
    const todo = await morgan.todos.create({ title: 'My reminder' });
    expect(note.record.event.owner).toEqual({ kind: 'human', id: 'morgan' });
    expect(todo.record.event.owner).toEqual({ kind: 'human', id: 'morgan' });
    expect(task.record.status).toBe('assigned');
    expect(
      (
        await morgan.kudos.acknowledge({
          expectedVersion: (await morgan.kudos.get(kudos.record.event.id)).lifecycleVersion!,
          kudosId: kudos.record.event.id,
        })
      ).status,
    ).toBe('acknowledged');
    await expect(
      owner.memos.read({
        expectedVersion: (await owner.memos.get(memo.record.event.id)).lifecycleVersion!,
        memoId: memo.record.event.id,
      }),
    ).rejects.toMatchObject({
      code: 'MUTATION_FORBIDDEN',
    });
    expect(
      (
        await morgan.memos.read({
          expectedVersion: (await morgan.memos.get(memo.record.event.id)).lifecycleVersion!,
          memoId: memo.record.event.id,
        })
      ).status,
    ).toBe('read');
    expect(
      (
        await morgan.tasks.accept({
          expectedVersion: (await morgan.tasks.get(task.record.event.id)).lifecycleVersion!,
          taskId: task.record.event.id,
        })
      ).status,
    ).toBe('open');
    const self = await morgan.tasks.create({ title: 'Own work' });
    expect(self.record.status).toBe('open');
    const outsider = new SynomemClient({ home, actor: { kind: 'human', id: 'outsider' } });
    await outsider.init();
    await expect(outsider.notes.get(note.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    expect((await outsider.items.list({ kinds: ['note', 'todo'] })).items).toEqual([]);
    await outsider.close();
    await morgan.close();
    await owner.close();
  });
  it('keeps actor kind in private visibility and participant filters', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    const agent = await owner.agents.create({ handle: 'same', displayName: 'Agent same' });
    await owner.actors.registerHuman({ id: agent.id, handle: 'same', displayName: 'Human same' });
    const memo = await owner.memos.send({
      recipient: { kind: 'agent', id: agent.id },
      subject: 'Agent only',
      body: 'Private',
      visibility: 'private',
    });
    const human = new SynomemClient({ home, actor: { kind: 'human', id: agent.id } });
    await human.init();
    expect(
      (await human.items.list({ participant: { kind: 'human', id: agent.id } })).items,
    ).toEqual([]);
    await expect(human.items.get(memo.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await human.close();
    await owner.close();
  });
});
