import { chmodSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  FileCredentialStore,
  OsCredentialStore,
  withCredentialLock,
  type CredentialStore,
  type StoredCredential,
  type StoredOAuthCredential,
} from '../src/credentials.js';
import { discoverApiAuthorization, loginWithOAuth, refreshOAuthCredential } from '../src/oauth.js';
import { ConnectionCredentialSource, type CredentialEntry } from '../src/profiles.js';
import { tempHome } from './helpers.js';

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
const bodyOf = (init?: RequestInit): string =>
  typeof init?.body === 'string'
    ? init.body
    : init?.body instanceof URLSearchParams
      ? init.body.toString()
      : '';

const oauthCredential = (
  overrides: Partial<StoredOAuthCredential> = {},
): StoredOAuthCredential => ({
  kind: 'oauth',
  issuer: 'https://auth.synomem.example',
  resource: 'https://api.synomem.example',
  clientId: 'synomem-cli',
  tokenEndpoint: 'https://auth.synomem.example/api/auth/oauth2/token',
  scope: 'openid offline_access synomem:read synomem:write',
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  expiresAt: Date.now() + 60_000,
  generation: 0,
  ...overrides,
});

class MemoryStore implements CredentialStore {
  values = new Map<string, StoredCredential>();
  async get(reference: string) {
    return this.values.get(reference);
  }
  async set(reference: string, credential: StoredCredential) {
    this.values.set(reference, structuredClone(credential));
  }
  async delete(reference: string) {
    return this.values.delete(reference);
  }
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const discoveryFetch = (overrides: { resource?: string; issuer?: string } = {}) =>
  (async (input: string | URL | Request) => {
    const url = new URL(urlOf(input));
    if (url.pathname === '/.well-known/oauth-protected-resource') {
      return json({
        resource: overrides.resource ?? 'https://api.synomem.example',
        authorization_servers: ['https://auth.synomem.example'],
      });
    }
    if (url.pathname === '/.well-known/oauth-authorization-server') {
      return json({
        issuer: overrides.issuer ?? 'https://auth.synomem.example',
        authorization_endpoint: 'https://auth.synomem.example/api/auth/oauth2/authorize',
        token_endpoint: 'https://auth.synomem.example/api/auth/oauth2/token',
        code_challenge_methods_supported: ['S256'],
      });
    }
    return json({ error: 'not_found' }, 404);
  }) as typeof fetch;

describe('credential stores', () => {
  it('round-trips both credential kinds through a restricted file, mode 0600', async () => {
    const home = tempHome();
    const store = new FileCredentialStore(home);
    await store.set('ref-oauth', oauthCredential());
    await store.set('ref-key', { kind: 'access-key', secret: 'syn_abc.def' });
    expect(await store.get('ref-oauth')).toEqual(
      oauthCredential({ expiresAt: expect.any(Number) as number }),
    );
    expect(await store.get('ref-key')).toEqual({ kind: 'access-key', secret: 'syn_abc.def' });
    // Windows has no POSIX modes; there the file relies on the user profile's ACLs.
    if (process.platform !== 'win32') {
      expect(statSync(join(home, 'credentials', 'ref-key.json')).mode & 0o777).toBe(0o600);
      expect(statSync(join(home, 'credentials')).mode & 0o777).toBe(0o700);
    }
    expect(await store.delete('ref-key')).toBe(true);
    expect(await store.get('ref-key')).toBeUndefined();
  });

  it('refuses the old installation-key format instead of reading it', async () => {
    const home = tempHome();
    mkdirSync(join(home, 'credentials'), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(home, 'credentials', 'old.json'),
      JSON.stringify({ kind: 'installation-key', accessToken: 'syn_old' }),
      { mode: 0o600 },
    );
    await expect(new FileCredentialStore(home).get('old')).rejects.toMatchObject({
      code: 'AUTH_REQUIRED',
    });
  });

  it('explains a missing OS credential store instead of crashing, with no fallback', async () => {
    const missing = Object.assign(new Error('spawn secret-tool ENOENT'), { code: 'ENOENT' });
    const store = new OsCredentialStore({
      platform: 'linux',
      run: async () => {
        throw missing;
      },
    });
    const refused: unknown = await store
      .set('ref-x', { kind: 'access-key', secret: 'syn_secret' })
      .catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'CONFIG_INVALID' });
    expect((refused as Error).message).toContain('--store file');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a credential file or directory other users can read, like ssh',
    async () => {
      const home = tempHome();
      const store = new FileCredentialStore(home);
      await store.set('ref-open', { kind: 'access-key', secret: 'syn_secret' });
      chmodSync(join(home, 'credentials', 'ref-open.json'), 0o644);
      await expect(store.get('ref-open')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      chmodSync(join(home, 'credentials', 'ref-open.json'), 0o600);
      chmodSync(join(home, 'credentials'), 0o755);
      await expect(store.get('ref-open')).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      chmodSync(join(home, 'credentials'), 0o700);
      await expect(store.get('ref-open')).resolves.toEqual({
        kind: 'access-key',
        secret: 'syn_secret',
      });
    },
  );

  it('round-trips through the macOS keychain and Linux secret-tool helpers', async () => {
    for (const platform of ['darwin', 'linux'] as const) {
      const vault = new Map<string, string>();
      const calls: string[] = [];
      const store = new OsCredentialStore({
        platform,
        run: async (executable, args, input) => {
          calls.push(`${executable} ${args[0]}`);
          const account = args[args.indexOf(platform === 'darwin' ? '-a' : 'account') + 1]!;
          if (args[0] === 'add-generic-password' || args[0] === 'store') {
            vault.set(account, (input ?? '').trim());
            return { stdout: '', stderr: '', code: 0 };
          }
          if (args[0] === 'find-generic-password' || args[0] === 'lookup') {
            const value = vault.get(account);
            return value
              ? { stdout: `${value}\n`, stderr: '', code: 0 }
              : { stdout: '', stderr: 'not found', code: 44 };
          }
          vault.delete(account);
          return { stdout: '', stderr: '', code: 0 };
        },
      });
      await store.set('synomem-1', { kind: 'access-key', secret: 'syn_k' });
      expect(await store.get('synomem-1')).toEqual({ kind: 'access-key', secret: 'syn_k' });
      await store.set('synomem-2', oauthCredential());
      expect((await store.get('synomem-2'))?.kind).toBe('oauth');
      expect(await store.delete('synomem-1')).toBe(true);
      expect(await store.get('synomem-1')).toBeUndefined();
      expect(calls[0]).toContain(platform === 'darwin' ? '/usr/bin/security' : 'secret-tool');
    }
  });

  it('names the explicit alternative when the keychain refuses a write, never falling back', async () => {
    const store = new OsCredentialStore({
      platform: 'darwin',
      run: async () => ({ stdout: '', stderr: 'denied', code: 1 }),
    });
    await expect(
      store.set('synomem-x', { kind: 'access-key', secret: 'syn_k' }),
    ).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('--store file') as string,
    });
  });
});

describe('cross-process refresh lock', () => {
  it('serializes holders of the same credential lock', async () => {
    const home = tempHome();
    const order: string[] = [];
    await Promise.all([
      withCredentialLock(home, 'codex-mac', async () => {
        order.push('a:start');
        await new Promise((resolve) => setTimeout(resolve, 50));
        order.push('a:end');
      }),
      withCredentialLock(home, 'codex-mac', async () => {
        order.push('b:start');
        order.push('b:end');
      }),
    ]);
    expect(order.join(' ')).toMatch(/^(a:start a:end b:start b:end|b:start b:end a:start a:end)$/);
  });

  it('breaks a stale lock left by a crashed process', async () => {
    const home = tempHome();
    mkdirSync(join(home, 'locks'), { recursive: true });
    writeFileSync(join(home, 'locks', 'codex-mac.lock'), '99999\n');
    await expect(
      withCredentialLock(home, 'codex-mac', async () => 'ran', { staleMs: 0 }),
    ).resolves.toBe('ran');
  });
});

describe('connection credential source', () => {
  const entry = (overrides: Partial<CredentialEntry> = {}): CredentialEntry => ({
    kind: 'oauth',
    apiUrl: 'https://api.synomem.example',
    store: 'keychain',
    secretRef: 'synomem-ref',
    createdAt: new Date().toISOString(),
    ...overrides,
  });

  it('uses an unexpired OAuth token as stored and an access key verbatim', async () => {
    const home = tempHome();
    const keychain = new MemoryStore();
    await keychain.set('synomem-ref', oauthCredential());
    await keychain.set('synomem-key', { kind: 'access-key', secret: 'syn_k' });
    const stores = { keychain, file: new MemoryStore() };
    expect(
      await new ConnectionCredentialSource({ home, name: 'a', entry: entry(), stores }).bearer(),
    ).toBe('access-1');
    expect(
      await new ConnectionCredentialSource({
        home,
        name: 'b',
        entry: entry({ kind: 'access-key', secretRef: 'synomem-key' }),
        stores,
      }).bearer(),
    ).toBe('syn_k');
  });

  it('reads an environment connection from SYNOMEM_ACCESS_TOKEN only', async () => {
    const home = tempHome();
    const stores = { keychain: new MemoryStore(), file: new MemoryStore() };
    const environment = entry({ kind: 'access-key', store: 'environment', secretRef: undefined });
    await expect(
      new ConnectionCredentialSource({
        home,
        name: 'ci',
        entry: environment,
        stores,
        env: {},
      }).bearer(),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(
      await new ConnectionCredentialSource({
        home,
        name: 'ci',
        entry: environment,
        stores,
        env: { SYNOMEM_ACCESS_TOKEN: 'syn_env' },
      }).bearer(),
    ).toBe('syn_env');
  });

  it('refreshes once when two processes find the same expired token', async () => {
    const home = tempHome();
    const keychain = new MemoryStore();
    await keychain.set('synomem-ref', oauthCredential({ expiresAt: 0 }));
    let refreshCalls = 0;
    const fetchImplementation = (async (_input: string | URL | Request, init?: RequestInit) => {
      refreshCalls += 1;
      const body = new URLSearchParams(bodyOf(init));
      expect(body.get('grant_type')).toBe('refresh_token');
      expect(body.get('refresh_token')).toBe('refresh-1');
      await new Promise((resolve) => setTimeout(resolve, 30));
      return json({ access_token: 'access-2', refresh_token: 'refresh-2', expires_in: 600 });
    }) as typeof fetch;
    const stores = { keychain, file: new MemoryStore() };
    // Two independent sources stand in for two processes sharing one store.
    const [first, second] = await Promise.all([
      new ConnectionCredentialSource({
        home,
        name: 'codex-mac',
        entry: entry(),
        stores,
        fetch: fetchImplementation,
      }).bearer(),
      new ConnectionCredentialSource({
        home,
        name: 'codex-mac',
        entry: entry(),
        stores,
        fetch: fetchImplementation,
      }).bearer(),
    ]);
    expect([first, second]).toEqual(['access-2', 'access-2']);
    expect(refreshCalls).toBe(1);
    const stored = (await keychain.get('synomem-ref')) as StoredOAuthCredential;
    expect(stored).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      generation: 1,
    });
  });

  it('requires a new login when a refresh is refused, never retrying the spent token', async () => {
    const home = tempHome();
    const keychain = new MemoryStore();
    await keychain.set('synomem-ref', oauthCredential({ expiresAt: 0 }));
    let calls = 0;
    const refused = (async () => {
      calls += 1;
      return json({ error: 'invalid_grant' }, 400);
    }) as typeof fetch;
    const source = new ConnectionCredentialSource({
      home,
      name: 'codex-mac',
      entry: entry(),
      stores: { keychain, file: new MemoryStore() },
      fetch: refused,
    });
    await expect(source.bearer()).rejects.toMatchObject({
      code: 'REAUTHORIZATION_REQUIRED',
      message: expect.stringContaining('synomem connection login --name codex-mac') as string,
    });
    expect(calls).toBe(1);
  });
});

describe('CLI OAuth', () => {
  it('discovers the authorization server from the API, not the MCP gateway', async () => {
    const seen: string[] = [];
    const fetchImplementation = (async (input: string | URL | Request) => {
      seen.push(new URL(urlOf(input)).pathname);
      return discoveryFetch()(input);
    }) as typeof fetch;
    const metadata = await discoverApiAuthorization(
      'https://api.synomem.example',
      fetchImplementation,
    );
    expect(metadata).toMatchObject({
      resource: 'https://api.synomem.example',
      issuer: 'https://auth.synomem.example',
    });
    expect(seen).toEqual([
      '/.well-known/oauth-protected-resource',
      '/.well-known/oauth-authorization-server',
    ]);
    expect(seen.some((path) => path.includes('/mcp'))).toBe(false);
  });

  it('refuses metadata that describes another resource or another issuer', async () => {
    await expect(
      discoverApiAuthorization(
        'https://api.synomem.example',
        discoveryFetch({ resource: 'https://mcp.synomem.example' }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
    await expect(
      discoverApiAuthorization(
        'https://api.synomem.example',
        discoveryFetch({ issuer: 'https://evil.example' }),
      ),
    ).rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
  });

  it('runs PKCE S256 with the synomem-cli client and the API as resource', async () => {
    let tokenBody: URLSearchParams | undefined;
    const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(urlOf(input));
      if (url.pathname.endsWith('/oauth2/token')) {
        tokenBody = new URLSearchParams(bodyOf(init));
        return json({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 600,
          scope: 'openid synomem:read',
        });
      }
      return discoveryFetch()(input);
    }) as typeof fetch;
    let authorizationUrl: URL | undefined;
    const port = 43_900 + Math.floor(Math.random() * 90);
    const credential = await loginWithOAuth({
      apiUrl: 'https://api.synomem.example',
      callbackPort: port,
      fetch: fetchImplementation,
      openBrowser: (url) => {
        authorizationUrl = url;
        void fetch(
          `http://127.0.0.1:${port}/callback?code=the-code&state=${url.searchParams.get('state')}`,
        );
      },
    });
    expect(authorizationUrl?.searchParams.get('client_id')).toBe('synomem-cli');
    expect(authorizationUrl?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorizationUrl?.searchParams.get('resource')).toBe('https://api.synomem.example');
    expect(tokenBody?.get('code')).toBe('the-code');
    expect(tokenBody?.get('code_verifier')).toBeTruthy();
    expect(credential).toMatchObject({
      kind: 'oauth',
      accessToken: 'at',
      refreshToken: 'rt',
      clientId: 'synomem-cli',
      resource: 'https://api.synomem.example',
      generation: 0,
    });
  });

  it('increments the generation on every refresh', async () => {
    const refreshed = await refreshOAuthCredential(oauthCredential({ generation: 4 }), async () =>
      json({ access_token: 'new', expires_in: 600 }),
    );
    expect(refreshed).toMatchObject({
      accessToken: 'new',
      refreshToken: 'refresh-1',
      generation: 5,
    });
  });
});
