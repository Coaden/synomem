import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  findProjectSelection,
  PROJECT_CONFIG_FILE,
  PROJECT_DIRECTORY,
  writeProjectSelection,
} from '../src/project.js';
import { tempHome } from './helpers.js';

describe('project profile selection', () => {
  it('finds the nearest project file walking up from a nested directory', () => {
    const root = tempHome();
    const path = writeProjectSelection(root, { profile: 'gracie' });
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    expect(findProjectSelection(nested)).toEqual({ profile: 'gracie', path });
  });

  it('refuses a project file that tries to carry identity or credentials', () => {
    const root = tempHome();
    mkdirSync(join(root, PROJECT_DIRECTORY));
    for (const content of [
      { workspace: 'lumina', actor: 'claude' },
      { profile: 'gracie', apiUrl: 'https://evil.example' },
      { profile: 'gracie', contextId: 'ctx_x' },
    ]) {
      writeFileSync(join(root, PROJECT_DIRECTORY, PROJECT_CONFIG_FILE), JSON.stringify(content));
      expect(() => findProjectSelection(root)).toThrowError(
        expect.objectContaining({ code: 'CONFIG_INVALID' }),
      );
    }
  });

  it('refuses naming both a profile and a preset', () => {
    const root = tempHome();
    mkdirSync(join(root, PROJECT_DIRECTORY));
    writeFileSync(
      join(root, PROJECT_DIRECTORY, PROJECT_CONFIG_FILE),
      JSON.stringify({ profile: 'a', preset: 'b' }),
    );
    expect(() => findProjectSelection(root)).toThrowError(
      expect.objectContaining({ code: 'CONFIG_INVALID' }),
    );
  });

  it('never treats the Synomem home itself as a project directory', () => {
    const root = tempHome();
    const home = join(root, PROJECT_DIRECTORY);
    mkdirSync(home);
    // The home's own config.json is a store config, not a project pointer.
    writeFileSync(join(home, PROJECT_CONFIG_FILE), JSON.stringify({ schemaVersion: 3 }));
    expect(findProjectSelection(root, home)).toBeUndefined();
  });
});
