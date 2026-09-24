import { describe, expect, it } from 'vitest';
import { createLocalResolver, createRemoteResolver, localContextId } from '../src/resolvers.js';
import { tempHome, testClient } from './helpers.js';

const gracie = { kind: 'agent' as const, id: 'agt-gracie', displayName: 'Gracie' };
const astra = { kind: 'agent' as const, id: 'agt-astra', displayName: 'Astra' };

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fake hosted API: two contexts, capabilities bound to whichever context is selected. */
function fakeApi(mode: 'fixed' | 'explicit' = 'explicit') {
  const contexts = [
    {
      contextId: 'ctx_gracie_eng',
      organizationId: 'org-1',
      workspaceId: 'ws-eng',
      workspaceName: 'Engineering',
      actor: gracie,
      actions: ['synomem:read', 'synomem:write'],
      source: 'target',
    },
    {
      contextId: 'ctx_astra_eng',
      organizationId: 'org-1',
      workspaceId: 'ws-eng',
      workspaceName: 'Engineering',
      actor: astra,
      actions: ['synomem:read'],
      source: 'target',
    },
  ];
  const seen: Array<{ path: string; headers: Headers }> = [];
  const fetcher = (async (input: unknown, init?: RequestInit) => {
    const url = input instanceof URL ? input : new URL(String(input));
    const headers = new Headers(init?.headers);
    seen.push({ path: url.pathname, headers });
    if (url.pathname === '/v1/contexts') {
      return json({
        ok: true,
        data: {
          mode,
          fixedContextId: mode === 'fixed' ? 'ctx_gracie_eng' : null,
          contexts: mode === 'fixed' ? contexts.slice(0, 1) : contexts,
          nextCursor: null,
        },
      });
    }
    if (url.pathname === '/v1/capabilities') {
      const selected = contexts.find(
        (entry) => entry.contextId === headers.get('synomem-context-id'),
      );
      if (!selected) {
        return json({ ok: false, error: { code: 'CONTEXT_REQUIRED', message: 'Pick one.' } }, 400);
      }
      return json({
        ok: true,
        data: {
          backend: 'remote',
          binding: {
            workspaceId: selected.workspaceId,
            actor: selected.actor,
            contextId: selected.contextId,
          },
          administration: {
            agentCreationViaMcp: false,
            agentArchiveViaMcp: false,
            rebuildViaMcp: false,
          },
          projections: {
            writeWinsMarkdown: false,
            writeMemoryMarkdown: false,
            writeTasksMarkdown: false,
            writeInboxEntries: false,
          },
        },
      });
    }
    return json({ ok: false, error: { code: 'ITEM_NOT_FOUND', message: 'No route.' } }, 404);
  }) as typeof fetch;
  return { fetcher, seen };
}

describe('remote context resolver', () => {
  it('requires a context in explicit mode and binds each context to its own actor', async () => {
    const api = fakeApi('explicit');
    const resolver = createRemoteResolver({
      baseUrl: 'https://api.example.test',
      credential: { bearer: async () => 'token' },
      fetch: api.fetcher,
    });
    await expect(resolver.resolve()).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' });

    const [first, second] = await Promise.all([
      resolver.resolve('ctx_gracie_eng'),
      resolver.resolve('ctx_astra_eng'),
    ]);
    expect(first.context).toMatchObject({ contextId: 'ctx_gracie_eng', actor: gracie });
    expect(second.context).toMatchObject({ contextId: 'ctx_astra_eng', actor: astra });
    expect(first.service).not.toBe(second.service);
    expect(resolver.mode()).toBe('explicit');

    // Every data request carried only the context selector.
    for (const request of api.seen.filter((entry) => entry.path !== '/v1/contexts')) {
      expect(request.headers.get('synomem-context-id')).toMatch(/^ctx_/);
      expect(request.headers.get('synomem-workspace-id')).toBeNull();
      expect(request.headers.get('synomem-agent-id')).toBeNull();
    }

    // A context the listing does not contain is refused without saying whether it exists.
    await expect(resolver.resolve('ctx_mike_research')).rejects.toMatchObject({
      code: 'CONTEXT_FORBIDDEN',
    });
    await resolver.close?.();
  });

  it('selects the fixed context when the grant is fixed and nothing is named', async () => {
    const api = fakeApi('fixed');
    const resolver = createRemoteResolver({
      baseUrl: 'https://api.example.test',
      credential: async () => 'token',
      fetch: api.fetcher,
    });
    const bound = await resolver.resolve();
    expect(bound.context.contextId).toBe('ctx_gracie_eng');
    expect((await resolver.resolve('default')).context.contextId).toBe('ctx_gracie_eng');
  });

  it('pins a fixed profile to one context even when the grant allows more', async () => {
    const api = fakeApi('explicit');
    const resolver = createRemoteResolver({
      baseUrl: 'https://api.example.test',
      credential: async () => 'token',
      pinnedContextId: 'ctx_gracie_eng',
      fetch: api.fetcher,
    });
    expect(resolver.mode()).toBe('fixed');
    expect((await resolver.resolve()).context.actor).toEqual(gracie);
    await expect(resolver.resolve('ctx_astra_eng')).rejects.toMatchObject({
      code: 'CONTEXT_FORBIDDEN',
    });
    const listing = await resolver.list();
    expect(listing).toMatchObject({ mode: 'fixed', fixedContextId: 'ctx_gracie_eng' });
    expect(listing.contexts.map((entry) => entry.contextId)).toEqual(['ctx_gracie_eng']);
  });

  it('restricts an explicit preset to its allowed contexts', async () => {
    const api = fakeApi('explicit');
    const resolver = createRemoteResolver({
      baseUrl: 'https://api.example.test',
      credential: async () => 'token',
      allowedContextIds: ['ctx_astra_eng'],
      fetch: api.fetcher,
    });
    await expect(resolver.resolve('ctx_gracie_eng')).rejects.toMatchObject({
      code: 'CONTEXT_FORBIDDEN',
    });
    expect((await resolver.resolve('ctx_astra_eng')).context.actor).toEqual(astra);
    expect((await resolver.list()).contexts.map((entry) => entry.contextId)).toEqual([
      'ctx_astra_eng',
    ]);
  });
});

describe('local context resolver', () => {
  it('mints a random 128-bit id per store and actor, stable across renames, never derived', () => {
    const store = tempHome();
    const other = tempHome();
    const a = localContextId(store, { kind: 'agent', id: '01AGENT', displayName: 'Gracie' });
    const renamed = localContextId(store, {
      kind: 'agent',
      id: '01AGENT',
      displayName: 'Gracie Renamed',
    });
    const otherStore = localContextId(other, { kind: 'agent', id: '01AGENT' });
    const otherActor = localContextId(store, { kind: 'agent', id: '01OTHER' });
    expect(a).toMatch(/^lctx_[0-9a-f]{32}$/);
    expect(renamed).toBe(a);
    expect(otherStore).not.toBe(a);
    expect(otherActor).not.toBe(a);
    // Not a function of the tuple: a fresh store gives the same actor a new id.
    expect(localContextId(tempHome(), { kind: 'agent', id: '01AGENT' })).not.toBe(otherStore);
  });

  it('binds one canonical actor in fixed mode and refuses any other context', async () => {
    const home = tempHome();
    const admin = await testClient(home);
    await admin.agents.create({ handle: 'gracie', displayName: 'Gracie' });
    await admin.close();
    const resolver = createLocalResolver({ home, actor: { kind: 'agent', id: 'gracie' } });
    const bound = await resolver.resolve();
    expect(bound.context.actor.kind).toBe('agent');
    expect(bound.context.actor.id).not.toBe('gracie'); // resolved to the canonical opaque id
    expect(bound.context.organizationId).toBeNull();
    expect((await resolver.resolve(bound.context.contextId)).service).toBe(bound.service);
    await expect(resolver.resolve('lctx_ffffffffffffffffffffffff')).rejects.toMatchObject({
      code: 'CONTEXT_FORBIDDEN',
    });
    await resolver.close?.();
  });
});
