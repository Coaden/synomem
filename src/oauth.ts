import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  discoverOAuthServerInfo,
  startAuthorization,
} from '@modelcontextprotocol/sdk/client/auth.js';
import { SynomemError } from './errors.js';
import type { CredentialStore, StoredOAuthCredential } from './credentials.js';
import type { SynomemCredentialProvider } from './remote.js';

const defaultScope = 'synomem:read synomem:write offline_access';

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

function secureEndpoint(value: string, label: string): URL {
  const url = new URL(value);
  if (url.protocol !== 'https:') {
    throw new SynomemError('AUTH_REQUIRED', `${label} must use HTTPS.`);
  }
  return url;
}

async function tokenRequest(
  endpoint: string,
  parameters: URLSearchParams,
  fetchImplementation: typeof fetch,
  signal?: AbortSignal,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImplementation(secureEndpoint(endpoint, 'OAuth token endpoint'), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: parameters,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (error instanceof SynomemError) throw error;
    throw new SynomemError('REMOTE_UNAVAILABLE', 'The OAuth token endpoint is unavailable.');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > 64 * 1024) {
    throw new SynomemError('REMOTE_PROTOCOL', 'OAuth token response exceeded the safe limit.');
  }
  let parsed: Partial<TokenResponse>;
  try {
    parsed = JSON.parse(text) as Partial<TokenResponse>;
  } catch {
    throw new SynomemError('AUTH_REQUIRED', 'The OAuth token response was invalid.');
  }
  if (!response.ok || typeof parsed.access_token !== 'string') {
    throw new SynomemError('AUTH_REQUIRED', 'OAuth authorization was rejected.');
  }
  return parsed as TokenResponse;
}

function launchBrowser(url: URL): void {
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new SynomemError('CONFIG_INVALID', `Open this URL in a browser: ${url.href}`);
  }
  const child = spawn(command, [url.href], { detached: true, stdio: 'ignore' });
  child.once('error', () => undefined);
  child.unref();
}

async function authorizationCode(
  authorizationUrl: URL,
  state: string,
  callbackPort: number,
  openBrowser: (url: URL) => void,
  timeoutMs: number,
): Promise<string> {
  return await new Promise((resolve, reject) => {
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', `http://127.0.0.1:${callbackPort}`);
      if (url.pathname !== '/callback') {
        response.writeHead(404).end('Not found');
        return;
      }
      const code = url.searchParams.get('code');
      const returnedState = url.searchParams.get('state');
      const oauthError = url.searchParams.get('error');
      if (oauthError || !code || returnedState !== state) {
        response.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        response.end('Synomem authorization failed. Return to your terminal.');
        finish(new SynomemError('AUTH_REQUIRED', 'OAuth callback validation failed.'));
        return;
      }
      response.writeHead(200, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store',
      });
      response.end('Synomem authorization complete. You may close this window.');
      finish(undefined, code);
    });
    const timer = setTimeout(
      () => finish(new SynomemError('AUTH_REQUIRED', 'OAuth login timed out.')),
      timeoutMs,
    );
    const finish = (error?: Error, code?: string) => {
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else if (code) resolve(code);
    };
    server.once('error', (error) => finish(error));
    server.listen(callbackPort, '127.0.0.1', () => {
      try {
        openBrowser(authorizationUrl);
      } catch (error) {
        finish(error instanceof Error ? error : new Error(String(error)));
      }
    });
  });
}

export interface OAuthLoginOptions {
  baseUrl: string;
  clientId: string;
  credentialReference: string;
  credentialStore: CredentialStore;
  scope?: string;
  callbackPort?: number;
  fetch?: typeof fetch;
  openBrowser?: (url: URL) => void;
  timeoutMs?: number;
}

export async function loginWithOAuth(options: OAuthLoginOptions): Promise<void> {
  const fetchImplementation = options.fetch ?? fetch;
  const mcpUrl = new URL('/mcp', options.baseUrl);
  const discovered = await discoverOAuthServerInfo(mcpUrl, { fetchFn: fetchImplementation });
  const metadata = discovered.authorizationServerMetadata;
  if (!metadata?.authorization_endpoint || !metadata.token_endpoint) {
    throw new SynomemError('AUTH_REQUIRED', 'OAuth server discovery is incomplete.');
  }
  secureEndpoint(metadata.authorization_endpoint, 'OAuth authorization endpoint');
  secureEndpoint(metadata.token_endpoint, 'OAuth token endpoint');
  if (!metadata.code_challenge_methods_supported?.includes('S256')) {
    throw new SynomemError('AUTH_REQUIRED', 'The OAuth server must support PKCE S256.');
  }
  const callbackPort = options.callbackPort ?? 43_817;
  const redirectUrl = new URL(`http://127.0.0.1:${callbackPort}/callback`);
  const state = randomBytes(32).toString('base64url');
  const resource = new URL(discovered.resourceMetadata?.resource ?? mcpUrl.href);
  const scope = options.scope ?? defaultScope;
  const started = await startAuthorization(discovered.authorizationServerUrl, {
    metadata,
    clientInformation: { client_id: options.clientId },
    redirectUrl,
    scope,
    state,
    resource,
  });
  const code = await authorizationCode(
    started.authorizationUrl,
    state,
    callbackPort,
    options.openBrowser ?? launchBrowser,
    options.timeoutMs ?? 5 * 60_000,
  );
  const tokens = await tokenRequest(
    metadata.token_endpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: options.clientId,
      code,
      code_verifier: started.codeVerifier,
      redirect_uri: redirectUrl.href,
      resource: resource.href,
    }),
    fetchImplementation,
  );
  await options.credentialStore.set(options.credentialReference, {
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.expires_in
      ? { expiresAt: Date.now() + Math.max(0, tokens.expires_in - 30) * 1_000 }
      : {}),
    tokenEndpoint: metadata.token_endpoint,
    clientId: options.clientId,
    resource: resource.href,
    scope: tokens.scope ?? scope,
  });
}

export class StoredCredentialProvider implements SynomemCredentialProvider {
  private refresh?: Promise<string | undefined>;
  private credential?: StoredOAuthCredential;
  private loaded = false;

  constructor(
    private readonly reference: string,
    private readonly store: CredentialStore,
    private readonly env: NodeJS.ProcessEnv = process.env,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async getAccessToken(signal?: AbortSignal): Promise<string | undefined> {
    if (this.env.SYNOMEM_ACCESS_TOKEN) return this.env.SYNOMEM_ACCESS_TOKEN;
    if (!this.loaded) {
      const stored = await this.store.get(this.reference);
      /*
       * An installation key is not an OAuth credential: it cannot be refreshed
       * and has no client or token endpoint. Treating one as OAuth would mean
       * trying to renew something that never renews that way, so this path
       * ignores it and lets the installation-key path handle it.
       */
      this.credential = stored && 'kind' in stored ? undefined : stored;
      this.loaded = true;
    }
    const credential = this.credential;
    if (!credential) return undefined;
    if (!credential.expiresAt || credential.expiresAt > Date.now()) return credential.accessToken;
    if (!credential.refreshToken) return undefined;
    this.refresh ??= this.refreshCredential(credential, signal).finally(() => {
      this.refresh = undefined;
    });
    return await this.refresh;
  }

  private async refreshCredential(
    credential: StoredOAuthCredential,
    signal?: AbortSignal,
  ): Promise<string> {
    const tokens = await tokenRequest(
      credential.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credential.clientId,
        refresh_token: credential.refreshToken!,
        resource: credential.resource,
        scope: credential.scope,
      }),
      this.fetchImplementation,
      signal,
    );
    const updated: StoredOAuthCredential = {
      ...credential,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? credential.refreshToken,
      ...(tokens.expires_in
        ? { expiresAt: Date.now() + Math.max(0, tokens.expires_in - 30) * 1_000 }
        : { expiresAt: undefined }),
      scope: tokens.scope ?? credential.scope,
    };
    await this.store.set(this.reference, updated);
    this.credential = updated;
    return updated.accessToken;
  }
}
