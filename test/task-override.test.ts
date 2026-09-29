import { describe, expect, it } from 'vitest';
import { SynomemClient } from '../src/client.js';
import { resolveAuthority } from '../src/policy.js';
import { tempHome, testClient } from './helpers.js';
describe('human intervention and task decisions', () => {
  it('records the human reason and basis, refuses assigned, stale and unauthorized overrides', async () => {
    const home = tempHome();
    const owner = await testClient(home);
    await owner.actors.registerHuman({
      id: 'operator',
      handle: 'operator',
      displayName: 'Operator',
    });
    const gracie = await owner.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    const task = await owner.tasks.create({
      assignee: { kind: 'agent', id: gracie.id },
      title: 'Review',
    });
    const operator = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'operator' },
      authority: { ...resolveAuthority(), operatedAgentIds: new Set([gracie.id]) },
    });
    await operator.init();
    await expect(
      operator.tasks.overrideDecision({
        taskId: task.record.event.id,
        expectedVersion: 1,
        nextStatus: 'rejected',
        reason: 'Not started',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    const accepted = await operator.tasks.accept({
      expectedVersion: (await operator.tasks.get(task.record.event.id)).lifecycleVersion!,
      taskId: task.record.event.id,
    });
    expect(accepted.status).toBe('open');
    const overridden = await operator.tasks.overrideDecision({
      taskId: task.record.event.id,
      expectedVersion: 2,
      nextStatus: 'rejected',
      reason: 'Use a different approach',
    });
    expect(overridden.overrides?.[0]).toMatchObject({
      actor: { kind: 'human', id: 'operator' },
      previousStatus: 'open',
      nextStatus: 'rejected',
      reason: 'Use a different approach',
      intervention: { basis: 'operator' },
    });
    await expect(
      operator.tasks.overrideDecision({
        taskId: task.record.event.id,
        expectedVersion: 2,
        nextStatus: 'open',
        reason: 'Stale',
      }),
    ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
    const agent = await testClient(home, { kind: 'agent', id: gracie.id });
    await expect(
      agent.tasks.overrideDecision({
        taskId: task.record.event.id,
        expectedVersion: 3,
        nextStatus: 'open',
        reason: 'No human oversight',
      }),
    ).rejects.toMatchObject({ code: 'MUTATION_FORBIDDEN' });
    const memory = await agent.notes.create({ title: 'Knowledge', body: 'Original' });
    const changed = await operator.notes.revise({
      noteId: memory.record.event.id,
      expectedVersion: 1,
      body: 'Reviewed',
    });
    expect(changed.revision?.intervention).toEqual({ basis: 'operator' });
    await agent.close();
    await operator.close();
    await owner.close();
  });
});
