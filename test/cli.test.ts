import { Readable, Writable } from 'node:stream';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runCli, type CliDependencies, type CliIo } from '../src/cli.js';
import { FileCredentialStore, type CredentialStores } from '../src/credentials.js';
import { ProfileStore, type ProfilesConfig } from '../src/profiles.js';
import type { PromptIo } from '../src/prompt.js';
import type { ContextResolver } from '../src/resolvers.js';
import type { ContextSummary } from '../src/types.js';
import { tempHome } from './helpers.js';

const urlOf = (input: string | URL | Request): string =>
  typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

function piped(input = ''): PromptIo {
  return {
    input: Readable.from([input]),
    output: new Writable({ write: (_chunk, _encoding, done) => done() }),
    interactive: false,
  };
}

function fileStores(home: string): CredentialStores {
  // The keychain is replaced by a second file store so no test touches the
  // real operating-system credential store.
  return {
    keychain: new FileCredentialStore(join(home, 'fake-keychain')),
    file: new FileCredentialStore(home),
  };
}

function harness(home: string, extra: CliDependencies = {}) {
  const cwd = tempHome();
  const run = async (args: string[], deps: CliDependencies = {}) => {
    const captured = capture();
    const code = await runCli(['node', 'synomem', '--home', home, ...args], captured.io, {
      env: {},
      cwd,
      promptIo: piped(),
      credentialStores: fileStores,
      ...extra,
      ...deps,
    });
    return { code, stdout: captured.stdout.join(''), stderr: captured.stderr.join('') };
  };
  const ok = async (args: string[], deps: CliDependencies = {}) => {
    const result = await run(args, deps);
    expect(result.code, result.stderr).toBe(0);
    return result.stdout;
  };
  const okJson = async <T>(args: string[], deps: CliDependencies = {}) =>
    JSON.parse(await ok([...args, '--json'], deps)) as T;
  return { run, ok, okJson, cwd };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const contexts: ContextSummary[] = [
  {
    contextId: 'ctx_gracie_eng',
    organizationId: 'org_1',
    workspaceId: 'ws_eng',
    workspaceName: 'Engineering',
    actor: { kind: 'agent', id: 'agt_gracie', displayName: 'Gracie', handle: 'gracie' },
    actions: ['synomem:read', 'synomem:write'],
    source: 'target',
  },
  {
    contextId: 'ctx_gracie_personal',
    organizationId: 'org_1',
    workspaceId: 'ws_personal',
    workspaceName: 'Personal',
    actor: { kind: 'agent', id: 'agt_gracie', displayName: 'Gracie', handle: 'gracie' },
    actions: ['synomem:read', 'synomem:write'],
    source: 'rule',
  },
  {
    contextId: 'ctx_astra_eng',
    organizationId: 'org_1',
    workspaceId: 'ws_eng',
    workspaceName: 'Engineering',
    actor: { kind: 'agent', id: 'agt_astra', displayName: 'Astra', handle: 'astra' },
    actions: ['synomem:read'],
    source: 'target',
  },
];

/** A fake hosted API answering only the credential-level discovery routes. */
function fakeApi(expectedBearer: string) {
  const seen: string[] = [];
  const fetchImplementation = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(urlOf(input));
    const headers = new Headers(init?.headers);
    seen.push(`${url.pathname} ${headers.get('authorization')}`);
    if (headers.get('authorization') !== `Bearer ${expectedBearer}`) {
      return json({ ok: false, error: { code: 'AUTH_REQUIRED', message: 'bad token' } }, 401);
    }
    if (url.pathname === '/v1/identity') {
      return json({
        ok: true,
        data: {
          account: { id: 'acct_troy' },
          organizationId: 'org_1',
          connection: { id: 'con_1', label: 'Codex / Troy Mac', kind: 'access_key' },
          grant: {
            id: 'grt_1',
            version: 1,
            mode: 'explicit',
            actions: ['synomem:read', 'synomem:write'],
          },
          fixedContextId: null,
          effectiveContext: null,
        },
      });
    }
    if (url.pathname === '/v1/contexts') {
      return json({
        ok: true,
        data: { mode: 'explicit', fixedContextId: null, contexts, nextCursor: null },
      });
    }
    return json({ ok: false, error: { code: 'REMOTE_PROTOCOL', message: 'unexpected' } }, 404);
  }) as typeof fetch;
  return { fetch: fetchImplementation, seen };
}

describe('CLI: local setup and profiles', () => {
  it('sets up the first agent with a same-named default profile, idempotently', async () => {
    const home = tempHome();
    const { okJson, ok } = harness(home);
    const first = await okJson<{
      applied: boolean;
      profile: string;
      agentId: string;
      contextId: string;
      default: boolean;
    }>(['setup', '--backend', 'local', '--agent', 'gracie', '--name', 'Gracie']);
    expect(first).toMatchObject({ applied: true, profile: 'gracie', default: true });
    expect(first.contextId).toMatch(/^lctx_[0-9a-f]{32}$/);

    const again = await okJson<{ applied: boolean; agentId: string }>([
      'setup',
      '--backend',
      'local',
      '--agent',
      'gracie',
      '--name',
      'Gracie',
    ]);
    expect(again).toMatchObject({ applied: false, agentId: first.agentId });
    const agents = await okJson<{ agents: unknown[] }>(['agent', 'list']);
    expect(agents.agents).toHaveLength(1);
    expect(await ok(['whoami'])).toContain('Gracie');
  });

  it('resumes after a profile-write failure without creating a second agent', async () => {
    const home = tempHome();
    let failNext = true;
    const flaky = (profileHome: string) => {
      const store = new ProfileStore(profileHome);
      const write = store.write.bind(store);
      store.write = (config: ProfilesConfig) => {
        if (failNext) {
          failNext = false;
          throw new Error('disk full');
        }
        write(config);
      };
      return store;
    };
    const { run, okJson } = harness(home, { profileStore: flaky });
    const failed = await run(['setup', '--agent', 'gracie', '--name', 'Gracie']);
    expect(failed.code).not.toBe(0);
    const resumed = await okJson<{ resumed: boolean; profile: string }>([
      'setup',
      '--agent',
      'gracie',
      '--name',
      'Gracie',
    ]);
    expect(resumed).toMatchObject({ resumed: true, profile: 'gracie' });
    expect((await okJson<{ agents: unknown[] }>(['agent', 'list'])).agents).toHaveLength(1);
  });

  it('refuses to rebind an existing profile to something else', async () => {
    const home = tempHome();
    const { ok, run } = harness(home);
    await ok(['setup', '--agent', 'gracie', '--name', 'Gracie']);
    const clash = await run([
      'setup',
      '--agent',
      'astra',
      '--name',
      'Astra',
      '--profile-name',
      'gracie',
    ]);
    expect(clash.code).toBe(2);
    expect(clash.stderr).toContain('will not overwrite');
  });

  it('acts as the profile for every domain command — no per-command actor', async () => {
    const home = tempHome();
    const { ok, okJson } = harness(home);
    await ok(['setup', '--agent', 'gracie', '--name', 'Gracie']);
    // A second local agent, created independently, gets no profile or default…
    const codex = await okJson<{ id: string; profileCreated?: string }>([
      'agent',
      'create',
      'codex',
      '--name',
      'Codex',
    ]);
    expect(codex.profileCreated).toBeUndefined();
    // …until one is asked for explicitly.
    await ok(['profile', 'create', 'codex', '--local', '--agent', 'codex']);

    const note = await okJson<{ record: { event: { actor: { kind: string; id: string } } } }>([
      'note',
      'create',
      '--title',
      'Deploy',
      '--body',
      'rsync, then build',
    ]);
    expect(note.record.event.actor.kind).toBe('agent');

    const memo = await okJson<{ record: { event: { id: string; actor: { id: string } } } }>([
      'memo',
      'send',
      'codex',
      '--subject',
      'Review',
      '--body',
      'Please review.',
    ]);
    const inbox = await okJson<{ items: Array<{ id: string }> }>(['--profile', 'codex', 'inbox']);
    expect(inbox.items.map((item) => item.id)).toContain(memo.record.event.id);
    const read = await okJson<{ status: string }>([
      '--profile',
      'codex',
      'memo',
      'read',
      memo.record.event.id,
    ]);
    expect(read.status).toBe('read');

    const whoami = await okJson<{ effectiveContext: { actor: { id: string }; contextId: string } }>(
      ['--profile', 'codex', 'whoami'],
    );
    expect(whoami.effectiveContext.actor.id).toBe(codex.id);
  });

  it('creates a profile together with a local agent only when asked', async () => {
    const home = tempHome();
    const { okJson } = harness(home);
    const created = await okJson<{ profileCreated: string }>([
      'agent',
      'create',
      'mike',
      '--name',
      'Mike',
      '--create-profile',
    ]);
    expect(created.profileCreated).toBe('mike');
    const profiles = await okJson<{ profiles: Record<string, { backend: string }> }>([
      'profile',
      'list',
    ]);
    expect(profiles.profiles.mike?.backend).toBe('local');
  });

  it('says how to get a profile when none is selected', async () => {
    const home = tempHome();
    const { run } = harness(home);
    const result = await run(['note', 'list']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('No profile selected');
    expect(result.stderr).toContain('--profile');
  });
});

describe('CLI: obsolete identity overrides', () => {
  it.each([
    [['post', 'list', '--as', 'gracie']],
    [['--actor', 'gracie', 'note', 'list']],
    [['memo', 'send', 'codex', '--from', 'gracie', '--subject', 's', '--body', 'b']],
    [['mcp', '--agent-id', 'gracie']],
    [['kudos', 'give', 'codex', '--actor-kind', 'agent', '--title', 't', '--reason', 'r']],
  ])('rejects %j with a pointer to --profile', async (args) => {
    const home = tempHome();
    const { run } = harness(home);
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('no longer supported');
    expect(result.stderr).toContain('--profile');
  });

  it('rejects SYNOMEM_ACTOR_ID in the environment', async () => {
    const home = tempHome();
    const { run } = harness(home);
    const result = await run(['note', 'list'], { env: { SYNOMEM_ACTOR_ID: 'gracie' } });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('SYNOMEM_ACTOR_ID is no longer supported');
  });
});

describe('CLI: connections and hosted profiles', () => {
  it('adds an access key from stdin and creates a profile for a permitted context', async () => {
    const home = tempHome();
    const api = fakeApi('syn_key.secret');
    const { ok, okJson, run } = harness(home, { fetch: api.fetch });
    const added = await okJson<{ key: string; contexts: unknown[] }>(
      [
        'connection',
        'add-key',
        '--name',
        'codex-mac',
        '--store',
        'file',
        '--api-url',
        'https://api.synomem.example',
      ],
      { promptIo: piped('syn_key.secret\n') },
    );
    expect(added.key).not.toContain('secret');
    expect(added.contexts).toHaveLength(3);
    // The profiles file holds only a reference; the secret is in the store.
    const profilesFile = readFileSync(join(home, 'profiles.json'), 'utf8');
    expect(profilesFile).not.toContain('syn_key.secret');

    const ambiguous = await run([
      'profile',
      'create',
      'gracie',
      '--connection',
      'codex-mac',
      '--agent',
      'gracie',
    ]);
    expect(ambiguous.code).toBe(2);
    expect(ambiguous.stderr).toContain('ctx_gracie_personal');

    const created = await okJson<{ contextId: string; workspaceName: string }>([
      'profile',
      'create',
      'gracie-eng',
      '--connection',
      'codex-mac',
      '--agent',
      'gracie',
      '--workspace',
      'engineering',
    ]);
    expect(created).toMatchObject({ contextId: 'ctx_gracie_eng', workspaceName: 'Engineering' });

    const refused = await run([
      'profile',
      'create',
      'mike',
      '--connection',
      'codex-mac',
      '--agent',
      'mike',
    ]);
    expect(refused.code).toBe(4);
    expect(refused.stderr).toContain('never create agents');

    const listed = await okJson<{ connections: Array<{ name: string; profiles: string[] }> }>([
      'connection',
      'list',
    ]);
    expect(listed.connections).toEqual([
      expect.objectContaining({ name: 'codex-mac', profiles: ['gracie-eng'] }),
    ]);
    expect(await ok(['connection', 'status'])).toContain('codex-mac  ok');

    const blocked = await run(['connection', 'remove', '--name', 'codex-mac']);
    expect(blocked.code).toBe(2);
    expect(blocked.stderr).toContain('gracie-eng');
    await ok(['connection', 'remove', '--name', 'codex-mac', '--force']);
    const after = new ProfileStore(home).read();
    expect(after.credentials).toEqual({});
    expect(after.profiles).toEqual({});
  });

  it('stores a browser sign-in once, reused by every profile on the connection', async () => {
    const home = tempHome();
    const api = fakeApi('oauth-access');
    let logins = 0;
    const { okJson } = harness(home, {
      fetch: api.fetch,
      oauthLogin: async (options) => {
        logins += 1;
        expect(options.apiUrl).toBe('https://api.synomem.example');
        expect(options.clientId).toBeUndefined();
        return {
          kind: 'oauth',
          issuer: 'https://auth.synomem.example',
          resource: 'https://api.synomem.example',
          clientId: 'synomem-cli',
          tokenEndpoint: 'https://auth.synomem.example/api/auth/oauth2/token',
          scope: 'openid synomem:read synomem:write',
          accessToken: 'oauth-access',
          refreshToken: 'oauth-refresh',
          expiresAt: Date.now() + 600_000,
          generation: 0,
        };
      },
    });
    await okJson([
      'connection',
      'login',
      '--name',
      'codex-mac',
      '--store',
      'file',
      '--api-url',
      'https://api.synomem.example',
    ]);
    await okJson([
      'profile',
      'create',
      'gracie',
      '--connection',
      'codex-mac',
      '--context',
      'ctx_gracie_eng',
    ]);
    await okJson([
      'profile',
      'create',
      'astra',
      '--connection',
      'codex-mac',
      '--context',
      'ctx_astra_eng',
    ]);
    const config = new ProfileStore(home).read();
    expect(logins).toBe(1);
    expect(Object.keys(config.credentials)).toEqual(['codex-mac']);
    const secretRef = config.credentials['codex-mac']!.secretRef!;
    expect(existsSync(join(home, 'credentials', `${secretRef}.json`))).toBe(true);
  });

  it('routes a remote profile through a pinned remote resolver', async () => {
    const home = tempHome();
    const api = fakeApi('syn_key.secret');
    const pinned: Array<string | undefined> = [];
    const { ok } = harness(home, {
      fetch: api.fetch,
      createRemoteResolver: (options) => {
        pinned.push(options.pinnedContextId);
        return {
          mode: () => 'fixed',
          resolve: async () => ({
            service: {} as never,
            context: {
              contextId: options.pinnedContextId!,
              organizationId: 'org_1',
              workspaceId: 'ws_eng',
              actor: { kind: 'agent', id: 'agt_gracie', displayName: 'Gracie' },
            },
          }),
          list: async () => ({
            mode: 'fixed',
            fixedContextId: options.pinnedContextId!,
            contexts: [],
          }),
        } satisfies ContextResolver;
      },
    });
    await ok(
      [
        'connection',
        'add-key',
        '--name',
        'codex-mac',
        '--store',
        'file',
        '--api-url',
        'https://api.synomem.example',
      ],
      {
        promptIo: piped('syn_key.secret'),
      },
    );
    await ok([
      'profile',
      'create',
      'gracie',
      '--connection',
      'codex-mac',
      '--context',
      'ctx_gracie_eng',
    ]);
    expect(await ok(['--profile', 'gracie', 'whoami'])).toContain(
      'Gracie (agent:agt_gracie) in ws_eng',
    );
    expect(pinned).toEqual(['ctx_gracie_eng']);
  });
});

describe('CLI: MCP launch', () => {
  it('starts a fixed server for a profile and an explicit one for a preset', async () => {
    const home = tempHome();
    const started: ContextResolver[] = [];
    const startMcpServer = async (options: { resolver: ContextResolver }) => {
      started.push(options.resolver);
    };
    const { ok, run } = harness(home, { startMcpServer });
    await ok(['setup', '--agent', 'gracie', '--name', 'Gracie']);
    await ok(['agent', 'create', 'codex', '--name', 'Codex', '--create-profile']);
    await ok(['preset', 'create', 'both', 'gracie', 'codex']);

    await ok(['mcp', '--profile', 'gracie']);
    expect(started[0]?.mode()).toBe('fixed');

    const refused = await run(['mcp', '--preset', 'both']);
    expect(refused.code).toBe(2);
    expect(refused.stderr).toContain('--contexts explicit');

    await ok(['mcp', '--preset', 'both', '--contexts', 'explicit']);
    const preset = started[1]!;
    expect(preset.mode()).toBe('explicit');
    await expect(preset.resolve()).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' });
    const listing = await preset.list();
    expect(listing.contexts).toHaveLength(2);
    const [first, second] = listing.contexts;
    expect((await preset.resolve(first!.contextId)).context.actor.id).toBe(first!.actor.id);
    expect((await preset.resolve(second!.contextId)).context.actor.id).toBe(second!.actor.id);
    await preset.close?.();
    await started[0]?.close?.();
  });
});

describe('CLI: stores, skills and reset', () => {
  it('creates and lists local stores', async () => {
    const home = tempHome();
    const { okJson } = harness(home);
    await okJson(['workspace', 'create', 'lumina']);
    const listed = await okJson<{ workspaces: Array<{ name: string; initialized: boolean }> }>([
      'workspace',
      'list',
    ]);
    expect(listed.workspaces.map((workspace) => workspace.name)).toContain('lumina');
  });

  it('prints MCP registration for a named profile', async () => {
    const home = tempHome();
    const { ok } = harness(home);
    await ok(['setup', '--agent', 'gracie', '--name', 'Gracie']);
    const status = await ok(['--profile', 'gracie', 'skill', 'status', '--runtime', 'codex']);
    expect(status).toContain("synomem 'mcp' '--profile' 'gracie'");
  });

  it('plans a reset that names profiles.json and stored secrets, and applies it', async () => {
    const home = tempHome();
    const api = fakeApi('syn_key.secret');
    const { ok, okJson } = harness(home, { fetch: api.fetch });
    await ok(['setup', '--agent', 'gracie', '--name', 'Gracie']);
    await ok(
      [
        'connection',
        'add-key',
        '--name',
        'ci',
        '--store',
        'file',
        '--api-url',
        'https://api.synomem.example',
      ],
      {
        promptIo: piped('syn_key.secret'),
      },
    );
    const plan = await okJson<{ targets: string[] }>(['reset']);
    expect(plan.targets).toContain(join(home, 'profiles.json'));
    expect(plan.targets.some((path) => path.startsWith(join(home, 'credentials')))).toBe(true);
    await ok(['reset', '--yes']);
    expect(existsSync(join(home, 'profiles.json'))).toBe(false);
  });

  it('requires a hosted profile to import', async () => {
    const home = tempHome();
    const { ok, run } = harness(home);
    await ok(['setup', '--agent', 'gracie', '--name', 'Gracie']);
    const result = await run(['remote', 'import', '--from-home', home, '--preview']);
    expect(result.code).toBe(2);
    expect(result.stderr).toContain('hosted profile');
  });
});
