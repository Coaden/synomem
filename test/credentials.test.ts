import { describe, expect, it, vi } from 'vitest';
import {
  credentialReference,
  OsCredentialStore,
  type CredentialStore,
  type StoredOAuthCredential,
} from '../src/credentials.js';
import { loginWithOAuth, StoredCredentialProvider } from '../src/oauth.js';

const actor = { kind: 'agent' as const, id: 'codex', displayName: 'Codex' };

function requestBody(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof URLSearchParams) return value.toString();
  throw new Error('Expected a URL-encoded request body.');
}

describe('remote credential storage', () => {
  it('keys credentials to stable actor identity rather than display name', () => {
    expect(credentialReference('https://api.example.test', 'workspace', actor)).toBe(
      credentialReference('https://api.example.test/', 'workspace', {
        ...actor,
        displayName: 'Renamed Codex',
      }),
    );
  });

  it('passes macOS credential values over stdin rather than process arguments', async () => {
    const calls: Array<{ executable: string; arguments_: string[]; input?: string }> = [];
    const credential: StoredOAuthCredential = {
      accessToken: 'access-secret',
      refreshToken: 'refresh-secret',
      tokenEndpoint: 'https://identity.example.test/token',
      clientId: 'public-client',
      resource: 'https://synomem.example.test/mcp',
      scope: 'synomem:read synomem:write',
    };
    const store = new OsCredentialStore({
      platform: 'darwin',
      run: async (executable, arguments_, input) => {
        calls.push({ executable, arguments_, ...(input === undefined ? {} : { input }) });
        return { stdout: input ? '' : JSON.stringify(credential), stderr: '', code: 0 };
      },
    });
    await store.set('reference', credential);
    await expect(store.get('reference')).resolves.toEqual(credential);
    expect(calls[0]?.arguments_.join(' ')).not.toContain('secret');
    expect(calls[0]?.input).toContain('refresh-secret');
    expect(calls[0]?.arguments_.at(-1)).toBe('-w');
  });

  it('prefers the environment and refreshes expired stored access tokens once', async () => {
    const get = vi.fn<CredentialStore['get']>();
    const set = vi.fn<CredentialStore['set']>();
    const store: CredentialStore = { get, set, delete: vi.fn() };
    const environment = new StoredCredentialProvider('reference', store, {
      SYNOMEM_ACCESS_TOKEN: 'environment-token',
    });
    await expect(environment.getAccessToken()).resolves.toBe('environment-token');
    expect(get).not.toHaveBeenCalled();

    get.mockResolvedValue({
      accessToken: 'expired-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() - 1,
      tokenEndpoint: 'https://identity.example.test/token',
      clientId: 'public-client',
      resource: 'https://synomem.example.test/mcp',
      scope: 'synomem:read synomem:write offline_access',
    });
    const fetchImplementation = vi.fn(
      async (_input: string | URL | Request, init?: RequestInit) => {
        expect(requestBody(init?.body)).toContain('grant_type=refresh_token');
        expect(requestBody(init?.body)).toContain('refresh_token=refresh-token');
        return new Response(
          JSON.stringify({
            access_token: 'fresh-token',
            refresh_token: 'rotated-token',
            expires_in: 3600,
          }),
          { status: 200 },
        );
      },
    );
    const provider = new StoredCredentialProvider('reference', store, {}, fetchImplementation);
    await expect(
      Promise.all([provider.getAccessToken(), provider.getAccessToken()]),
    ).resolves.toEqual(['fresh-token', 'fresh-token']);
    expect(fetchImplementation).toHaveBeenCalledTimes(1);
    expect(set).toHaveBeenCalledWith(
      'reference',
      expect.objectContaining({ accessToken: 'fresh-token', refreshToken: 'rotated-token' }),
    );
  });

  it.skipIf(process.env.SYNOMEM_LOOPBACK_TEST !== '1')(
    'completes authorization-code PKCE through a validated loopback callback',
    async () => {
      const probe = createServer();
      await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
      const address = probe.address();
      if (!address || typeof address === 'string')
        throw new Error('Could not reserve a test port.');
      const port = address.port;
      await new Promise<void>((resolve, reject) =>
        probe.close((error) => (error ? reject(error) : resolve())),
      );
      const values = new Map<string, StoredOAuthCredential>();
      const store: CredentialStore = {
        async get(reference) {
          return values.get(reference);
        },
        async set(reference, credential) {
          values.set(reference, credential);
        },
        async delete(reference) {
          return values.delete(reference);
        },
      };
      const fetchImplementation = vi.fn(
        async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
          const url = input instanceof Request ? new URL(input.url) : new URL(input.toString());
          if (url.pathname.includes('oauth-protected-resource')) {
            return new Response(
              JSON.stringify({
                resource: 'https://api.example.test/mcp',
                authorization_servers: ['https://identity.example.test'],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (url.pathname.includes('.well-known')) {
            return new Response(
              JSON.stringify({
                issuer: 'https://identity.example.test',
                authorization_endpoint: 'https://identity.example.test/authorize',
                token_endpoint: 'https://identity.example.test/token',
                response_types_supported: ['code'],
                grant_types_supported: ['authorization_code', 'refresh_token'],
                code_challenge_methods_supported: ['S256'],
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          if (url.pathname === '/token') {
            expect(requestBody(init?.body)).toContain('code_verifier=');
            expect(requestBody(init?.body)).toContain(
              'resource=https%3A%2F%2Fapi.example.test%2Fmcp',
            );
            return new Response(
              JSON.stringify({
                access_token: 'oauth-access-secret',
                refresh_token: 'oauth-refresh-secret',
                expires_in: 3600,
              }),
              { status: 200, headers: { 'content-type': 'application/json' } },
            );
          }
          throw new Error(`Unexpected OAuth request: ${url.href}`);
        },
      );
      await loginWithOAuth({
        baseUrl: 'https://api.example.test',
        clientId: 'public-client',
        credentialReference: 'reference',
        credentialStore: store,
        callbackPort: port,
        fetch: fetchImplementation,
        openBrowser(url) {
          expect(url.searchParams.get('code_challenge_method')).toBe('S256');
          const state = url.searchParams.get('state');
          void fetch(`http://127.0.0.1:${port}/callback?code=test-code&state=${state}`);
        },
      });
      expect(values.get('reference')).toMatchObject({
        accessToken: 'oauth-access-secret',
        refreshToken: 'oauth-refresh-secret',
        clientId: 'public-client',
      });
    },
  );
});
import { createServer } from 'node:http';
