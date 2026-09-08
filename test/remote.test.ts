import { describe, expect, it, vi } from 'vitest';
import { SynomemError } from '../src/errors.js';
import { RemoteSynomemService, type SynomemCredentialProvider } from '../src/remote.js';

const actor = { kind: 'agent' as const, id: 'codex', displayName: 'Codex' };
const credentials: SynomemCredentialProvider = {
  async getAccessToken() {
    return 'test-token-not-a-secret';
  },
};

function json(data: unknown, status = 200, headers: Record<string, string> = {}): Response {
  const responseHeaders = new Headers(headers);
  responseHeaders.set('content-type', 'application/json');
  return new Response(JSON.stringify(data), {
    status,
    headers: responseHeaders,
  });
}

describe('remote Synomem service', () => {
  it('requires HTTPS except for loopback development', () => {
    expect(
      () =>
        new RemoteSynomemService({
          baseUrl: 'http://api.example.test',
          workspaceId: 'workspace',
          expectedActor: actor,
          credentialProvider: credentials,
        }),
    ).toThrowError(/requires HTTPS/i);
    expect(
      () =>
        new RemoteSynomemService({
          baseUrl: 'http://127.0.0.1:8787',
          workspaceId: 'workspace',
          expectedActor: actor,
          credentialProvider: credentials,
        }),
    ).not.toThrow();
  });

  it('binds authorization outside bodies and moves idempotency into its header', async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImplementation = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      requests.push({ url, init });
      if (url.endsWith('/v1/capabilities')) {
        return json({
          ok: true,
          data: {
            backend: 'remote',
            binding: { workspaceId: 'workspace-a', actor },
            administration: { agentCreationViaMcp: false, agentArchiveViaMcp: false, rebuildViaMcp: false },
            projections: {
              writeWinsMarkdown: false,
              writeMemoryMarkdown: false,
              writeTasksMarkdown: false,
              writeInboxEntries: false,
            },
          },
        });
      }
      return json({
        ok: true,
        data: {
          created: true,
          deduplicated: false,
          record: { event: { id: '01REMOTE', actor: { kind: 'agent', id: 'server-bound' } } },
        },
      });
    });
    const service = new RemoteSynomemService({
      baseUrl: 'https://api.example.test',
      workspaceId: 'workspace-a',
      expectedActor: actor,
      credentialProvider: credentials,
      fetch: fetchImplementation,
    });

    await service.init();
    await service.kudos.give({
      recipientAgentId: 'gracie',
      title: 'Remote boundary',
      reason: 'The server remains authoritative.',
      idempotencyKey: 'retry-1',
    });

    expect(requests.map(({ url }) => url)).toEqual([
      'https://api.example.test/v1/capabilities',
      'https://api.example.test/v1/workspaces/workspace-a/kudos',
    ]);
    const mutation = requests[1]!.init!;
    expect(new Headers(mutation.headers).get('authorization')).toBe(
      'Bearer test-token-not-a-secret',
    );
    expect(new Headers(mutation.headers).get('idempotency-key')).toBe('retry-1');
    if (typeof mutation.body !== 'string') throw new Error('Expected a JSON request body.');
    const body = JSON.parse(mutation.body) as Record<string, unknown>;
    expect(body).not.toHaveProperty('idempotencyKey');
    expect(body).not.toHaveProperty('actor');
    expect(body).not.toHaveProperty('actorId');
    expect(body).not.toHaveProperty('actorKind');
  });

  it('fails before a network request when no credential is available', async () => {
    const fetchImplementation = vi.fn();
    const service = new RemoteSynomemService({
      baseUrl: 'https://api.example.test',
      workspaceId: 'workspace',
      expectedActor: actor,
      credentialProvider: {
        async getAccessToken() {
          return undefined;
        },
      },
      fetch: fetchImplementation,
    });

    await expect(service.init()).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it('fails closed when the server binds a different workspace or actor', async () => {
    let binding = { workspaceId: 'other-workspace', actor };
    const service = new RemoteSynomemService({
      baseUrl: 'https://api.example.test',
      workspaceId: 'workspace',
      expectedActor: actor,
      credentialProvider: credentials,
      fetch: async () =>
        json({
          ok: true,
          data: {
            backend: 'remote',
            binding,
            administration: { agentCreationViaMcp: false, agentArchiveViaMcp: false, rebuildViaMcp: false },
            projections: {
              writeWinsMarkdown: false,
              writeMemoryMarkdown: false,
              writeTasksMarkdown: false,
              writeInboxEntries: false,
            },
          },
        }),
    });
    await expect(service.init()).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });

    binding = { workspaceId: 'workspace', actor: { ...actor, id: 'mycroft' } };
    await expect(service.init()).rejects.toMatchObject({ code: 'AUTH_FORBIDDEN' });
  });

  it('does not follow redirects and bounds response bytes', async () => {
    let response = new Response('', { status: 307, headers: { location: 'https://evil.test/' } });
    const service = new RemoteSynomemService({
      baseUrl: 'https://api.example.test',
      workspaceId: 'workspace',
      expectedActor: actor,
      credentialProvider: credentials,
      maximumResponseBytes: 1024,
      fetch: async () => response,
    });
    await expect(service.init()).rejects.toMatchObject({ code: 'REMOTE_PROTOCOL' });

    response = json({ ok: true, data: { content: 'x'.repeat(2048) } }, 200, {
      'content-length': '4096',
    });
    await expect(service.init()).rejects.toMatchObject({ code: 'REMOTE_PROTOCOL' });
  });

  it('maps authenticated API errors without accepting unknown error codes', async () => {
    let response = json(
      { ok: false, error: { code: 'ANYTHING', message: 'Sign in again.', requestId: 'req-1' } },
      401,
    );
    const service = new RemoteSynomemService({
      baseUrl: 'https://api.example.test',
      workspaceId: 'workspace',
      expectedActor: actor,
      credentialProvider: credentials,
      fetch: async () => response,
    });
    await expect(service.init()).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
      details: { requestId: 'req-1' },
    });

    response = json({ ok: false, error: { code: 'UNKNOWN_SERVER_CODE', message: 'Nope.' } }, 400);
    await expect(service.init()).rejects.toMatchObject({ code: 'REMOTE_PROTOCOL' });
  });

  it('reports network failures without echoing sensitive request values', async () => {
    const service = new RemoteSynomemService({
      baseUrl: 'https://api.example.test',
      workspaceId: 'workspace',
      expectedActor: actor,
      credentialProvider: credentials,
      fetch: async () => {
        throw new Error('request with test-token-not-a-secret failed');
      },
    });

    const error = await service.init().catch((value: unknown) => value);
    expect(error).toBeInstanceOf(SynomemError);
    expect(error).toMatchObject({ code: 'REMOTE_UNAVAILABLE', details: { cause: 'Error' } });
    expect(JSON.stringify(error)).not.toContain('test-token-not-a-secret');
  });
});
