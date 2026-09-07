import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  createConfiguredService,
  SynomemClient,
  RemoteSynomemService,
  defaultConfig,
  readSynomemConfig,
  writeSynomemBackend,
} from '../src/index.js';
import { mergeConfig } from '../src/config.js';
import { tempHome, testClient } from './helpers.js';

afterEach(() => vi.unstubAllEnvs());

describe('configuration and cancellation', () => {
  it('applies explicit options over environment, file values, and defaults', () => {
    vi.stubEnv('SYNOMEM_DEFAULT_VISIBILITY', 'private');
    vi.stubEnv('SYNOMEM_ALLOW_SELF_AWARDS', 'true');
    const config = mergeConfig(
      { ...defaultConfig, defaultVisibility: 'public', allowSelfAwards: false },
      { defaultVisibility: 'workspace' },
    );
    expect(config.defaultVisibility).toBe('workspace');
    expect(config.allowSelfAwards).toBe(true);
  });

  it('rejects malformed environment policy values', () => {
    vi.stubEnv('SYNOMEM_ALLOW_SELF_AWARDS', '{"yes":true}');
    expect(() => mergeConfig(undefined)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('returns stable typed errors for invalid public API input', async () => {
    const client = await testClient(tempHome());
    await expect(
      client.agents.create({ handle: '../codex', displayName: 'Codex' }),
    ).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    });
    await client.close();
  });

  it('honors an AbortSignal before filesystem work', async () => {
    const controller = new AbortController();
    controller.abort(new Error('Cancelled by test'));
    const client = new SynomemClient({ home: tempHome(), signal: controller.signal });
    await expect(client.init()).rejects.toThrow('Cancelled by test');
  });

  it('generates and permanently persists a local workspace ULID', async () => {
    const home = tempHome();
    const first = await testClient(home);
    const workspaceId = first.storage.config.workspaceId;
    expect(workspaceId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    await first.close();
    const stored = JSON.parse(readFileSync(join(home, 'config.json'), 'utf8')) as {
      workspaceId: string;
    };
    expect(stored.workspaceId).toBe(workspaceId);
    const second = await testClient(home);
    expect(second.storage.config.workspaceId).toBe(workspaceId);
    await second.close();
  });

  it('normalizes schema version 2 configuration to a local schema version 3 backend', () => {
    const legacy = { ...defaultConfig, schemaVersion: 2 } as Record<string, unknown>;
    delete legacy.backend;
    expect(mergeConfig(legacy, undefined, {})).toMatchObject({
      schemaVersion: 3,
      backend: { kind: 'local' },
    });
  });

  it('persists a schema version 2 configuration migration after local initialization', async () => {
    const home = tempHome();
    // The home is the storage directory now, and tempHome already made it.
    const storageDirectory = home;
    const legacy = { ...defaultConfig, schemaVersion: 2 } as Record<string, unknown>;
    delete legacy.backend;
    writeFileSync(join(storageDirectory, 'config.json'), `${JSON.stringify(legacy)}\n`);

    const client = await testClient(home);
    await client.close();

    const stored = JSON.parse(
      readFileSync(join(storageDirectory, 'config.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(stored).toMatchObject({ schemaVersion: 3, backend: { kind: 'local' } });
  });

  it('rejects malformed remote backend configuration', () => {
    expect(() =>
      mergeConfig(
        {
          ...defaultConfig,
          backend: { kind: 'remote', baseUrl: 'not a URL', workspaceId: '' },
        },
        undefined,
        {},
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });

  it('does not create a SQLite database when the local client sees a remote backend', async () => {
    const home = tempHome();
    const client = new SynomemClient({
      home,
      config: {
        backend: {
          kind: 'remote',
          baseUrl: 'https://synomem.example',
          workspaceId: 'workspace-1',
        },
      },
    });

    await expect(client.init()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(existsSync(join(home, 'synomem.sqlite3'))).toBe(false);
  });

  it('persists backend selection without storing credentials', () => {
    const home = tempHome();
    const config = writeSynomemBackend(
      {
        kind: 'remote',
        baseUrl: 'https://api.synomem.example',
        workspaceId: 'workspace-1',
      },
      home,
    );
    expect(config.backend.kind).toBe('remote');
    const serialized = readFileSync(join(home, 'config.json'), 'utf8');
    expect(serialized).not.toContain('token');
    expect(readSynomemConfig(home, {})).toMatchObject({ backend: config.backend });
  });

  it('selects the remote service without creating local canonical state', () => {
    const home = tempHome();
    writeSynomemBackend(
      {
        kind: 'remote',
        baseUrl: 'https://api.synomem.example',
        workspaceId: 'workspace-1',
      },
      home,
    );
    const service = createConfiguredService(
      { home, actor: { kind: 'agent', id: 'gracie' } },
      { SYNOMEM_ACCESS_TOKEN: 'test-only-token' },
    );
    expect(service).toBeInstanceOf(RemoteSynomemService);
    expect(existsSync(join(home, 'synomem.sqlite3'))).toBe(false);
  });

  it('rejects non-loopback plaintext remote origins before persisting them', () => {
    const home = tempHome();
    expect(() =>
      writeSynomemBackend(
        { kind: 'remote', baseUrl: 'http://api.synomem.example', workspaceId: 'workspace-1' },
        home,
      ),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
  });
});
