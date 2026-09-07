import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import { createSynomemMcpServer } from '../src/mcp/index.js';
import { SynomemClient } from '../src/client.js';
import type { SynomemServiceFactory } from '../src/service.js';
import type { SynomemConfigOverrides } from '../src/types.js';
import { tempHome, testClient } from './helpers.js';

async function setupRuntime(home: string) {
  const setup = await testClient(home);
  await setup.agents.create({ handle: 'gracie', displayName: 'Gracie' });
  await setup.agents.create({ handle: 'codex', displayName: 'Codex' });
  await setup.close();
  return connectRuntime(home, { kind: 'agent', id: 'gracie', displayName: 'Gracie' });
}

async function connectRuntime(
  home: string,
  actor: { kind: 'agent'; id: string; displayName: string },
  config?: SynomemConfigOverrides,
) {
  const runtime = await createSynomemMcpServer({
    home,
    actor,
    ...(config ? { config } : {}),
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const protocolClient = new Client({ name: 'synomem-test', version: '1.0.0' });
  await Promise.all([
    runtime.server.connect(serverTransport),
    protocolClient.connect(clientTransport),
  ]);
  return { runtime, protocolClient };
}

describe('MCP protocol integration', () => {
  it('creates its domain service through the injected factory', async () => {
    const home = tempHome();
    const actors: string[] = [];
    const factory: SynomemServiceFactory = (options) => {
      actors.push(`${options.actor?.kind}:${options.actor?.id}`);
      return new SynomemClient(options);
    };
    const runtime = await createSynomemMcpServer(
      { home, actor: { kind: 'agent', id: 'codex', displayName: 'Codex' } },
      factory,
    );

    expect(actors).toEqual(['agent:codex']);
    await runtime.close();
  });

  it('advertises precise tools, resources, and prompts through the protocol', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const tools = await protocolClient.listTools();
    expect(tools.tools.map((tool) => tool.name)).toEqual(
      expect.arrayContaining([
        'synomem_kudos_give',
        'synomem_kudos_list',
        'synomem_kudos_changes',
        'synomem_kudos_get',
        'synomem_kudos_acknowledge',
        'synomem_kudos_revoke',
        'synomem_kudos_stats',
        'synomem_list',
        'synomem_get',
        'synomem_changes',
        'synomem_inbox',
        'synomem_memo_send',
        'synomem_memo_read',
        'synomem_memo_archive',
        'synomem_note_create',
        'synomem_note_revise',
        'synomem_note_archive',
        'synomem_task_create',
        'synomem_task_update',
        'synomem_task_accept',
        'synomem_task_reject',
        'synomem_task_complete',
        'synomem_task_reopen',
        'synomem_task_cancel',
        'synomem_agent_create',
        'synomem_agent_list',
        'synomem_rebuild',
        'synomem_doctor',
      ]),
    );
    expect(
      tools.tools.find((tool) => tool.name === 'synomem_kudos_list')?.annotations?.readOnlyHint,
    ).toBe(true);
    expect(
      tools.tools.find((tool) => tool.name === 'synomem_kudos_revoke')?.annotations
        ?.destructiveHint,
    ).toBe(true);
    const giveSchema = tools.tools.find((tool) => tool.name === 'synomem_kudos_give')
      ?.inputSchema as {
      type?: string;
      required?: string[];
      properties?: { tags?: { items?: { pattern?: string } } };
    };
    expect(giveSchema.type).toBe('object');
    expect(giveSchema.required).toEqual(
      expect.arrayContaining(['recipientAgentId', 'title', 'reason']),
    );
    expect(giveSchema.properties?.tags?.items?.pattern).toBeTruthy();
    const templates = await protocolClient.listResourceTemplates();
    expect(templates.resourceTemplates.map((resource) => resource.uriTemplate)).toContain(
      'synomem://agents/{agentId}/inbox',
    );
    const prompts = await protocolClient.listPrompts();
    expect(prompts.prompts.map((prompt) => prompt.name)).toEqual(
      expect.arrayContaining([
        'synomem_recognize_contribution',
        'synomem_review_kudos_inbox',
        'synomem_summarize_agent_wins',
        'synomem_send_durable_memo',
        'synomem_capture_agent_note',
        'synomem_create_actionable_task',
      ]),
    );
    await protocolClient.close();
    await runtime.client.close();
  });

  it('binds the actor, returns structured content, enforces policy, and exposes resources', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const result = await protocolClient.callTool({
      name: 'synomem_kudos_give',
      arguments: {
        recipientAgentId: 'codex',
        title: 'Caught a continuity contradiction',
        reason: 'Found conflicting requirements before implementation.',
        idempotencyKey: 'mcp-e17',
      },
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      ok: true,
      actor: { kind: 'agent' },
      data: { created: true, deduplicated: false },
    });
    const kudosId = (
      result.structuredContent as {
        data: { record: { event: { id: string } } };
      }
    ).data.record.event.id;

    const retry = await protocolClient.callTool({
      name: 'synomem_kudos_give',
      arguments: {
        recipientAgentId: 'codex',
        title: 'Retry',
        reason: 'A retry with the same stable key.',
        idempotencyKey: 'mcp-e17',
      },
    });
    expect(retry.structuredContent).toMatchObject({ data: { deduplicated: true } });

    const list = await protocolClient.callTool({ name: 'synomem_kudos_list', arguments: {} });
    const listData = (list.structuredContent as { data: { items: unknown[]; limit: number } }).data;
    expect(listData.limit).toBe(10);
    expect(listData.items).toHaveLength(1);
    expect(listData.items[0]).toMatchObject({
      id: kudosId,
      title: 'Caught a continuity contradiction',
    });
    expect(listData.items[0]).not.toHaveProperty('event');
    expect(listData.items[0]).not.toHaveProperty('reason');

    const changes = await protocolClient.callTool({ name: 'synomem_kudos_changes', arguments: {} });
    expect(changes.structuredContent).toMatchObject({
      data: { limit: 20, items: [{ type: 'kudos.given', kudosId }] },
    });

    const selfAward = await protocolClient.callTool({
      name: 'synomem_kudos_give',
      arguments: {
        recipientAgentId: 'gracie',
        title: 'Self praise',
        reason: 'This should be rejected.',
      },
    });
    expect(selfAward.isError).toBe(true);
    expect(selfAward.structuredContent).toMatchObject({ errorCode: 'SELF_AWARD_FORBIDDEN' });

    const acknowledgeOther = await protocolClient.callTool({
      name: 'synomem_kudos_acknowledge',
      arguments: { kudosId },
    });
    expect(acknowledgeOther.structuredContent).toMatchObject({
      errorCode: 'ACKNOWLEDGMENT_FORBIDDEN',
    });

    const administrativeRevoke = await protocolClient.callTool({
      name: 'synomem_kudos_revoke',
      arguments: { kudosId, reason: 'Agent requested admin power.', administrative: true },
    });
    expect(administrativeRevoke.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const createAgent = await protocolClient.callTool({
      name: 'synomem_agent_create',
      arguments: { handle: 'mycroft', displayName: 'Mycroft' },
    });
    expect(createAgent.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const rebuild = await protocolClient.callTool({ name: 'synomem_rebuild', arguments: {} });
    expect(rebuild.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const inbox = await protocolClient.readResource({ uri: 'synomem://agents/gracie/inbox' });
    expect(inbox.contents).toHaveLength(1);
    const wins = await protocolClient.readResource({ uri: 'synomem://agents/codex/wins' });
    const winsPage = JSON.parse((wins.contents[0] as { text: string }).text) as {
      items: Array<{ id: string }>;
      limit: number;
      hasMore: boolean;
    };
    expect(winsPage).toMatchObject({
      items: [{ id: kudosId }],
      limit: 10,
      hasMore: false,
    });
    await expect(
      protocolClient.readResource({ uri: 'synomem://agents/codex/inbox' }),
    ).rejects.toThrow();

    await protocolClient.close();
    await runtime.client.close();
  });

  it('exposes actor-bound memos, notes, tasks, and the unified feed', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const memo = await protocolClient.callTool({
      name: 'synomem_memo_send',
      arguments: {
        recipientAgentId: 'codex',
        subject: 'Durable message',
        body: 'Review the stored decision.',
      },
    });
    expect(memo.isError).not.toBe(true);
    const note = await protocolClient.callTool({
      name: 'synomem_note_create',
      arguments: {
        title: 'Private memory',
        body: 'Keep canonical events append-only.',
      },
    });
    expect(note.isError).not.toBe(true);
    const sharedNote = await protocolClient.callTool({
      name: 'synomem_note_create',
      arguments: {
        title: 'Shared memory',
        body: 'This must be rejected.',
        visibility: 'workspace',
      },
    });
    expect(sharedNote.isError).toBe(true);
    const task = await protocolClient.callTool({
      name: 'synomem_task_create',
      arguments: {
        assigneeAgentId: 'codex',
        title: 'Review the event migration',
        due: { kind: 'date', date: '2026-09-15' },
      },
    });
    expect(task.isError).not.toBe(true);
    const list = await protocolClient.callTool({ name: 'synomem_list', arguments: {} });
    const items = (list.structuredContent as { data: { items: Array<{ kind: string }> } }).data
      .items;
    expect(new Set(items.map((item) => item.kind))).toEqual(new Set(['memo', 'note', 'task']));
    expect(items.every((item) => !('body' in item) && !('description' in item))).toBe(true);
    await protocolClient.close();
    await runtime.client.close();
  });

  it('enforces private visibility through tools and resources', async () => {
    const home = tempHome();
    const setup = await testClient(home);
    await setup.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await setup.agents.create({ handle: 'codex', displayName: 'Codex' });
    await setup.agents.create({ handle: 'mycroft', displayName: 'Mycroft' });
    await setup.close();

    const giver = await testClient(home, { kind: 'agent', id: 'gracie' });
    const privateKudos = await giver.kudos.give({
      recipientAgentId: 'codex',
      title: 'Private recognition',
      reason: 'This detail is intended only for participants.',
      visibility: 'private',
    });
    await giver.close();

    const mycroft = await connectRuntime(home, {
      kind: 'agent',
      id: 'mycroft',
      displayName: 'Mycroft',
    });
    const hidden = await mycroft.protocolClient.callTool({
      name: 'synomem_kudos_get',
      arguments: { kudosId: privateKudos.record.event.id },
    });
    expect(hidden.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });
    const list = await mycroft.protocolClient.callTool({
      name: 'synomem_kudos_list',
      arguments: { limit: 50, offset: 0 },
    });
    expect(list.structuredContent).toMatchObject({ data: { total: 0, items: [] } });
    await expect(
      mycroft.protocolClient.readResource({
        uri: `synomem://events/${privateKudos.record.event.id}`,
      }),
    ).rejects.toThrow();
    await mycroft.protocolClient.close();
    await mycroft.runtime.client.close();

    const codex = await connectRuntime(home, {
      kind: 'agent',
      id: 'codex',
      displayName: 'Codex',
    });
    const visible = await codex.protocolClient.callTool({
      name: 'synomem_kudos_get',
      arguments: { kudosId: privateKudos.record.event.id },
    });
    expect(visible.isError).not.toBe(true);
    await codex.protocolClient.close();
    await codex.runtime.client.close();
  });

  it('keeps private statistics scoped to the configured actor', async () => {
    const home = tempHome();
    const setup = await testClient(home);
    await setup.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await setup.agents.create({ handle: 'codex', displayName: 'Codex' });
    await setup.agents.create({ handle: 'mycroft', displayName: 'Mycroft' });
    await setup.kudos.give({
      recipientAgentId: 'gracie',
      title: 'Visible recognition',
      reason: 'This local recognition is visible to all local actors.',
      visibility: 'workspace',
    });
    await setup.kudos.give({
      recipientAgentId: 'codex',
      title: 'Private recognition',
      reason: 'This should not influence an unrelated actor’s statistics.',
      visibility: 'private',
    });
    // Stats are keyed by canonical agent ID, not handle: the key has to stay
    // stable across a rename, and resolving handles belongs in presentation.
    const gracieId = (await setup.agents.get('gracie')).id;
    await setup.close();

    const mycroft = await connectRuntime(
      home,
      { kind: 'agent', id: 'mycroft', displayName: 'Mycroft' },
      { includePrivateInStats: true },
    );
    const result = await mycroft.protocolClient.callTool({
      name: 'synomem_kudos_stats',
      arguments: {},
    });
    expect(result.structuredContent).toMatchObject({
      data: { stats: { total: 1, byAgent: { [gracieId]: 1 } } },
    });
    await mycroft.protocolClient.close();
    await mycroft.runtime.client.close();
  });
});
