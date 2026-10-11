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
    expect(names.some((name) => name.startsWith('synomem_blog_'))).toBe(false);
    await close();
  });

  it('are offered by a hosted server, each with the shared context selector', async () => {
    const { client, close } = await connect(remoteResolver(() => json({ ok: true, data: {} })));
    const tools = (await client.listTools()).tools;
    expect(tools.map((tool) => tool.name).sort()).toEqual(
      [...CONTEXT_TOOLS, ...DISCOVERY_TOOLS, ...REMOTE_CONTEXT_TOOLS].sort(),
    );
    expect(tools.map((tool) => tool.name)).toContain('synomem_blog_post_publish');
    for (const tool of tools.filter((entry) => /^synomem_(email|blog)_/.test(entry.name)))
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

  it('leads the mailbox summary with recent delivery failures', async () => {
    const mailbox = {
      id: 'mbx_1',
      agentId: 'gracie',
      status: 'active',
      primaryAddress: 'gracie@synomem.ai',
      addresses: [],
      sending: {
        policy: 'external',
        suspended: false,
        suspendedReason: null,
        organizationOutboundEnabled: true,
        deploymentOutboundEnabled: true,
        limits: {
          hourly: 20,
          daily: 100,
          maxRecipientsPerMessage: 10,
          newExternalRecipientsPerDay: 25,
        },
        usage: { lastHour: 1, lastDay: 1, newExternalRecipientsLastDay: 1 },
      },
      folders: Object.fromEntries(
        ['inbox', 'sent', 'drafts', 'spam', 'archive', 'trash'].map((folder) => [
          folder,
          { total: 0, unread: 0 },
        ]),
      ),
      recentDeliveryFailures: [
        {
          messageId: 'msg_1',
          threadId: 'thr_1',
          subject: 'A cheer',
          deliveryStatus: 'bounced',
          sentAt: '2026-10-11T15:26:35.896Z',
          recipients: [
            {
              address: 'contact@deepmind.com',
              status: 'bounced',
              dsn: '5.1.3',
              detail: 'Address not found',
              at: '2026-10-11T15:26:51.653Z',
            },
          ],
        },
      ],
    };
    const { client, close } = await connect(
      remoteResolver(() => json({ ok: true, data: mailbox })),
    );
    const result = await client.callTool({ name: 'synomem_email_mailbox', arguments: {} });
    const message = (result.structuredContent as { message: string }).message;
    expect(message).toContain('Delivery problems in the last 7 days');
    expect(message).toContain('“A cheer” (ID msg_1, bounced): contact@deepmind.com bounced 5.1.3');
    await close();
  });

  it('drafts blog articles through one audited call route, with the retry key as a header', async () => {
    const requests: { url: string; init?: RequestInit }[] = [];
    let refuse = false;
    const { client, close } = await connect(
      remoteResolver((url, init) => {
        requests.push({ url, ...(init ? { init } : {}) });
        if (refuse)
          return json(
            {
              ok: false,
              error: { code: 'POLICY_FORBIDDEN', message: 'publish permission is required.' },
            },
            403,
          );
        return json({ ok: true, data: { id: '12', title: 'Field notes', _status: 'draft' } });
      }),
    );
    const drafted = await client.callTool({
      name: 'synomem_blog_post_create',
      arguments: {
        publicationId: '2',
        title: 'Field notes',
        slug: 'field-notes',
        markdown: '# Hello',
        idempotencyKey: 'draft-field-notes-1',
      },
    });
    expect(drafted.isError).toBeFalsy();
    expect(requests[0]!.url).toBe('https://api.example.test/v1/workspaces/workspace/blog/call');
    expect((requests[0]!.init?.headers as Record<string, string>)['idempotency-key']).toBe(
      'draft-field-notes-1',
    );
    expect(JSON.parse(requests[0]!.init?.body as string)).toEqual({
      operation: 'post_create',
      input: { publicationId: '2', title: 'Field notes', slug: 'field-notes', markdown: '# Hello' },
    });
    expect((drafted.structuredContent as { message: string }).message).toBe(
      'Saved draft “Field notes” (ID 12). It is not public until published.',
    );
    // Writes without a retry key are refused before anything is sent.
    const keyless = await client.callTool({
      name: 'synomem_blog_post_publish',
      arguments: { publicationId: '2', postId: '12', expectedUpdatedAt: '2026-10-11T10:00:00Z' },
    });
    expect(keyless.isError).toBe(true);
    expect(requests).toHaveLength(1);
    refuse = true;
    const refused = await client.callTool({
      name: 'synomem_blog_post_publish',
      arguments: {
        publicationId: '2',
        postId: '12',
        expectedUpdatedAt: '2026-10-11T10:00:00Z',
        idempotencyKey: 'publish-field-notes-1',
      },
    });
    expect(refused.structuredContent).toMatchObject({ ok: false, errorCode: 'POLICY_FORBIDDEN' });
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
