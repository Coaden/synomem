import { describe, expect, it } from 'vitest';
import {
  discoverBoundWorkspace,
  discoverOrganizations,
  workspaceChoices,
} from '../src/discover.js';

/** A minimal stand-in for the hosted service's response envelope. */
function respond(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function router(routes: Record<string, unknown>): typeof globalThis.fetch {
  return async (input: unknown, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const headers = new Headers(init?.headers);
    // Every discovery call must present the credential, or the service would
    // answer for an anonymous caller and the list would be silently empty.
    expect(headers.get('authorization')).toBe('Bearer access-secret');
    const route = routes[url.pathname];
    if (route === undefined) return respond(404, { ok: false, error: { message: 'no route' } });
    return respond(200, { ok: true, data: route, apiVersion: 'v1' });
  };
}

describe('workspace discovery', () => {
  it('reads the single workspace an installation key is bound to', async () => {
    await expect(
      discoverBoundWorkspace({
        baseUrl: 'https://api.synomem.example.test',
        accessToken: 'access-secret',
        fetch: router({
          '/v1/identity': {
            workspaceId: 'ws-04psqx2rkt8ttft7a1t2z69r97',
            actor: { kind: 'agent', id: '01M1Y0000000000000000CODEX', displayName: 'Codex' },
          },
        }),
      }),
    ).resolves.toMatchObject({ workspaceId: 'ws-04psqx2rkt8ttft7a1t2z69r97' });
  });

  it('keeps a base URL with no trailing slash and one with it interchangeable', async () => {
    const identity = { '/v1/identity': { workspaceId: 'ws-1', actor: { kind: 'agent', id: 'a' } } };
    for (const baseUrl of [
      'https://api.synomem.example.test',
      'https://api.synomem.example.test/',
    ]) {
      await expect(
        discoverBoundWorkspace({ baseUrl, accessToken: 'access-secret', fetch: router(identity) }),
      ).resolves.toMatchObject({ workspaceId: 'ws-1' });
    }
  });

  it('reports an unusable credential as an authentication problem, not a protocol one', async () => {
    const unauthorized = (async () =>
      respond(401, {
        ok: false,
        error: { code: 'AUTH_REQUIRED', message: 'Access token is invalid.' },
      })) as typeof globalThis.fetch;
    await expect(
      discoverBoundWorkspace({
        baseUrl: 'https://api.synomem.example.test',
        accessToken: 'expired',
        fetch: unauthorized,
      }),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED', message: 'Access token is invalid.' });
  });

  it('reports an unreachable service without pretending the credential is bad', async () => {
    const offline = (async () => {
      throw new Error('connect ECONNREFUSED');
    }) as typeof globalThis.fetch;
    await expect(
      discoverBoundWorkspace({
        baseUrl: 'https://api.synomem.example.test',
        accessToken: 'access-secret',
        fetch: offline,
      }),
    ).rejects.toMatchObject({ code: 'REMOTE_UNAVAILABLE' });
  });

  it('lists every organization with its workspaces, empty ones included', async () => {
    const organizations = await discoverOrganizations({
      baseUrl: 'https://api.synomem.example.test',
      accessToken: 'access-secret',
      fetch: router({
        '/v1/me': {
          account: { id: 'acct-1', email: 'troy@example.test', name: 'Troy' },
          organizations: [
            { id: 'org-1', slug: 'clinic', displayName: 'Clinic', role: 'owner' },
            { id: 'org-2', slug: 'labs', displayName: 'Labs', role: 'member' },
          ],
        },
        '/v1/organizations/org-1/workspaces': [
          { id: 'ws-1', displayName: 'Production' },
          { id: 'ws-2', displayName: 'Staging' },
        ],
        '/v1/organizations/org-2/workspaces': [],
      }),
    });

    // An organization with no workspaces is still reported: "you belong here
    // and it is empty" is a different answer from finding nothing at all.
    expect(organizations).toMatchObject([
      { id: 'org-1', workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }] },
      { id: 'org-2', workspaces: [] },
    ]);

    // Two organizations may both call a workspace "Production", so the
    // organization belongs in the label rather than only in the detail.
    expect(workspaceChoices(organizations)).toEqual([
      { value: 'ws-1', label: 'Clinic / Production', detail: 'ws-1' },
      { value: 'ws-2', label: 'Clinic / Staging', detail: 'ws-2' },
    ]);
  });
});
