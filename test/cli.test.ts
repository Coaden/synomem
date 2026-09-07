import { describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { SynomemClient } from '../src/client.js';
import { runCli, type CliIo } from '../src/cli.js';
import type { SynomemServiceFactory } from '../src/service.js';
import { tempHome } from './helpers.js';
import type { CredentialStore, StoredOAuthCredential } from '../src/credentials.js';
import type { OAuthLoginOptions } from '../src/oauth.js';
import { createLocalImportBundle } from '../src/import.js';

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    io: { stdout: (text) => stdout.push(text), stderr: (text) => stderr.push(text) },
    stdout,
    stderr,
  };
}

describe('CLI', () => {
  it('creates its domain service through the injected factory', async () => {
    const home = tempHome();
    const actors: string[] = [];
    const factory: SynomemServiceFactory = (options) => {
      actors.push(`${options.actor?.kind}:${options.actor?.id}`);
      return new SynomemClient(options);
    };
    const captured = capture();

    expect(await runCli(['node', 'synomem', '--home', home, 'init'], captured.io, factory)).toBe(0);
    expect(actors).toEqual(['system:cli']);
  });

  it('provides useful help', async () => {
    const captured = capture();
    expect(await runCli(['node', 'synomem', '--help'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('Local-first communication');
    expect(captured.stdout.join('')).toContain('memo');
    expect(captured.stdout.join('')).toContain('skill');
  });

  it('selects and reports a remote backend without creating SQLite', async () => {
    const home = tempHome();
    let captured = capture();
    expect(
      await runCli(
        [
          'node',
          'synomem',
          '--home',
          home,
          'backend',
          'use',
          'remote',
          '--url',
          'https://api.synomem.example',
          '--workspace',
          'workspace-1',
        ],
        captured.io,
      ),
    ).toBe(0);
    expect(captured.stdout.join('')).toContain('Selected remote');

    captured = capture();
    expect(
      await runCli(['node', 'synomem', '--home', home, 'backend', 'show', '--json'], captured.io),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
      backend: { kind: 'remote', workspaceId: 'workspace-1' },
      initialized: true,
    });
    expect(existsSync(join(home, 'synomem', 'synomem.sqlite3'))).toBe(false);

    captured = capture();
    expect(await runCli(['node', 'synomem', '--home', home, 'init'], captured.io)).toBe(2);
    expect(captured.stderr.join('')).toContain('requires a local backend');
    expect(existsSync(join(home, 'synomem', 'synomem.sqlite3'))).toBe(false);
  });

  it('previews an explicit remote import as a bound human administrator', async () => {
    const sourceHome = tempHome();
    const source = new SynomemClient({ home: sourceHome });
    await source.init();
    await source.agents.create({ handle: 'codex', displayName: 'Codex' });
    await source.close();
    const targetHome = tempHome();
    let captured = capture();
    expect(
      await runCli(
        [
          'node',
          'synomem',
          '--home',
          targetHome,
          'backend',
          'use',
          'remote',
          '--url',
          'https://api.synomem.example',
          '--workspace',
          'target',
        ],
        captured.io,
      ),
    ).toBe(0);
    const remoteImport = vi.fn(async (input: { bundle: { checksum: string } }) => ({
      planId: 'signed-plan',
      expiresAt: '2026-09-02T22:00:00.000Z',
      sourceWorkspaceId: 'source',
      targetWorkspaceId: 'target',
      checksum: input.bundle.checksum,
      events: 1,
      profiles: 1,
      bytes: 100,
    }));
    captured = capture();
    expect(
      await runCli(
        [
          'node',
          'synomem',
          '--home',
          targetHome,
          'remote',
          'import',
          '--from-home',
          sourceHome,
          '--actor-id',
          'troy',
          '--preview',
        ],
        captured.io,
        undefined,
        { createImportBundle: createLocalImportBundle, remoteImport },
      ),
    ).toBe(0);
    expect(captured.stdout.join('')).toContain('Nothing was imported');
    expect(remoteImport).toHaveBeenCalledWith(
      expect.objectContaining({ actor: { kind: 'human', id: 'troy' }, workspaceId: 'target' }),
    );
  });

  it('reports environment authentication without exposing the token', async () => {
    const previous = process.env.SYNOMEM_ACCESS_TOKEN;
    process.env.SYNOMEM_ACCESS_TOKEN = 'do-not-print-this';
    try {
      const captured = capture();
      expect(await runCli(['node', 'synomem', 'auth', 'status', '--json'], captured.io)).toBe(0);
      expect(captured.stdout.join('')).not.toContain('do-not-print-this');
      expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
        authenticated: true,
        source: 'environment',
      });
    } finally {
      if (previous === undefined) delete process.env.SYNOMEM_ACCESS_TOKEN;
      else process.env.SYNOMEM_ACCESS_TOKEN = previous;
    }
  });

  it('logs in, reports, and removes an OS-stored actor credential without printing it', async () => {
    const home = tempHome();
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
    const oauthLogin = vi.fn(async (options: OAuthLoginOptions) => {
      await options.credentialStore.set(options.credentialReference, {
        accessToken: 'stored-secret-token',
        tokenEndpoint: 'https://identity.example.test/token',
        clientId: options.clientId,
        resource: 'https://api.example.test/mcp',
        scope: 'synomem:read synomem:write',
      });
    });
    const dependencies = {
      credentialStore: store,
      oauthLogin,
      env: {},
      verifyRemoteCredential: vi.fn(async () => undefined),
    };
    let captured = capture();
    expect(
      await runCli(
        [
          'node',
          'synomem',
          '--home',
          home,
          'backend',
          'use',
          'remote',
          '--url',
          'https://api.example.test',
          '--workspace',
          'workspace-a',
        ],
        captured.io,
        undefined,
        dependencies,
      ),
    ).toBe(0);
    captured = capture();
    expect(
      await runCli(
        [
          'node',
          'synomem',
          '--home',
          home,
          'auth',
          'login',
          '--actor-id',
          'codex',
          '--client-id',
          'public-client',
          '--json',
        ],
        captured.io,
        undefined,
        dependencies,
      ),
    ).toBe(0);
    expect(captured.stdout.join('')).not.toContain('stored-secret-token');
    expect(oauthLogin).toHaveBeenCalledOnce();
    captured = capture();
    expect(
      await runCli(
        ['node', 'synomem', '--home', home, 'auth', 'status', '--actor-id', 'codex', '--json'],
        captured.io,
        undefined,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
      authenticated: true,
      source: 'os-credential-store',
    });
    captured = capture();
    expect(
      await runCli(
        ['node', 'synomem', '--home', home, 'auth', 'logout', '--actor-id', 'codex', '--json'],
        captured.io,
        undefined,
        dependencies,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
      authenticated: false,
      removed: true,
    });
  });

  it('rejects unsupported skill runtimes', async () => {
    const captured = capture();
    expect(
      await runCli(
        ['node', 'synomem', 'skill', 'install', '--runtime', 'unverified-runtime'],
        captured.io,
      ),
    ).toBe(2);
    expect(captured.stderr.join('')).toContain('Unsupported skill runtime');
  });

  it('accepts grokbot as the local Grok runtime alias', async () => {
    const captured = capture();
    expect(
      await runCli(
        ['node', 'synomem', 'skill', 'status', '--runtime', 'grokbot', '--json'],
        captured.io,
      ),
    ).toBe(0);
    const result = JSON.parse(captured.stdout.join('')) as {
      locations: Array<{ runtime: string }>;
    };
    expect(result.locations).toMatchObject([{ runtime: 'grok' }]);
  });

  it('emits human and JSON output and stable exit codes', async () => {
    const home = tempHome();
    let captured = capture();
    expect(await runCli(['node', 'synomem', '--home', home, 'init'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('Initialized Synomem');

    captured = capture();
    expect(
      await runCli(
        [
          'node',
          'synomem',
          '--home',
          home,
          'agent',
          'create',
          'codex',
          '--name',
          'Codex',
          '--json',
        ],
        captured.io,
      ),
    ).toBe(0);
    expect(JSON.parse(captured.stdout.join(''))).toMatchObject({
      handle: 'codex',
      displayName: 'Codex',
    });

    captured = capture();
    expect(
      await runCli(
        [
          'node',
          'synomem',
          '--home',
          home,
          'kudos',
          'give',
          'missing',
          '--from',
          'troy',
          '--actor-kind',
          'human',
          '--title',
          'No recipient',
          '--reason',
          'This identity does not exist.',
          '--json',
        ],
        captured.io,
      ),
    ).toBe(3);
    expect(JSON.parse(captured.stderr.join(''))).toMatchObject({
      error: { code: 'AGENT_NOT_FOUND' },
    });
  });

  it('does not leak a prior process exit code into a successful invocation', async () => {
    const prior = process.exitCode;
    process.exitCode = 5;
    try {
      const captured = capture();
      expect(await runCli(['node', 'synomem', '--help'], captured.io)).toBe(0);
    } finally {
      process.exitCode = prior;
    }
  });

  it('keeps doctor failure status local to that invocation', async () => {
    const home = tempHome();
    const client = new SynomemClient({ home, actor: { kind: 'human', id: 'troy' } });
    await client.init();
    await client.agents.create({ handle: 'codex', displayName: 'Codex' });
    client.storage
      .db()
      .prepare(
        `INSERT INTO events(id, schema_version, type, created_at, actor_kind, actor_id, payload, sequence)
         VALUES (?, 1, 'future', ?, 'system', 'future', ?,
           (SELECT COALESCE(MAX(sequence), 0) + 1 FROM events))`,
      )
      .run(
        '01ARZ3NDEKTSV4RRFFQ69G5FAB',
        new Date().toISOString(),
        JSON.stringify({ schemaVersion: 1, type: 'future' }),
      );
    await client.close();

    let captured = capture();
    expect(await runCli(['node', 'synomem', '--home', home, 'doctor'], captured.io)).toBe(5);
    captured = capture();
    expect(await runCli(['node', 'synomem', '--home', home, 'agent', 'list'], captured.io)).toBe(0);
    expect(captured.stdout.join('')).toContain('codex');
  });

  it('returns a useful error when WINS.md generation is disabled', async () => {
    const home = tempHome();
    const client = new SynomemClient({
      home,
      actor: { kind: 'human', id: 'troy' },
      config: { projection: { writeWinsMarkdown: false } },
    });
    await client.init();
    await client.agents.create({ handle: 'codex', displayName: 'Codex' });
    await client.close();

    const captured = capture();
    expect(
      await runCli(
        ['node', 'synomem', '--home', home, 'kudos', 'wins', 'codex', '--print'],
        captured.io,
      ),
    ).toBe(2);
    expect(captured.stderr.join('')).toContain('Enable projection.writeWinsMarkdown');
    expect(captured.stderr.join('')).not.toContain(`${home}/codex/WINS.md`);
  });

  it('exercises the complete local administration and recognition workflow', async () => {
    const home = tempHome();
    const invoke = async (args: string[]) => {
      const captured = capture();
      const code = await runCli(['node', 'synomem', '--home', home, ...args], captured.io);
      expect(code, captured.stderr.join('')).toBe(0);
      return captured.stdout.join('');
    };

    await invoke(['init']);
    await invoke(['agent', 'create', 'codex', '--name', 'Codex', '--alias', 'reviewer']);
    await invoke(['agent', 'create', 'gracie', '--name', 'Gracie']);
    expect(await invoke(['agent', 'list'])).toContain('codex');
    expect(await invoke(['agent', 'show', 'reviewer'])).toContain('Codex');
    await invoke(['agent', 'update', 'codex', '--description', 'Careful reviewer']);

    const given = JSON.parse(
      await invoke([
        'kudos',
        'give',
        'codex',
        '--from',
        'gracie',
        '--actor-kind',
        'agent',
        '--title',
        'Complete review',
        '--reason',
        'Found and explained a release-blocking problem.',
        '--tag',
        'review',
        '--evidence',
        'task:review-1',
        '--idempotency-key',
        'cli-flow-1',
        '--json',
      ]),
    ) as { record: { event: { id: string } } };
    const id = given.record.event.id;
    expect(await invoke(['inbox', 'codex'])).toContain(id);
    expect(await invoke(['list', '--tag', 'review'])).toContain(id);
    const compact = JSON.parse(await invoke(['list', '--tag', 'review', '--json'])) as {
      items: Array<Record<string, unknown>>;
      limit: number;
    };
    expect(compact.limit).toBe(10);
    expect(compact.items[0]).not.toHaveProperty('reason');
    expect(await invoke(['changes'])).toContain('kudos.given');
    expect(await invoke(['kudos', 'show', id])).toContain('Complete review');
    expect(await invoke(['kudos', 'wins', 'codex', '--print'])).toContain(id);
    await invoke(['kudos', 'acknowledge', id, '--as', 'codex', '--note', 'Reviewed.']);
    expect(await invoke(['kudos', 'stats'])).toContain('Acknowledged: 1');
    await invoke([
      'kudos',
      'revoke',
      id,
      '--as',
      'gracie',
      '--actor-kind',
      'agent',
      '--reason',
      'Corrected.',
    ]);
    await invoke(['rebuild']);
    expect(await invoke(['doctor'])).toContain('EVENTS_VALID');

    const output = join(tempHome(), 'events.jsonl');
    await invoke(['export', '--format', 'jsonl', '--output', output]);
    const backup = join(tempHome(), 'backup.sqlite3');
    await invoke(['backup', backup]);
  });

  it('exercises memo, note, task, and unified list commands', async () => {
    const home = tempHome();
    const invoke = async (args: string[]) => {
      const captured = capture();
      const code = await runCli(['node', 'synomem', '--home', home, ...args], captured.io);
      expect(code, captured.stderr.join('')).toBe(0);
      return captured.stdout.join('');
    };
    await invoke(['init']);
    await invoke(['agent', 'create', 'codex', '--name', 'Codex']);
    await invoke(['agent', 'create', 'gracie', '--name', 'Gracie']);
    expect(
      await invoke([
        'memo',
        'send',
        'codex',
        '--from',
        'gracie',
        '--subject',
        'Review',
        '--body',
        'Please review the migration.',
      ]),
    ).toContain('Sent memo');
    const note = JSON.parse(
      await invoke([
        'note',
        'create',
        '--as',
        'gracie',
        '--title',
        'Invariant',
        '--body',
        'Events remain append-only.',
        '--json',
      ]),
    ) as { record: { event: { id: string } } };
    expect(await invoke(['note', 'show', note.record.event.id])).toContain(
      'Events remain append-only',
    );
    const task = JSON.parse(
      await invoke([
        'task',
        'create',
        'codex',
        '--from',
        'gracie',
        '--title',
        'Review migration',
        '--due-date',
        '2026-09-15',
        '--json',
      ]),
    ) as {
      record: { event: { id: string } };
    };
    expect(await invoke(['task', 'accept', task.record.event.id, '--as', 'codex'])).toContain(
      'is open',
    );
    expect(await invoke(['task', 'show', task.record.event.id])).toContain('Review migration');
    const list = await invoke(['list']);
    expect(list).toContain('memo');
    expect(list).toContain('note');
    expect(list).toContain('task');
  });
});
