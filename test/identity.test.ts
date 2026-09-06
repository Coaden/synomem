import { describe, expect, it } from 'vitest';
import { tempHome, testClient } from './helpers.js';

describe('agent identity and discovery', () => {
  it('resolves aliases without regard to case', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({
      id: 'mycroft',
      displayName: 'Mycroft',
      aliases: ['mike', 'holmes'],
    });

    for (const query of ['mycroft', 'Mycroft', 'MYCROFT', 'Mike', 'mike', 'HoLmEs']) {
      const resolution = await client.agents.resolve(query);
      expect(resolution.match?.id, query).toBe('mycroft');
    }
    await client.close();
  });

  it('refuses an alias that another agent already answers to', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ id: 'mycroft', displayName: 'Mycroft', aliases: ['mike'] });

    // Differing case must not sneak a second claim past the check.
    await expect(
      client.agents.create({ id: 'mnemosyne', displayName: 'Mnemosyne', aliases: ['Mike'] }),
    ).rejects.toMatchObject({ code: 'ALIAS_CONFLICT' });

    // Nor may an alias shadow a different agent's canonical ID.
    await client.agents.create({ id: 'atlas', displayName: 'Atlas' });
    await expect(
      client.agents.update('mycroft', { aliases: ['Atlas'] }),
    ).rejects.toMatchObject({ code: 'ALIAS_CONFLICT' });

    await client.close();
  });

  it('reports an unknown name as no candidates rather than an error', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ id: 'mycroft', displayName: 'Mycroft' });
    const resolution = await client.agents.resolve('nobody');
    expect(resolution.match).toBeUndefined();
    expect(resolution.candidates).toEqual([]);
    await client.close();
  });

  it('keeps an agent reachable under a renamed alias set', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ id: 'mycroft', displayName: 'Mycroft', aliases: ['mike'] });
    await client.agents.update('mycroft', { aliases: ['mike', 'brother'] });
    expect((await client.agents.resolve('Brother')).match?.id).toBe('mycroft');

    await client.agents.update('mycroft', { aliases: [] });
    expect((await client.agents.resolve('mike')).match).toBeUndefined();
    expect((await client.agents.resolve('mycroft')).match?.id).toBe('mycroft');
    await client.close();
  });

  it('records runtime bindings idempotently and lists them in the directory', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ id: 'mycroft', displayName: 'Mycroft', aliases: ['mike'] });

    const first = await client.agents.bindRuntime({
      agentId: 'Mike',
      runtime: 'claude-code',
      capabilities: { tools: ['synomem'] },
    });
    expect(first.agentId).toBe('mycroft');
    expect(first.lastSeenAt).toBeUndefined();

    // Reinstalling the same runtime is the same agent in the same place.
    const again = await client.agents.bindRuntime({ agentId: 'mycroft', runtime: 'claude-code' });
    expect(again.id).toBe(first.id);
    expect(await client.agents.bindings('mycroft')).toHaveLength(1);

    // A distinct profile within one runtime is a separate place to reach it.
    await client.agents.bindRuntime({
      agentId: 'mycroft',
      runtime: 'claude-code',
      profile: 'clinic',
    });
    expect(await client.agents.bindings('mycroft')).toHaveLength(2);

    const directory = await client.agents.directory();
    expect(directory).toHaveLength(1);
    expect(directory[0]?.profile.id).toBe('mycroft');
    expect(directory[0]?.runtimeBindings.map((binding) => binding.runtime)).toEqual([
      'claude-code',
      'claude-code',
    ]);

    expect(await client.agents.unbindRuntime(first.id)).toBe(true);
    expect(await client.agents.unbindRuntime(first.id)).toBe(false);
    expect(await client.agents.bindings('mycroft')).toHaveLength(1);
    await client.close();
  });

  it('refuses to bind a runtime to an unknown agent', async () => {
    const client = await testClient(tempHome());
    await expect(
      client.agents.bindRuntime({ agentId: 'ghost', runtime: 'claude-code' }),
    ).rejects.toMatchObject({ code: 'AGENT_NOT_FOUND' });
    await client.close();
  });
});
