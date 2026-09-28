import { describe, expect, it } from 'vitest';
import { SynomemClient, SynomemCore } from '../src/client.js';
import { localOwnerAuthority, resolveAuthority, sameActor } from '../src/policy.js';
import { SynomemStorage } from '../src/storage.js';
import { tempHome, testClient } from './helpers.js';
const noProjections = { syncAgent: () => ({ generated: [], removed: [] }) };
describe('explicit record authority', () => {
  it('does not infer private-record administration from a human identity', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const agent = await testClient(home, { kind: 'agent', id: 'gracie' });
    const note = await agent.notes.create({ title: 'Private memory', body: 'Agent knowledge.' });
    const todo = await agent.todos.create({ title: 'Private reminder' });
    await agent.close();
    await owner.actors.registerHuman({ id: 'member', handle: 'member', displayName: 'Member' });
    await owner.actors.registerHuman({
      id: 'operator',
      handle: 'operator',
      displayName: 'Operator',
    });
    await owner.close();
    const member = new SynomemClient({ home, actor: { kind: 'human', id: 'member' } });
    await member.init();
    expect((await member.items.list()).items).toEqual([]);
    expect((await member.items.changes()).items).toEqual([]);
    await expect(member.notes.get(note.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await expect(member.todos.get(todo.record.event.id)).rejects.toMatchObject({
      code: 'MUTATION_FORBIDDEN',
    });
    await member.close();
    const core = new SynomemCore({
      repository: new SynomemStorage({ home, readOnly: false }),
      projectionWriter: noProjections,
      actor: { kind: 'human', id: 'member' },
    });
    await core.init();
    await expect(
      core.notes.revise({ noteId: note.record.event.id, expectedVersion: 1, body: 'Overwritten' }),
    ).rejects.toMatchObject({ code: 'POLICY_FORBIDDEN' });
    await core.close();
  });
  it('lets an operator list, open and manage only the agent they operate', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await owner.agents.create({ handle: 'codex', displayName: 'Codex' });
    const gracie = await testClient(home, { kind: 'agent', id: 'gracie' });
    const codex = await testClient(home, { kind: 'agent', id: 'codex' });
    const note = await gracie.notes.create({ title: 'Gracie memory', body: 'Current knowledge.' });
    const todo = await gracie.todos.create({ title: 'Gracie reminder' });
    const unrelated = await codex.notes.create({ title: 'Codex memory', body: 'Hidden.' });
    await gracie.close();
    await codex.close();
    await owner.actors.registerHuman({ id: 'member', handle: 'member', displayName: 'Member' });
    await owner.actors.registerHuman({
      id: 'operator',
      handle: 'operator',
      displayName: 'Operator',
    });
    await owner.close();
    const authority = {
      ...resolveAuthority(),
      operatedAgentIds: new Set([note.record.event.owner?.id]),
    };
    const operator = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'operator' },
      authority,
    });
    await operator.init();
    expect((await operator.items.list()).items.map((i) => i.id).sort()).toEqual(
      [note.record.event.id, todo.record.event.id].sort(),
    );
    expect((await operator.items.changes()).items).toHaveLength(2);
    const changed = await operator.notes.revise({
      noteId: note.record.event.id,
      expectedVersion: 1,
      body: 'Revised by operator.',
    });
    expect(changed.revision?.actor).toMatchObject({ kind: 'human', id: 'operator' });
    expect(
      (
        await operator.todos.complete({
          expectedVersion: (await operator.todos.get(todo.record.event.id)).lifecycleVersion!,
          todoId: todo.record.event.id,
        })
      ).status,
    ).toBe('completed');
    await expect(operator.notes.get(unrelated.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await operator.close();
    const revoked = new SynomemClient({ home, actor: { kind: 'human', id: 'operator' } });
    await revoked.init();
    expect((await revoked.items.list()).items).toEqual([]);
    await expect(revoked.notes.get(note.record.event.id)).rejects.toMatchObject({
      code: 'POLICY_FORBIDDEN',
    });
    await revoked.close();
  });
  it('does not elevate agent/system contexts or collide actor kinds', () => {
    expect(sameActor({ kind: 'human', id: 'same' }, { kind: 'agent', id: 'same' })).toBe(false);
    const snapshot = resolveAuthority(localOwnerAuthority());
    expect(snapshot.operatedAgentIds).toEqual(new Set());
  });
});
