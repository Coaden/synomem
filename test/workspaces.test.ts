import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKSPACE,
  listLocalWorkspaces,
  localWorkspaceHome,
  WORKSPACES_DIRECTORY,
} from '../src/workspaces.js';
import { agentHandleSchema } from '../src/schemas.js';
import { tempHome } from './helpers.js';

/**
 * A local workspace is a separate DATABASE, not a column.
 *
 * SQLite has no row-level security, so the hosted schema would not carry the
 * hosted guarantee: isolation would rest on every query remembering to filter,
 * with nothing underneath to catch a miss, and a miss would silently mix
 * workspaces rather than fail. Separate homes make the filesystem do it.
 */
describe('local workspace resolution', () => {
  it('keeps the root as the default workspace, so an existing store never moves', () => {
    const root = tempHome();
    expect(localWorkspaceHome(DEFAULT_WORKSPACE, root)).toBe(root);
  });

  it('puts a named workspace in its own home beneath the root', () => {
    const root = tempHome();
    expect(localWorkspaceHome('lumina', root)).toBe(join(root, WORKSPACES_DIRECTORY, 'lumina'));
  });

  it.each([
    ['../escape', 'a parent traversal'],
    ['..', 'a bare parent'],
    ['/etc', 'an absolute path'],
    ['a/b', 'a separator'],
    ['Lumina', 'upper case, which two filesystems disagree about'],
    ['', 'nothing at all'],
  ])('refuses %s (%s)', (name) => {
    // The name becomes a directory, so anything that could leave the root has
    // to be rejected rather than normalised.
    expect(() => localWorkspaceHome(name, tempHome())).toThrow();
  });

  it('refuses the name the workspaces directory itself uses', () => {
    expect(() => localWorkspaceHome(WORKSPACES_DIRECTORY, tempHome())).toThrow();
  });

  it('reserves that name as an agent handle too, since both become directories', () => {
    // Projected agent directories sit at `<home>/<handle>`, so an agent called
    // `workspaces` would collide with the container beside it.
    expect(agentHandleSchema.safeParse(WORKSPACES_DIRECTORY).success).toBe(false);
  });

  it('lists the default even before anything is initialized, and says so', () => {
    const root = tempHome();
    const [only] = listLocalWorkspaces(root);
    expect(only).toMatchObject({ name: DEFAULT_WORKSPACE, home: root, initialized: false });
    expect(existsSync(join(root, 'config.json'))).toBe(false);
  });
});
