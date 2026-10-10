import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';
import {
  CONTEXT_TOOLS,
  DISCOVERY_TOOLS,
  REMOTE_CONTEXT_TOOLS,
  createSynomemMcpServer,
  type ContextResolver,
} from '../src/mcp/index.js';
import { RemoteSynomemService } from '../src/remote.js';
import { createLocalResolver } from '../src/resolvers.js';
import { tempHome, testClient } from './helpers.js';

const actor = { kind: 'agent' as const, id: 'gracie', displayName: 'Gracie' };
const context = {
  contextId: 'ctx_remote',
  organizationId: 'org',
  workspaceId: 'workspace',
  actor,
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function remoteResolver(
  handle: (url: string, init?: RequestInit) => Response,
  backend: 'remote' | 'mixed' = 'remote',
): ContextResolver {
  const service = new RemoteSynomemService({
    baseUrl: 'https://api.example.test',
    workspaceId: 'workspace',
    contextId: context.contextId,
    credential: async () => 'test-token-not-a-secret',
    fetch: async (input, init) => {
      const url = input instanceof Request ? input.url : input.toString();
      if (url.endsWith('/v1/capabilities'))
        return json({
          ok: true,
          data: {
            backend: 'remote',
            participation: { version: 2, canWrite: true },
            binding: { workspaceId: 'workspace', actor },
          },
        });
      return handle(url, init);
    },
  });
  return {
    backend: () => backend,
    mode: () => 'fixed',
    resolve: async () => ({ service, context }),
    list: async () => ({
      mode: 'fixed',
      fixedContextId: context.contextId,
      contexts: [{ ...context, label: 'Gracie', kind: 'agent' } as never],
    }),
  };
}

async function connect(resolver: ContextResolver) {
  const runtime = await createSynomemMcpServer({}, resolver);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'synomem-test', version: '1.0.0' });
  await Promise.all([runtime.server.connect(serverTransport), client.connect(clientTransport)]);
  return {
    client,
    close: async () => {
      await client.close();
      await runtime.close();
    },
  };
}

describe('hosted email MCP tools', () => {
  it('are never offered by a local (SQLite) server', async () => {
    const home = tempHome();
    const setup = await testClient(home);
    await setup.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await setup.close();
    const { client, close } = await connect(createLocalResolver({ home, actor }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names.some((name) => name.startsWith('synomem_email_'))).toBe(false);
    await close();
  });

  it('are offered by a hosted server, each with the shared context selector', async () => {
    const { client, close } = await connect(remoteResolver(() => json({ ok: true, data: {} })));
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...CONTEXT_TOOLS, ...DISCOVERY_TOOLS, ...REMOTE_CONTEXT_TOOLS].sort(),
    );
    for (const tool of tools.filter((entry) => entry.name.startsWith('synomem_email_')))
      expect((tool.inputSchema as { properties?: object }).properties, tool.name).toHaveProperty(
        'contextId',
      );
    await close();
  });

  it('sends through the agent’s own mailbox route and reports refusals precisely', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    let refuse = false;
    const { client, close } = await connect(
      remoteResolver((url, init) => {
        requests.push({ url, ...(init ? { init } : {}) });
        if (refuse)
          return json(
            {
              ok: false,
              error: {
                code: 'EMAIL_SEND_FORBIDDEN',
                message: 'This mailbox may only send to @synomem.ai addresses.',
              },
            },
            403,
          );
        return json({
          ok: true,
          data: {
            id: 'msg_1',
            subject: 'Hello',
            to: [{ address: 'ada@example.org' }],
            cc: [],
            bcc: [],
            deliveryStatus: 'queued',
          },
        });
      }),
    );
    const sent = await client.callTool({
      name: 'synomem_email_send',
      arguments: {
        to: 'Ada <ada@example.org>',
        subject: 'Hello',
        text: 'Hi',
        idempotencyKey: 'k1',
      },
    });
    expect(sent.isError).toBeFalsy();
    expect(requests[0]!.url).toBe('https://api.example.test/v1/workspaces/workspace/email/send');
    expect(requests[0]!.init?.method).toBe('POST');
    expect((requests[0]!.init?.headers as Record<string, string>)['idempotency-key']).toBe('k1');
    expect(JSON.parse(requests[0]!.init?.body as string)).toEqual({
      to: 'Ada <ada@example.org>',
      subject: 'Hello',
      text: 'Hi',
    });
    expect((sent.structuredContent as { message: string }).message).toContain(
      'Sent “Hello” to ada@example.org',
    );

    refuse = true;
    const refused = await client.callTool({
      name: 'synomem_email_send',
      arguments: { to: 'ada@example.org', subject: 'Again', text: 'Hi' },
    });
    expect(refused.isError).toBe(true);
    expect(refused.structuredContent).toMatchObject({
      ok: false,
      errorCode: 'EMAIL_SEND_FORBIDDEN',
    });
    await close();
  });

  it('refuses email on a local context reached through a mixed preset', async () => {
    const home = tempHome();
    const setup = await testClient(home);
    await setup.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await setup.close();
    const local = createLocalResolver({ home, actor });
    const { client, close } = await connect({
      ...local,
      backend: () => 'mixed',
    });
    const result = await client.callTool({ name: 'synomem_email_mailbox', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ errorCode: 'POLICY_FORBIDDEN' });
    await close();
  });
});
