import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { SynomemError } from '../src/errors.js';
import { installSkill, skillStatus, uninstallSkill } from '../src/skill-install.js';
import { packageVersion } from '../src/version.js';
import { tempHome } from './helpers.js';

function fixture(): { userHome: string; source: string } {
  const root = tempHome();
  const userHome = join(root, 'user');
  const source = join(root, 'package', 'skills', 'synomem');
  mkdirSync(userHome, { recursive: true });
  mkdirSync(join(source, 'references'), { recursive: true });
  writeFileSync(join(source, 'SKILL.md'), '---\nname: synomem\n---\n');
  writeFileSync(join(source, 'references', 'examples.md'), '# Examples\n');
  return { userHome, source };
}

describe('skill installation', () => {
  it('detects runtimes without creating absent runtime homes during a dry run', () => {
    const { userHome, source } = fixture();
    mkdirSync(join(userHome, '.codex'));

    const result = installSkill({ userHome, source });

    expect(result.dryRun).toBe(true);
    expect(result.locations).toMatchObject([
      { runtime: 'codex', state: 'missing' },
      { runtime: 'claude', state: 'unavailable' },
      { runtime: 'hermes', state: 'unavailable' },
      { runtime: 'openclaw', state: 'unavailable' },
      { runtime: 'cursor', state: 'unavailable' },
      { runtime: 'grok', state: 'unavailable' },
    ]);
    expect(existsSync(join(userHome, '.codex', 'skills'))).toBe(false);
    expect(existsSync(join(userHome, '.claude'))).toBe(false);
  });

  it('installs owned copies, reports their versions, and removes only after confirmation', () => {
    const { userHome, source } = fixture();
    mkdirSync(join(userHome, '.codex'));
    mkdirSync(join(userHome, '.claude'));

    const installed = installSkill({
      userHome,
      source,
      runtimes: ['codex', 'claude'],
      apply: true,
    });
    expect(installed.changed).toBe(true);
    expect(installed.dryRun).toBe(false);
    expect(installed.locations.every((location) => location.state === 'current')).toBe(true);
    const target = join(userHome, '.codex', 'skills', 'synomem');
    expect(readFileSync(join(target, 'SKILL.md'), 'utf8')).toContain('synomem');
    expect(JSON.parse(readFileSync(join(target, '.synomem-install.json'), 'utf8'))).toMatchObject({
      package: 'synomem',
      version: packageVersion(),
      runtime: 'codex',
      mode: 'copy',
    });

    expect(uninstallSkill({ userHome, source, runtimes: ['codex', 'claude'] }).dryRun).toBe(true);
    expect(existsSync(target)).toBe(true);
    const removed = uninstallSkill({
      userHome,
      source,
      runtimes: ['codex', 'claude'],
      apply: true,
    });
    expect(removed.changed).toBe(true);
    expect(removed.locations.every((location) => location.state === 'missing')).toBe(true);
  });

  it.runIf(process.platform !== 'win32')('preserves packaged file modes in copied skills', () => {
    const { userHome, source } = fixture();
    const scripts = join(source, 'scripts');
    mkdirSync(scripts);
    const executable = join(scripts, 'helper.sh');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(join(source, 'SKILL.md'), 0o644);
    chmodSync(executable, 0o755);
    mkdirSync(join(userHome, '.codex'));

    installSkill({ userHome, source, runtimes: ['codex'], apply: true });

    const target = join(userHome, '.codex', 'skills', 'synomem');
    expect(lstatSync(join(target, 'SKILL.md')).mode & 0o777).toBe(0o644);
    expect(lstatSync(join(target, 'scripts', 'helper.sh')).mode & 0o777).toBe(0o755);
    expect(lstatSync(join(target, '.synomem-install.json')).mode & 0o777).toBe(0o600);
  });

  it('reports stale copies and updates them without requiring force', () => {
    const { userHome, source } = fixture();
    mkdirSync(join(userHome, '.codex'));
    installSkill({ userHome, source, runtimes: ['codex'], apply: true });
    const stamp = join(userHome, '.codex', 'skills', 'synomem', '.synomem-install.json');
    const value = JSON.parse(readFileSync(stamp, 'utf8')) as { version: string };
    value.version = '0.0.1';
    writeFileSync(stamp, `${JSON.stringify(value)}\n`);

    expect(skillStatus({ userHome, source, runtimes: ['codex'] }).locations[0]?.state).toBe(
      'stale',
    );
    expect(
      installSkill({ userHome, source, runtimes: ['codex'], apply: true }).locations[0]?.state,
    ).toBe('current');
  });

  it('refuses to overwrite unowned content unless force is explicit', () => {
    const { userHome, source } = fixture();
    const target = join(userHome, '.claude', 'skills', 'synomem');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'personal.txt'), 'keep me');

    expect(skillStatus({ userHome, source, runtimes: ['claude'] }).locations[0]?.state).toBe(
      'conflict',
    );
    expect(() =>
      installSkill({ userHome, source, runtimes: ['claude'], apply: true }),
    ).toThrowError(SynomemError);
    expect(readFileSync(join(target, 'personal.txt'), 'utf8')).toBe('keep me');

    installSkill({ userHome, source, runtimes: ['claude'], apply: true, force: true });
    expect(existsSync(join(target, 'personal.txt'))).toBe(false);
    expect(existsSync(join(target, 'SKILL.md'))).toBe(true);
  });

  it('refuses to traverse a symlinked runtime skills directory', () => {
    const { userHome, source } = fixture();
    const runtimeHome = join(userHome, '.codex');
    const outside = join(userHome, 'outside-skills');
    mkdirSync(runtimeHome);
    mkdirSync(outside);
    symlinkSync(
      outside,
      join(runtimeHome, 'skills'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    expect(skillStatus({ userHome, source, runtimes: ['codex'] }).locations[0]?.state).toBe(
      'conflict',
    );
    expect(() =>
      installSkill({ userHome, source, runtimes: ['codex'], apply: true, force: true }),
    ).toThrowError(/unsafe runtime skill path/i);
    expect(existsSync(join(outside, 'synomem'))).toBe(false);
  });

  it('supports explicit links and prints actor-bound MCP commands', () => {
    const { userHome, source } = fixture();
    mkdirSync(join(userHome, '.codex'));
    mkdirSync(join(userHome, '.claude'));

    const result = installSkill({
      userHome,
      source,
      apply: true,
      link: true,
      agentId: 'mycroft',
      runtimes: ['codex', 'claude'],
    });

    expect(lstatSync(join(userHome, '.codex', 'skills', 'synomem')).isSymbolicLink()).toBe(true);
    expect(result.locations.every((location) => location.mode === 'link')).toBe(true);
    expect(result.mcpCommands).toHaveLength(2);
    expect(result.mcpCommands[0]).toContain('codex mcp add synomem');
    expect(result.mcpCommands[1]).toContain('claude mcp add --scope user synomem');
    // Only the canonical ID is registered: the display name is read from the
    // agent's profile at startup, so a harness cannot sign another name.
    expect(result.mcpCommands[0]).toContain("'--agent-id' 'mycroft'");
    expect(result.mcpCommands[0]).not.toContain('--actor-name');

    uninstallSkill({ userHome, source, runtimes: ['codex', 'claude'], apply: true });
    expect(existsSync(join(userHome, '.codex', 'skills', 'synomem'))).toBe(false);
    rmSync(source, { recursive: true });
  });

  it('uses verified homes and registration commands for additional runtimes', () => {
    const { userHome, source } = fixture();
    const hermesHome = join(userHome, 'hermes-profile');
    const openclawHome = join(userHome, 'openclaw-state');
    const grokHome = join(userHome, 'grok-home');
    for (const runtimeHome of [hermesHome, openclawHome, join(userHome, '.cursor'), grokHome]) {
      mkdirSync(runtimeHome);
    }

    const result = installSkill({
      userHome,
      source,
      env: {
        HERMES_HOME: hermesHome,
        OPENCLAW_STATE_DIR: openclawHome,
        GROK_HOME: grokHome,
      },
      runtimes: ['hermes', 'openclaw', 'cursor', 'grok'],
      agentId: 'mycroft',
      apply: true,
    });

    expect(
      result.locations.map(({ runtime, target, state }) => ({ runtime, target, state })),
    ).toEqual([
      { runtime: 'hermes', target: join(hermesHome, 'skills', 'synomem'), state: 'current' },
      {
        runtime: 'openclaw',
        target: join(openclawHome, 'skills', 'synomem'),
        state: 'current',
      },
      {
        runtime: 'cursor',
        target: join(userHome, '.cursor', 'skills', 'synomem'),
        state: 'current',
      },
      { runtime: 'grok', target: join(grokHome, 'skills', 'synomem'), state: 'current' },
    ]);
    expect(result.mcpCommands).toHaveLength(3);
    expect(result.mcpCommands.join('\n')).toContain('hermes mcp add synomem');
    expect(result.mcpCommands.join('\n')).toContain('openclaw mcp add synomem');
    expect(result.mcpCommands.join('\n')).toContain('grok mcp add synomem');
    expect(result.mcpCommands.join('\n')).not.toContain('SYNOMEM_ACTOR_ID=');
    expect(result.mcpCommands.join('\n')).toContain("'--agent-id' 'mycroft'");
  });
});
