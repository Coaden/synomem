/**
 * Local workspaces.
 *
 * On Synomem Cloud a workspace is a row, and isolation is enforced by the
 * database: every record table carries `workspace_id`, has row-level security
 * enabled, and every query runs with `synomem.workspace_id` set — so a query
 * that forgets to filter returns nothing rather than another workspace's rows.
 *
 * SQLite has no row-level security, so the same schema locally would not buy
 * the same guarantee: isolation would rest on every one of eighty query sites
 * staying correct, with nothing underneath to catch a miss, and a miss would
 * silently mix workspaces rather than fail. So a local workspace is a separate
 * DATABASE — its own home, its own file. The filesystem does the isolating, and
 * cross-workspace leakage stops being a thing anybody can write by accident.
 *
 * That is also why nothing downstream needs to know. A local workspace resolves
 * to a home and a hosted one resolves to an id, both at the single seam in
 * `backend.ts` that already chooses between the two backends. No domain code,
 * CLI command or MCP tool can tell which it got.
 */
import { existsSync, lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { SynomemError } from './errors.js';
import { resolveHome } from './config.js';

/**
 * The directory named workspaces live under, relative to the root.
 *
 * `workspaces` is a reserved agent handle for exactly this reason: projected
 * agent directories sit at `<home>/<handle>/`, so an agent allowed to call
 * itself `workspaces` would collide with this.
 */
export const WORKSPACES_DIRECTORY = 'workspaces';

/**
 * The workspace whose home is the root itself.
 *
 * The root stays a complete Synomem home rather than becoming a container, so
 * an existing install keeps its database exactly where it is and needs no
 * migration. Named workspaces are added alongside it.
 */
export const DEFAULT_WORKSPACE = 'default';

/** Same shape as an agent handle: a name somebody types, and a directory name. */
export const workspaceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'Use lowercase ASCII letters, digits, and hyphens')
  .refine((name) => name !== WORKSPACES_DIRECTORY, 'Reserved workspace name');

export interface LocalWorkspace {
  name: string;
  home: string;
  /** False until `init` or the first write has created the store. */
  initialized: boolean;
}

/**
 * Where a named local workspace lives.
 *
 * The name is validated rather than trusted: it becomes a directory, so a value
 * containing a separator or `..` would escape the root.
 */
export function localWorkspaceHome(name: string, explicitRoot?: string): string {
  const root = resolveHome(explicitRoot);
  if (name === DEFAULT_WORKSPACE) return root;
  const parsed = workspaceNameSchema.safeParse(name);
  if (!parsed.success) {
    throw new SynomemError(
      'INVALID_INPUT',
      `Invalid workspace name: ${name}. ${parsed.error.issues[0]?.message ?? ''}`.trim(),
    );
  }
  return join(root, WORKSPACES_DIRECTORY, parsed.data);
}

/**
 * The local workspaces on this machine, discovered from disk.
 *
 * Read from the filesystem rather than a registry file, so a workspace cannot
 * be listed and then turn out not to exist — and a directory copied in by hand
 * is found without having to be registered.
 */
export function listLocalWorkspaces(explicitRoot?: string): LocalWorkspace[] {
  const root = resolveHome(explicitRoot);
  const found: LocalWorkspace[] = [
    { name: DEFAULT_WORKSPACE, home: root, initialized: existsSync(join(root, 'config.json')) },
  ];

  const container = join(root, WORKSPACES_DIRECTORY);
  if (!existsSync(container)) return found;
  for (const entry of readdirSync(container, { withFileTypes: true })) {
    // A symbolic link here would point the store outside the root.
    if (!entry.isDirectory() || lstatSync(join(container, entry.name)).isSymbolicLink()) continue;
    if (!workspaceNameSchema.safeParse(entry.name).success) continue;
    const home = join(container, entry.name);
    found.push({
      name: entry.name,
      home,
      initialized: existsSync(join(home, 'config.json')),
    });
  }
  return found.sort((left, right) => left.name.localeCompare(right.name));
}
