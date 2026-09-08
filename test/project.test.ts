import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findProjectSelection,
  PROJECT_CONFIG_FILE,
  PROJECT_DIRECTORY,
  resolveWorkspaceSelection,
  writeProjectSelection,
} from '../src/project.js';
import { tempHome } from './helpers.js';

function project(config: unknown): string {
  const directory = join(tempHome(), 'repo');
  mkdirSync(join(directory, PROJECT_DIRECTORY), { recursive: true });
  writeFileSync(join(directory, PROJECT_DIRECTORY, PROJECT_CONFIG_FILE), JSON.stringify(config));
  return directory;
}

/**
 * Opening an agent in a repository should be enough: everything it writes goes
 * to that repository's workspace, with nobody naming the workspace again.
 */
describe('project workspace binding', () => {
  it('finds the binding in the directory itself', () => {
    const directory = project({ workspace: 'lumina', actor: 'claude' });
    expect(findProjectSelection(directory)).toMatchObject({
      workspace: 'lumina',
      actor: 'claude',
      directory,
    });
  });

  it('walks up, so a nested directory in the repository still finds it', () => {
    const directory = project({ workspace: 'lumina' });
    const nested = join(directory, 'src', 'deep', 'nested');
    mkdirSync(nested, { recursive: true });
    expect(findProjectSelection(nested)?.workspace).toBe('lumina');
  });

  it('never reads the Synomem home as a project file', () => {
    // `<home>/config.json` is a home's own configuration with a different
    // shape. Treating it as a project pointer would apply a home's settings to
    // every command run anywhere beneath the home directory.
    const home = tempHome();
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ schemaVersion: 3 }));
    const inside = join(home, 'workspaces', 'lumina');
    mkdirSync(inside, { recursive: true });
    expect(findProjectSelection(inside, home)).toBeUndefined();
  });

  it('reports a malformed project file instead of ignoring it', () => {
    const directory = project({ workspace: 'Not A Valid Name' });
    // Silently falling back would write records to a different workspace than
    // the file names, which is the one outcome worth failing over.
    expect(() => findProjectSelection(directory)).toThrow(/not a valid Synomem project file/i);
  });

  it('prefers a flag over the project file, which somebody may have forgotten', () => {
    const directory = project({ workspace: 'lumina' });
    const selection = resolveWorkspaceSelection({
      flag: 'accounting',
      cwd: directory,
      explicitRoot: tempHome(),
      env: {},
    });
    expect(selection).toMatchObject({ workspace: 'accounting' });
    expect(selection.source).toContain('--workspace');
  });

  it('prefers the environment over the project file, and says which it used', () => {
    const directory = project({ workspace: 'lumina' });
    const selection = resolveWorkspaceSelection({
      cwd: directory,
      explicitRoot: tempHome(),
      env: { SYNOMEM_WORKSPACE: 'marketing' },
    });
    expect(selection).toMatchObject({ workspace: 'marketing', source: 'SYNOMEM_WORKSPACE' });
  });

  it('falls back to the default workspace, whose home is the root', () => {
    const root = tempHome();
    const selection = resolveWorkspaceSelection({ cwd: root, explicitRoot: root, env: {} });
    // No workspace key at all rather than an explicit undefined, so callers
    // that spread the result do not overwrite a value with nothing.
    expect(selection.home).toBe(root);
    expect(selection.workspace).toBeUndefined();
    expect(selection.source).toBe('the default workspace');
  });

  it('writes a pointer and nothing else, so no store lands in the repository', () => {
    const directory = join(tempHome(), 'repo');
    mkdirSync(directory, { recursive: true });
    const path = writeProjectSelection(directory, { workspace: 'lumina', actor: 'claude' });
    expect(path).toBe(join(directory, PROJECT_DIRECTORY, PROJECT_CONFIG_FILE));
    // A database inside a repository would end up in somebody's git history.
    expect(findProjectSelection(directory)).toMatchObject({ workspace: 'lumina' });
  });
});
