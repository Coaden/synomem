import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { defaultConfig } from '../src/config.js';
import {
  emptyProfilesConfig,
  presetResolver,
  ProfileStore,
  resolveSelection,
  type ProfilesConfig,
} from '../src/profiles.js';
import type { ContextResolver } from '../src/resolvers.js';
import type { ContextSummary, EffectiveContext } from '../src/types.js';
import { writeProjectSelection } from '../src/project.js';
import { tempHome } from './helpers.js';

const config = (): ProfilesConfig => ({
  ...emptyProfilesConfig(),
  credentials: {
    'codex-mac': {
      kind: 'oauth',
      apiUrl: 'https://api.synomem.example',
      store: 'file',
      secretRef: 'synomem-a',
      createdAt: '2026-09-23T00:00:00.000Z',
    },
    'hermes-mac': {
      kind: 'access-key',
      apiUrl: 'https://api.synomem.example',
      store: 'file',
      secretRef: 'synomem-b',
      createdAt: '2026-09-23T00:00:00.000Z',
    },
  },
  profiles: {
    gracie: { credentialRef: 'codex-mac', contextId: 'ctx_gracie' },
    astra: { credentialRef: 'codex-mac', contextId: 'ctx_astra' },
    mike: { credentialRef: 'hermes-mac', contextId: 'ctx_mike' },
  },
  harnessPresets: { codex: ['gracie', 'astra'], mixed: ['gracie', 'mike'] },
  defaultProfile: 'astra',
});

describe('profile selection precedence', () => {
  const cwd = tempHome();

  it('prefers the flag, then the environment, then the project file, then the default', () => {
    const project = tempHome();
    writeProjectSelection(project, { profile: 'mike' });
    const input = { cwd: project, env: { SYNOMEM_PROFILE: 'gracie' } };
    expect(resolveSelection(config(), { ...input, profile: 'astra' })).toMatchObject({
      name: 'astra',
      source: 'the command line',
    });
    expect(resolveSelection(config(), input)).toMatchObject({ name: 'gracie' });
    expect(resolveSelection(config(), { cwd: project, env: {} })).toMatchObject({ name: 'mike' });
    expect(resolveSelection(config(), { cwd, env: {} })).toMatchObject({
      name: 'astra',
      source: expect.stringContaining('defaultProfile') as string,
    });
    expect(resolveSelection(emptyProfilesConfig(), { cwd, env: {} })).toBeUndefined();
  });

  it('selects presets the same way', () => {
    expect(resolveSelection(config(), { cwd, env: { SYNOMEM_PRESET: 'codex' } })).toEqual({
      kind: 'preset',
      name: 'codex',
      source: 'SYNOMEM_PROFILE/SYNOMEM_PRESET',
    });
  });

  it('fails on an unknown name instead of falling through to the next source', () => {
    expect(() => resolveSelection(config(), { cwd, env: {}, profile: 'nobody' })).toThrowError(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('Known profiles: gracie, astra, mike') as string,
      }),
    );
    expect(() =>
      resolveSelection(config(), { cwd, env: { SYNOMEM_PROFILE: 'nobody' } }),
    ).toThrowError(expect.objectContaining({ code: 'CONFIG_INVALID' }));
    expect(() =>
      resolveSelection(config(), { cwd, env: {}, profile: 'gracie', preset: 'codex' }),
    ).toThrowError(expect.objectContaining({ code: 'INVALID_INPUT' }));
  });
});

describe('profiles file', () => {
  it('round-trips and never contains a secret, only references', () => {
    const home = tempHome();
    const store = new ProfileStore(home);
    store.write(config());
    expect(store.read()).toEqual(config());
  });

  it('refuses a malformed or old-shape file with an actionable message', () => {
    const home = tempHome();
    writeFileSync(join(home, 'profiles.json'), JSON.stringify({ backend: { kind: 'remote' } }));
    expect(() => new ProfileStore(home).read()).toThrowError(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('synomem setup') as string,
      }),
    );
  });

  it('refuses an old remote-backend home rather than migrating it', () => {
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'config.json'),
      JSON.stringify({
        ...defaultConfig,
        backend: { kind: 'remote', baseUrl: 'https://api.synomem.example', workspaceId: 'w' },
      }),
    );
    expect(() => new ProfileStore(home).read()).toThrowError(
      expect.objectContaining({
        code: 'CONFIG_INVALID',
        message: expect.stringContaining('connection login') as string,
      }),
    );
  });
});

describe('preset composite resolver', () => {
  function fakeRemote(options: {
    credential: unknown;
    allowedContextIds?: string[];
  }): ContextResolver & { name: string } {
    const name = (options.credential as { options: { name: string } }).options.name;
    const contexts: ContextSummary[] = (options.allowedContextIds ?? []).map((contextId) => ({
      contextId,
      organizationId: 'org',
      workspaceId: 'ws',
      actor: { kind: 'agent', id: contextId.replace('ctx_', '') },
      actions: ['synomem:read'],
      source: 'target',
    }));
    return {
      name,
      mode: () => 'explicit',
      async resolve(contextId?: string) {
        const context: EffectiveContext = {
          contextId: contextId!,
          organizationId: 'org',
          workspaceId: 'ws',
          actor: { kind: 'agent', id: `${name}:${contextId}` },
        };
        return { service: {} as never, context };
      },
      async list() {
        return {
          mode: 'explicit',
          fixedContextId: null,
          contexts: [...contexts, { ...contexts[0]!, contextId: 'ctx_not_in_preset' }],
        };
      },
    };
  }

  it('routes each context to its connection and requires a context on every call', async () => {
    const home = tempHome();
    const created: string[][] = [];
    const resolver = presetResolver(home, config(), 'mixed', {
      stores: {} as never,
      createRemoteResolver: (options) => {
        created.push(options.allowedContextIds ?? []);
        return fakeRemote(options);
      },
    });
    expect(created).toEqual([['ctx_gracie'], ['ctx_mike']]);
    expect(resolver.mode()).toBe('explicit');
    await expect(resolver.resolve()).rejects.toMatchObject({ code: 'CONTEXT_REQUIRED' });
    await expect(resolver.resolve('ctx_astra')).rejects.toMatchObject({
      code: 'CONTEXT_FORBIDDEN',
    });
    expect((await resolver.resolve('ctx_gracie')).context.actor.id).toBe('codex-mac:ctx_gracie');
    expect((await resolver.resolve('ctx_mike')).context.actor.id).toBe('hermes-mac:ctx_mike');
    const listing = await resolver.list();
    expect(listing.contexts.map((context) => context.contextId).sort()).toEqual([
      'ctx_gracie',
      'ctx_mike',
    ]);
  });

  it('shares one remote resolver across profiles on the same connection', () => {
    const home = tempHome();
    const created: string[][] = [];
    presetResolver(home, config(), 'codex', {
      stores: {} as never,
      createRemoteResolver: (options) => {
        created.push(options.allowedContextIds ?? []);
        return fakeRemote(options);
      },
    });
    expect(created).toEqual([['ctx_gracie', 'ctx_astra']]);
  });
});
