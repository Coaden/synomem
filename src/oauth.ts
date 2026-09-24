/**
 * The CLI's own OAuth 2.1 client (RFC 8252 native app).
 *
 * Authorization code + PKCE S256 through the system browser and a loopback
 * redirect, against the pre-registered public client `synomem-cli`. The token
 * is audienced to the Synomem API itself: discovery starts from the API's own
 * protected-resource metadata (RFC 9728), never from the MCP gateway, and the
 * discovered issuer and resource are validated before any browser opens.
 *
 * Which agent and workspace the resulting connection may act as is chosen on
 * the consent screen and enforced by the API; nothing here names an actor.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { SynomemError } from './errors.js';
import type { StoredOAuthCredential } from './credentials.js';

export const DEFAULT_CLI_CLIENT_ID = 'synomem-cli';
export const DEFAULT_CALLBACK_PORT = 43_817;
export const DEFAULT_CLI_SCOPE = 'openid offline_access synomem:read synomem:write';
const maximumDocumentBytes = 64 * 1024;
/** Access tokens are treated as expired this long before they actually are. */
const expirySafetyMs = 30_000;

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  scope?: string;
}

export interface ApiAuthorizationMetadata {
  resource: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
}

function trimSlash(value: string): string {
  return value.replace(/\/+$/, '');
}

/** HTTPS, or loopback HTTP (development against a local stack). */
export function secureUrl(value: string, label: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SynomemError('AUTH_REQUIRED', `${label} is not a valid URL.`);
  }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new SynomemError('AUTH_REQUIRED', `${label} must use HTTPS.`);
  }
  if (url.username || url.password) {
    throw new SynomemError('AUTH_REQUIRED', `${label} must not carry credentials.`);
  }
  return url;
}

async function readJson(
  url: URL,
  fetchImplementation: typeof fetch,
  label: string,
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      redirect: 'error',
      headers: { accept: 'application/json' },
    });
  } catch {
    throw new SynomemError('REMOTE_UNAVAILABLE', `${label} is unavailable.`);
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumDocumentBytes) {
    throw new SynomemError('REMOTE_PROTOCOL', `${label} exceeded the safe size limit.`);
  }
  if (!response.ok) {
    throw new SynomemError('REMOTE_PROTOCOL', `${label} returned HTTP ${response.status}.`);
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
    return parsed as Record<string, unknown>;
  } catch {
    throw new SynomemError('REMOTE_PROTOCOL', `${label} is not valid JSON.`);
  }
}

/**
 * Where to sign in for this API, validated.
 *
 * The protected-resource metadata must name THIS API as its resource and at
 * least one authorization server; the authorization server's metadata must
 * name itself as issuer, publish HTTPS endpoints and support S256. A mismatch
 * anywhere stops the login before a browser opens.
 */
export async function discoverApiAuthorization(
  apiUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<ApiAuthorizationMetadata> {
  const api = secureUrl(apiUrl, 'Synomem API URL');
  const resourceMetadata = await readJson(
    new URL('/.well-known/oauth-protected-resource', api.origin),
    fetchImplementation,
    'API protected-resource metadata',
  );
  const resource = resourceMetadata.resource;
  if (typeof resource !== 'string' || trimSlash(resource) !== trimSlash(api.origin)) {
    throw new SynomemError(
      'AUTH_REQUIRED',
      'The API protected-resource metadata does not describe this API.',
    );
  }
  const servers = resourceMetadata.authorization_servers;
  const issuerValue: unknown = Array.isArray(servers) ? (servers as unknown[])[0] : undefined;
  if (typeof issuerValue !== 'string') {
    throw new SynomemError('AUTH_REQUIRED', 'The API names no authorization server.');
  }
  const issuer = secureUrl(issuerValue, 'Authorization server');
  const asMetadata = await readJson(
    new URL(
      `/.well-known/oauth-authorization-server${issuer.pathname === '/' ? '' : trimSlash(issuer.pathname)}`,
      issuer.origin,
    ),
    fetchImplementation,
    'Authorization server metadata',
  );
  if (
    typeof asMetadata.issuer !== 'string' ||
    trimSlash(asMetadata.issuer) !== trimSlash(issuer.href)
  ) {
    throw new SynomemError(
      'AUTH_REQUIRED',
      'The authorization server metadata issuer does not match.',
    );
  }
  const authorizationEndpoint = asMetadata.authorization_endpoint;
  const tokenEndpoint = asMetadata.token_endpoint;
  if (typeof authorizationEndpoint !== 'string' || typeof tokenEndpoint !== 'string') {
    throw new SynomemError('AUTH_REQUIRED', 'Authorization server discovery is incomplete.');
  }
  secureUrl(authorizationEndpoint, 'OAuth authorization endpoint');
  secureUrl(tokenEndpoint, 'OAuth token endpoint');
  const methods = asMetadata.code_challenge_methods_supported;
  if (!Array.isArray(methods) || !methods.includes('S256')) {
    throw new SynomemError('AUTH_REQUIRED', 'The authorization server must support PKCE S256.');
  }
  return {
    resource: trimSlash(resource),
    issuer: trimSlash(asMetadata.issuer),
    authorizationEndpoint,
    tokenEndpoint,
  };
}

async function tokenRequest(
  endpoint: string,
  parameters: URLSearchParams,
  fetchImplementation: typeof fetch,
): Promise<TokenResponse> {
  let response: Response;
  try {
    response = await fetchImplementation(secureUrl(endpoint, 'OAuth token endpoint'), {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
      body: parameters,
    });
  } catch (error) {
    if (error instanceof SynomemError) throw error;
    throw new SynomemError('REMOTE_UNAVAILABLE', 'The OAuth token endpoint is unavailable.');
  }
  const text = await response.text();
  if (Buffer.byteLength(text) > maximumDocumentBytes) {
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

function expiresAt(expiresIn: number | undefined): number {
  // A token without a lifetime is still refreshed on the API's schedule: 10
  // minutes is the contract's maximum access-token lifetime.
  return Date.now() + Math.max(0, (expiresIn ?? 600) * 1_000 - expirySafetyMs);
}

function launchBrowser(url: URL): void {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new SynomemError('CONFIG_INVALID', `Open this URL in a browser: ${url.href}`);
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
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
        finish(
          new SynomemError(
            'AUTH_REQUIRED',
            oauthError === 'access_denied'
              ? 'Authorization was declined.'
              : 'OAuth callback validation failed.',
          ),
        );
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
  apiUrl: string;
  clientId?: string;
  scope?: string;
  callbackPort?: number;
  fetch?: typeof fetch;
  openBrowser?: (url: URL) => void;
  timeoutMs?: number;
}

/** Runs the browser flow and returns the credential for the caller to store. */
export async function loginWithOAuth(options: OAuthLoginOptions): Promise<StoredOAuthCredential> {
  const fetchImplementation = options.fetch ?? fetch;
  const metadata = await discoverApiAuthorization(options.apiUrl, fetchImplementation);
  const clientId = options.clientId ?? DEFAULT_CLI_CLIENT_ID;
  const scope = options.scope ?? DEFAULT_CLI_SCOPE;
  const callbackPort = options.callbackPort ?? DEFAULT_CALLBACK_PORT;
  const redirectUri = `http://127.0.0.1:${callbackPort}/callback`;
  const state = randomBytes(32).toString('base64url');
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');

  const authorizationUrl = new URL(metadata.authorizationEndpoint);
  authorizationUrl.searchParams.set('response_type', 'code');
  authorizationUrl.searchParams.set('client_id', clientId);
  authorizationUrl.searchParams.set('redirect_uri', redirectUri);
  authorizationUrl.searchParams.set('scope', scope);
  authorizationUrl.searchParams.set('state', state);
  authorizationUrl.searchParams.set('code_challenge', challenge);
  authorizationUrl.searchParams.set('code_challenge_method', 'S256');
  authorizationUrl.searchParams.set('resource', metadata.resource);

  const code = await authorizationCode(
    authorizationUrl,
    state,
    callbackPort,
    options.openBrowser ?? launchBrowser,
    options.timeoutMs ?? 5 * 60_000,
  );
  const tokens = await tokenRequest(
    metadata.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: redirectUri,
      resource: metadata.resource,
    }),
    fetchImplementation,
  );
  return {
    kind: 'oauth',
    issuer: metadata.issuer,
    resource: metadata.resource,
    clientId,
    tokenEndpoint: metadata.tokenEndpoint,
    scope: tokens.scope ?? scope,
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    expiresAt: expiresAt(tokens.expires_in),
    generation: 0,
  };
}

/**
 * Spends the refresh token once. Callers hold the credential lock and write the
 * result before releasing it; a failure here is never retried with the same
 * (possibly consumed) refresh token.
 */
export async function refreshOAuthCredential(
  credential: StoredOAuthCredential,
  fetchImplementation: typeof fetch = fetch,
): Promise<StoredOAuthCredential> {
  if (!credential.refreshToken) {
    throw new SynomemError(
      'REAUTHORIZATION_REQUIRED',
      'The stored credential cannot be refreshed.',
    );
  }
  let tokens: TokenResponse;
  try {
    tokens = await tokenRequest(
      credential.tokenEndpoint,
      new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: credential.clientId,
        refresh_token: credential.refreshToken,
        resource: credential.resource,
      }),
      fetchImplementation,
    );
  } catch (error) {
    if (error instanceof SynomemError && error.code === 'REMOTE_UNAVAILABLE') throw error;
    throw new SynomemError(
      'REAUTHORIZATION_REQUIRED',
      'The stored credential was refused when refreshing.',
    );
  }
  return {
    ...credential,
    accessToken: tokens.access_token,
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    scope: tokens.scope ?? credential.scope,
    expiresAt: expiresAt(tokens.expires_in),
    generation: credential.generation + 1,
  };
}
