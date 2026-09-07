import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempHome, testClient } from './helpers.js';

describe('agent identity and discovery', () => {
  it('resolves aliases without regard to case', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({
      handle: 'mycroft',
      displayName: 'Mycroft',
      aliases: ['mike', 'holmes'],
    });

    for (const query of ['mycroft', 'Mycroft', 'MYCROFT', 'Mike', 'mike', 'HoLmEs']) {
      const resolution = await client.agents.resolve(query);
      expect(resolution.match?.handle, query).toBe('mycroft');
    }
    await client.close();
  });

  it('refuses an alias that another agent already answers to', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ handle: 'mycroft', displayName: 'Mycroft', aliases: ['mike'] });

    // Differing case must not sneak a second claim past the check.
    await expect(
      client.agents.create({ handle: 'mnemosyne', displayName: 'Mnemosyne', aliases: ['Mike'] }),
    ).rejects.toMatchObject({ code: 'ALIAS_CONFLICT' });

    // Nor may an alias shadow a different agent's canonical ID.
    await client.agents.create({ handle: 'atlas', displayName: 'Atlas' });
    await expect(client.agents.update('mycroft', { aliases: ['Atlas'] })).rejects.toMatchObject({
      code: 'ALIAS_CONFLICT',
    });

    await client.close();
  });

  it('reports an unknown name as no candidates rather than an error', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ handle: 'mycroft', displayName: 'Mycroft' });
    const resolution = await client.agents.resolve('nobody');
    expect(resolution.match).toBeUndefined();
    expect(resolution.candidates).toEqual([]);
    await client.close();
  });

  it('keeps an agent reachable under a renamed alias set', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ handle: 'mycroft', displayName: 'Mycroft', aliases: ['mike'] });
    await client.agents.update('mycroft', { aliases: ['mike', 'brother'] });
    expect((await client.agents.resolve('Brother')).match?.handle).toBe('mycroft');

    await client.agents.update('mycroft', { aliases: [] });
    expect((await client.agents.resolve('mike')).match).toBeUndefined();
    expect((await client.agents.resolve('mycroft')).match?.handle).toBe('mycroft');
    await client.close();
  });

  it('records runtime bindings idempotently and lists them in the directory', async () => {
    const client = await testClient(tempHome());
    const mycroft = await client.agents.create({
      handle: 'mycroft',
      displayName: 'Mycroft',
      aliases: ['mike'],
    });

    const first = await client.agents.bindRuntime({
      agentId: 'Mike',
      runtime: 'claude-code',
      capabilities: { tools: ['synomem'] },
    });
    // An alias resolves to the canonical ID, which is what the binding stores.
    expect(first.agentId).toBe(mycroft.id);
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
    expect(directory[0]?.profile.handle).toBe('mycroft');
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

describe('agent-bound MCP registration', () => {
  it('reads the display name from the profile rather than the command line', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.agents.create({ handle: 'mycroft', displayName: 'Mycroft', aliases: ['mike'] });
    await client.close();

    const server = spawn(
      process.execPath,
      [join(process.cwd(), 'dist', 'mcp-server.js'), '--home', home, '--agent-id', 'mike'],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    const stdout = await new Promise<string>((resolveOutput, rejectOutput) => {
      let buffer = '';
      server.stdout.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();
        if (buffer.includes('\n')) resolveOutput(buffer);
      });
      server.on('error', rejectOutput);
      server.stdin.write(
        `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: '2025-06-18',
            capabilities: {},
            clientInfo: { name: 'identity-test', version: '1.0.0' },
          },
        })}\n`,
      );
    });
    /*
     * Waited for, not just signalled. `kill` returns before the child has gone,
     * and the child still holds the SQLite file -- so reopening the database
     * below races it. Windows enforces that lock and fails the read with a disk
     * I/O error; POSIX quietly tolerates it, which is what let this survive.
     */
    await new Promise<void>((resolveExit) => {
      if (server.exitCode !== null || server.signalCode !== null) return resolveExit();
      server.once('exit', () => resolveExit());
      server.kill();
    });
    expect(stdout).toContain('"result"');

    // The alias resolved to the canonical agent, and nothing on the command
    // line asserted a name.
    const verifier = await testClient(home, { kind: 'agent', id: 'mycroft' });
    expect((await verifier.agents.get('mike')).displayName).toBe('Mycroft');
    await verifier.close();
  });

  it('refuses to start against an agent that does not exist', async () => {
    const home = tempHome();
    const client = await testClient(home);
    await client.close();

    const exit = await new Promise<{ code: number | null; stderr: string }>((resolveExit) => {
      const server = spawn(
        process.execPath,
        [join(process.cwd(), 'dist', 'mcp-server.js'), '--home', home, '--agent-id', 'ghost'],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      );
      let stderr = '';
      server.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      server.on('close', (code) => resolveExit({ code, stderr }));
    });
    expect(exit.code).not.toBe(0);
    expect(exit.stderr).toContain('Unknown agent');
  });
});

describe('opaque canonical identity', () => {
  it('generates an opaque id and keeps it through a rename', async () => {
    const client = await testClient(tempHome());
    const created = await client.agents.create({ handle: 'gracie', displayName: 'Gracie' });

    // The ID is generated, not the handle. That is the whole point: a handle
    // carries meaning and meaning changes.
    expect(created.id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(created.id).not.toBe('gracie');
    expect(created.handle).toBe('gracie');

    const renamed = await client.agents.update('gracie', { handle: 'grace' });
    expect(renamed.handle).toBe('grace');
    expect(renamed.id).toBe(created.id);

    // Reachable under the new handle and no longer under the old one, while the
    // canonical ID keeps working either way.
    expect((await client.agents.resolve('grace')).match?.id).toBe(created.id);
    expect((await client.agents.resolve('gracie')).match).toBeUndefined();
    expect((await client.agents.get(created.id)).handle).toBe('grace');
    await client.close();
  });

  it('keeps records attached to an agent across a rename', async () => {
    // This is what the opaque ID buys. Under handle-as-ID a rename would
    // orphan every event written under the old name.
    const home = tempHome();
    const operator = await testClient(home);
    const gracie = await operator.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await operator.kudos.give({
      recipientAgentId: 'gracie',
      title: 'Caught a real bug',
      reason: 'Found the collision before it reached anybody.',
    });

    await operator.agents.update('gracie', { handle: 'grace' });
    const page = await operator.kudos.list({ recipientAgentId: 'grace' });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.recipientAgentId).toBe(gracie.id);
    await operator.close();
  });

  it('refuses a handle another agent already answers to', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await client.agents.create({ handle: 'atlas', displayName: 'Atlas' });
    await expect(client.agents.update('atlas', { handle: 'gracie' })).rejects.toMatchObject({
      code: 'ALIAS_CONFLICT',
    });
    await client.close();
  });

  it('archives without erasing, and restores', async () => {
    const client = await testClient(tempHome());
    const gracie = await client.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await client.kudos.give({
      recipientAgentId: 'gracie',
      title: 'Before archiving',
      reason: 'History must survive the agent being stood down.',
    });

    const archived = await client.agents.archive('gracie');
    expect(archived.status).toBe('archived');
    // Still resolvable and its records still there: events reference the actor
    // permanently, so deletion would leave history pointing at nothing.
    expect((await client.agents.get(gracie.id)).status).toBe('archived');
    expect((await client.kudos.list({ recipientAgentId: 'gracie' })).items).toHaveLength(1);

    expect((await client.agents.restore('gracie')).status).toBe('active');
    await client.close();
  });

  it('adds and removes aliases without replacing the set', async () => {
    const client = await testClient(tempHome());
    await client.agents.create({ handle: 'mycroft', displayName: 'Mycroft', aliases: ['mike'] });

    expect((await client.agents.addAliases('mycroft', ['holmes', 'm'])).aliases).toEqual([
      'holmes',
      'm',
      'mike',
    ]);
    expect((await client.agents.removeAliases('mycroft', ['Mike'])).aliases).toEqual([
      'holmes',
      'm',
    ]);
    expect((await client.agents.resolve('HOLMES')).match?.handle).toBe('mycroft');
    await client.close();
  });
});
