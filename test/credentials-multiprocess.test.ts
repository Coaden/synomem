/**
 * Headless credential refresh across real processes (plan §8 "Credential
 * storage and refresh"). Children run the built `dist/` (npm test builds first). Several independent Node processes share one
 * protected-file credential; the token endpoint behaves like the provider —
 * a refresh token is single-use and a replay is refused as theft. The
 * guarantees under test:
 *
 *  - concurrent refreshers spend the refresh token exactly once and all end up
 *    with the same rotated credential;
 *  - a process killed while holding the lock does not wedge the others: a dead
 *    owner's lock is broken at once, not after the stale timeout;
 *  - a refresh whose outcome is unknown leaves no replayable refresh token.
 */
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileCredentialStore } from '../src/credentials.js';
import { tempHome } from './helpers.js';

const root = process.cwd();
let server: Server | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

interface Endpoint {
  url: string;
  refreshes: number;
  replays: number;
}

async function tokenEndpoint(
  options: { delayMs?: number; hang?: boolean } = {},
): Promise<Endpoint> {
  const spent = new Set<string>();
  const endpoint: Endpoint = { url: '', refreshes: 0, replays: 0 };
  server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const params = new URLSearchParams(body);
      const token = params.get('refresh_token') ?? '';
      if (spent.has(token)) {
        endpoint.replays += 1;
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid_grant' }));
        return;
      }
      spent.add(token);
      endpoint.refreshes += 1;
      if (options.hang) return; // rotated server-side, response never arrives
      const n = endpoint.refreshes;
      setTimeout(() => {
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            access_token: `access-${n}`,
            refresh_token: `refresh-${n}`,
            token_type: 'Bearer',
            expires_in: 600,
          }),
        );
      }, options.delayMs ?? 150);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address() as { port: number };
  endpoint.url = `http://127.0.0.1:${address.port}/token`;
  return endpoint;
}

async function seed(home: string, tokenUrl: string): Promise<void> {
  await new FileCredentialStore(home).set('ref-shared', {
    kind: 'oauth',
    issuer: 'http://127.0.0.1',
    resource: 'https://api.synomem.example.test',
    clientId: 'synomem-cli',
    tokenEndpoint: tokenUrl,
    scope: 'synomem:read',
    accessToken: 'access-0',
    refreshToken: 'refresh-0',
    expiresAt: 0,
    generation: 0,
  });
}

/** A child process that asks the real credential source for a bearer. */
function refresher(home: string, extra = ''): Promise<{ code: number | null; out: string }> {
  const script = `
    import { credentialSourceFor } from ${JSON.stringify(join(root, 'dist/profiles.js'))};
    import { defaultCredentialStores } from ${JSON.stringify(join(root, 'dist/credentials.js'))};
    const home = ${JSON.stringify(home)};
    const config = { version: 1, profiles: {}, harnessPresets: {}, credentials: {
      shared: { kind: 'oauth', apiUrl: 'https://api.synomem.example.test', store: 'file', secretRef: 'ref-shared' } } };
    ${extra}
    try {
      const token = await credentialSourceFor(home, config, 'shared', { stores: defaultCredentialStores(home) }).bearer();
      process.stdout.write(token);
    } catch (error) {
      process.stdout.write('ERROR:' + (error.code ?? error.message));
    }`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      cwd: root,
      stdio: ['ignore', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.on('data', (chunk: Buffer) => (out += chunk.toString()));
    child.on('close', (code) => resolve({ code, out }));
  });
}

describe('multi-process credential refresh on a protected file store', () => {
  it('spends the refresh token once across concurrent processes', async () => {
    const home = tempHome();
    const endpoint = await tokenEndpoint();
    await seed(home, endpoint.url);
    const results = await Promise.all(Array.from({ length: 6 }, () => refresher(home)));
    expect(results.map((result) => result.out)).toEqual(Array(6).fill('access-1'));
    expect(endpoint.refreshes).toBe(1);
    expect(endpoint.replays).toBe(0);
    const stored = await new FileCredentialStore(home).get('ref-shared');
    expect(stored).toMatchObject({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      generation: 1,
    });
  }, 60_000);

  it("breaks a dead owner's lock at once instead of waiting out the stale timeout", async () => {
    const home = tempHome();
    const endpoint = await tokenEndpoint();
    await seed(home, endpoint.url);
    // A crashed process's leftover lock: a pid that no longer exists.
    const locks = join(home, 'locks');
    const { mkdirSync } = await import('node:fs');
    mkdirSync(locks, { recursive: true, mode: 0o700 });
    const { hostname } = await import('node:os');
    writeFileSync(join(locks, 'shared.lock'), `999999\n${hostname()}\ndeadbeef\n`, { mode: 0o600 });
    const started = Date.now();
    const result = await refresher(home);
    expect(result.out).toBe('access-1');
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(endpoint.refreshes).toBe(1);
  }, 60_000);

  it('leaves no replayable refresh token when the outcome is unknown', async () => {
    const home = tempHome();
    const endpoint = await tokenEndpoint({ hang: true });
    await seed(home, endpoint.url);
    // Shorten the request timeout for the test; production uses 20 s.
    const result = await refresher(
      home,
      `const realTimeout = AbortSignal.timeout;
       AbortSignal.timeout = () => realTimeout.call(AbortSignal, 300);`,
    );
    expect(result.out).toBe('ERROR:REAUTHORIZATION_REQUIRED');
    const stored = await new FileCredentialStore(home).get('ref-shared');
    expect(stored).toMatchObject({ kind: 'oauth' });
    expect((stored as { refreshToken?: string }).refreshToken).toBeUndefined();
    // A second process cannot replay it: nothing to spend.
    expect((await refresher(home)).out).toBe('ERROR:REAUTHORIZATION_REQUIRED');
    expect(endpoint.replays).toBe(0);
  }, 60_000);
});
