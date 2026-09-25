import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TOOLS,
  DISCOVERY_TOOLS,
  createSynomemMcpServer,
  type ContextResolver,
} from '../src/mcp/index.js';
import { createLocalResolver } from '../src/resolvers.js';
import { SynomemError } from '../src/errors.js';
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
  return connectResolver(createLocalResolver({ home, actor, ...(config ? { config } : {}) }));
}

async function connectResolver(resolver: ContextResolver) {
  const runtime = await createSynomemMcpServer({}, resolver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const protocolClient = new Client({ name: 'synomem-test', version: '1.0.0' });
  await Promise.all([
    runtime.server.connect(serverTransport),
    protocolClient.connect(clientTransport),
  ]);
  return { runtime, protocolClient };
}

describe('MCP protocol integration', () => {
  it('binds a local session to one stable lctx_ context and reports it on every result', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const listed = await protocolClient.callTool({ name: 'synomem_context_list', arguments: {} });
    const listing = (
      listed.structuredContent as {
        data: { mode: string; fixedContextId: string; contexts: Array<{ contextId: string }> };
      }
    ).data;
    expect(listing.mode).toBe('fixed');
    expect(listing.fixedContextId).toMatch(/^lctx_[0-9a-f]{32}$/);
    expect(listing.contexts).toHaveLength(1);

    const result = await protocolClient.callTool({ name: 'synomem_list', arguments: {} });
    expect(result.structuredContent).toMatchObject({
      ok: true,
      effectiveContext: { contextId: listing.fixedContextId, actor: { kind: 'agent' } },
    });

    // Naming the fixed context explicitly is fine; naming any other is refused.
    const explicit = await protocolClient.callTool({
      name: 'synomem_list',
      arguments: { contextId: listing.fixedContextId },
    });
    expect(explicit.isError).toBeFalsy();
    const other = await protocolClient.callTool({
      name: 'synomem_list',
      arguments: { contextId: 'lctx_000000000000000000000000' },
    });
    expect(other.structuredContent).toMatchObject({ errorCode: 'CONTEXT_FORBIDDEN' });

    const whoami = await protocolClient.callTool({ name: 'synomem_whoami', arguments: {} });
    expect(whoami.structuredContent).toMatchObject({
      data: { mode: 'fixed' },
      effectiveContext: { contextId: listing.fixedContextId },
    });
    await protocolClient.close();
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
        'synomem_agent_archive',
        'synomem_agent_restore',
        'synomem_agent_list',
        'synomem_topic_create',
        'synomem_topic_update',
        'synomem_topic_list',
        'synomem_topic_resolve',
        'synomem_topic_archive',
        'synomem_topic_restore',
        'synomem_context_list',
        'synomem_context_resolve',
        'synomem_whoami',
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
      properties?: { tags?: { items?: { pattern?: string; description?: string } } };
    };
    expect(giveSchema.type).toBe('object');
    expect(giveSchema.required).toEqual(
      expect.arrayContaining(['recipientAgentId', 'title', 'reason']),
    );
    // The tag rule is enforced by refine, never advertised (see the portable-pattern test).
    expect(giveSchema.properties?.tags?.items?.pattern).toBeUndefined();
    expect(giveSchema.properties?.tags?.items?.description).toBeTruthy();
    const templates = await protocolClient.listResourceTemplates();
    expect(templates.resourceTemplates.map((resource) => resource.uriTemplate)).toContain(
      'synomem://contexts/{contextId}/agents/{agentId}/inbox',
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
    await runtime.close();
  });

  it('advertises every tool schema without a self-referencing $ref/definitions pair', async () => {
    // `metadataSchema` is genuinely recursive (arbitrary JSON, any depth),
    // which every JSON Schema conversion has to express as a self-referencing
    // $ref/definitions pair — and at least one real MCP client (ChatGPT)
    // rejects a tool outright the moment its advertised schema contains one,
    // with no indication of which field caused it. A tool that calls into a
    // domain method which independently re-validates the full input (every
    // one of these does) loses nothing real by advertising a flattened
    // `metadata`/`capabilities` field instead — this locks that in for every
    // current and future tool, rather than relying on each one remembering to
    // ask this question separately.
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const tools = await protocolClient.listTools();
    const offenders = tools.tools
      .filter((tool) => JSON.stringify(tool.inputSchema).includes('$ref'))
      .map((tool) => tool.name);
    expect(offenders).toEqual([]);
    await protocolClient.close();
    await runtime.close();
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

    const archiveAgent = await protocolClient.callTool({
      name: 'synomem_agent_archive',
      arguments: { idOrAlias: 'gracie' },
    });
    expect(archiveAgent.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const restoreAgent = await protocolClient.callTool({
      name: 'synomem_agent_restore',
      arguments: { idOrAlias: 'gracie' },
    });
    expect(restoreAgent.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const rebuild = await protocolClient.callTool({ name: 'synomem_rebuild', arguments: {} });
    expect(rebuild.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });

    const inbox = await protocolClient.readResource({
      uri: 'synomem://contexts/default/agents/gracie/inbox',
    });
    expect(inbox.contents).toHaveLength(1);
    const wins = await protocolClient.readResource({
      uri: 'synomem://contexts/default/agents/codex/wins',
    });
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
      protocolClient.readResource({ uri: 'synomem://contexts/default/agents/codex/inbox' }),
    ).rejects.toThrow();

    await protocolClient.close();
    await runtime.close();
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
    await runtime.close();
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
        uri: `synomem://contexts/default/events/${privateKudos.record.event.id}`,
      }),
    ).rejects.toThrow();
    await mycroft.protocolClient.close();
    await mycroft.runtime.close();

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
    await codex.runtime.close();
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
    await mycroft.runtime.close();
  });

  it('creates a topic, resolves it by alias, and files a todo under it through the protocol', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);

    const created = await protocolClient.callTool({
      name: 'synomem_topic_create',
      arguments: { displayName: 'Synomem', aliases: ['syno'] },
    });
    expect(created.isError).not.toBe(true);
    const topicId = (created.structuredContent as { data: { topic: { id: string } } }).data.topic
      .id;

    const resolved = await protocolClient.callTool({
      name: 'synomem_topic_resolve',
      arguments: { query: 'SYNO' },
    });
    expect(resolved.structuredContent).toMatchObject({ data: { match: { id: topicId } } });

    const todo = await protocolClient.callTool({
      name: 'synomem_todo_create',
      arguments: { title: 'File under Synomem', topicIds: [topicId] },
    });
    expect(todo.isError).not.toBe(true);

    const filtered = await protocolClient.callTool({
      name: 'synomem_list',
      arguments: { kinds: ['todo'], topicId },
    });
    expect(
      (filtered.structuredContent as { data: { items: Array<{ title: string }> } }).data.items,
    ).toHaveLength(1);

    await protocolClient.close();
    await runtime.close();
  });
  it('advertises only regex patterns every host can compile', async () => {
    // ChatGPT refused the whole tool list over one `\p{L}` tag pattern: a JSON Schema
    // `pattern` has no flags, so a Unicode property escape only means something to a JavaScript
    // engine running with `u`. Keep advertised patterns to the portable subset.
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const tools = (await protocolClient.listTools()).tools;
    const patterns: Array<{ tool: string; pattern: string }> = [];
    const walk = (tool: string, node: unknown): void => {
      if (Array.isArray(node)) return node.forEach((child) => walk(tool, child));
      if (typeof node !== 'object' || node === null) return;
      for (const [key, value] of Object.entries(node)) {
        if (key === 'pattern' && typeof value === 'string') patterns.push({ tool, pattern: value });
        else walk(tool, value);
      }
    };
    for (const tool of tools) walk(tool.name, [tool.inputSchema, tool.outputSchema]);
    expect(patterns.length).toBeGreaterThan(0);
    for (const { tool, pattern } of patterns) {
      expect(pattern, tool).not.toMatch(/\\[pPu]\{|\(\?<[=!]?|\(\?[a-z]/);
      expect(() => new RegExp(pattern), tool).not.toThrow();
    }

    // The tag rule itself still holds; it is checked, just not advertised.
    const refused = await protocolClient.callTool({
      name: 'synomem_kudos_give',
      arguments: { recipientAgentId: 'codex', title: 'Caught it', reason: 'Why', tags: ['-bad'] },
    });
    expect(refused.isError).toBe(true);
    const accepted = await protocolClient.callTool({
      name: 'synomem_kudos_give',
      arguments: {
        recipientAgentId: 'codex',
        title: 'Caught it',
        reason: 'Why',
        tags: ['café.review'],
      },
    });
    expect(accepted.isError, JSON.stringify(accepted.content)).toBeFalsy();
    await protocolClient.close();
    await runtime.close();
  });

  it('registers every tool in exactly one of the context or discovery inventories', async () => {
    const home = tempHome();
    const { runtime, protocolClient } = await setupRuntime(home);
    const tools = (await protocolClient.listTools()).tools;
    const contextTools = new Set<string>(CONTEXT_TOOLS);
    const discoveryTools = new Set<string>(DISCOVERY_TOOLS);
    for (const tool of tools) {
      const inContext = contextTools.has(tool.name);
      const inDiscovery = discoveryTools.has(tool.name);
      expect(inContext !== inDiscovery, tool.name).toBe(true);
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      // A context tool that forgot the shared selector would silently run as the default.
      if (inContext) expect(properties, tool.name).toHaveProperty('contextId');
    }
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...CONTEXT_TOOLS, ...DISCOVERY_TOOLS].sort(),
    );
    const templates = (await protocolClient.listResourceTemplates()).resourceTemplates;
    expect(templates.every((template) => template.uriTemplate.includes('{contextId}'))).toBe(true);
    await protocolClient.close();
    await runtime.close();
  });

  it('requires contextId in explicit mode and keeps interleaved calls on their own contexts', async () => {
    // Two independent stores stand in for two hosted contexts: Gracie in one, Codex in the
    // other. The resolver never has a "current" context — each call names its own.
    const gracieHome = tempHome();
    const codexHome = tempHome();
    for (const [home, handle, name] of [
      [gracieHome, 'gracie', 'Gracie'],
      [codexHome, 'codex', 'Codex'],
    ] as const) {
      const admin = await testClient(home);
      await admin.agents.create({ handle, displayName: name });
      await admin.close();
    }
    const gracie = createLocalResolver({
      home: gracieHome,
      actor: { kind: 'agent', id: 'gracie', displayName: 'Gracie' },
    });
    const codex = createLocalResolver({
      home: codexHome,
      actor: { kind: 'agent', id: 'codex', displayName: 'Codex' },
    });
    const gracieId = (await gracie.list()).fixedContextId!;
    const codexId = (await codex.list()).fixedContextId!;
    const byId = new Map([
      [gracieId, gracie],
      [codexId, codex],
    ]);
    const explicit: ContextResolver = {
      mode: () => 'explicit',
      async resolve(contextId) {
        const target = contextId ? byId.get(contextId) : undefined;
        if (!contextId) throw new SynomemError('CONTEXT_REQUIRED', 'Pass contextId.');
        if (!target) throw new SynomemError('CONTEXT_FORBIDDEN', 'Not available.');
        return target.resolve(contextId);
      },
      async list() {
        const entries = [...(await gracie.list()).contexts, ...(await codex.list()).contexts];
        return { mode: 'explicit', fixedContextId: null, contexts: entries, nextCursor: null };
      },
      async close() {
        await gracie.close?.();
        await codex.close?.();
      },
    };
    const { runtime, protocolClient } = await connectResolver(explicit);

    const missing = await protocolClient.callTool({
      name: 'synomem_note_create',
      arguments: { title: 'No context', body: 'Must not be written anywhere.' },
    });
    expect(missing.isError).toBe(true);
    expect(missing.structuredContent).toMatchObject({ ok: false, errorCode: 'CONTEXT_REQUIRED' });

    const writes = await Promise.all(
      Array.from({ length: 6 }, (_, index) => {
        const contextId = index % 2 === 0 ? gracieId : codexId;
        return protocolClient.callTool({
          name: 'synomem_note_create',
          arguments: { contextId, title: `Note ${index}`, body: `Written as ${contextId}.` },
        });
      }),
    );
    const gracieActor = (await gracie.resolve()).context.actor.id;
    const codexActor = (await codex.resolve()).context.actor.id;
    expect(gracieActor).not.toBe(codexActor);
    writes.forEach((result, index) => {
      const expected = index % 2 === 0 ? gracieActor : codexActor;
      const content = result.structuredContent as {
        effectiveContext: { actor: { id: string } };
        data: { record: { event: { actor: { id: string } } } };
      };
      expect(result.isError, JSON.stringify(result.structuredContent)).toBeFalsy();
      expect(content.effectiveContext.actor.id).toBe(content.data.record.event.actor.id);
      expect(content.data.record.event.actor.id).toBe(expected);
    });
    const gracieList = await protocolClient.callTool({
      name: 'synomem_list',
      arguments: { contextId: gracieId, kinds: ['note'] },
    });
    const codexList = await protocolClient.callTool({
      name: 'synomem_list',
      arguments: { contextId: codexId, kinds: ['note'] },
    });
    const titles = (result: typeof gracieList) =>
      (result.structuredContent as { data: { items: Array<{ title: string }> } }).data.items
        .map((item) => item.title)
        .sort();
    expect(titles(gracieList)).toEqual(['Note 0', 'Note 2', 'Note 4']);
    expect(titles(codexList)).toEqual(['Note 1', 'Note 3', 'Note 5']);

    const resolved = await protocolClient.callTool({
      name: 'synomem_context_resolve',
      arguments: { query: 'gracie' },
    });
    expect(resolved.structuredContent).toMatchObject({ data: { match: { contextId: gracieId } } });
    const ambiguous = await protocolClient.callTool({
      name: 'synomem_context_resolve',
      arguments: { actorKind: 'agent' },
    });
    expect(ambiguous.structuredContent).toMatchObject({ errorCode: 'CONTEXT_AMBIGUOUS' });
    const unknown = await protocolClient.callTool({
      name: 'synomem_context_resolve',
      arguments: { query: 'astra' },
    });
    expect(unknown.structuredContent).toMatchObject({ errorCode: 'CONTEXT_FORBIDDEN' });

    await protocolClient.close();
    await runtime.close();
  });
});
