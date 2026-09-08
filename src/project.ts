/**
 * Per-project workspace selection.
 *
 * The goal is that opening an agent in a repository is enough: every note,
 * memo, task, todo and post it writes lands in that repository's workspace,
 * with nobody naming the workspace again for the rest of the session.
 *
 * That cannot be a command typed into a running session. The stdio MCP server
 * is bound to a home and an actor when the harness launches it, so a later
 * instruction has nothing to retarget. It also should not be one global
 * "current workspace": two agents open in two repositories would fight over
 * it, which is exactly the case this exists to serve.
 *
 * So it is a file in the project, found by walking up from the working
 * directory — the same shape as `.git`, `.nvmrc` or `.npmrc`, and for the same
 * reason: the directory somebody is working in is the thing that knows which
 * project this is.
 *
 * `.synomem/config.json` holds a POINTER, never a store:
 *
 *     { "workspace": "lumina", "actor": "claude" }
 *
 * The database stays under the Synomem home. Putting one in the repository
 * would mean an append-only event log inside somebody's git history, committed
 * by accident the first time they ran `git add -A`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { resolveHome } from './config.js';
import { z } from 'zod';
import { SynomemError } from './errors.js';
import { localWorkspaceHome, workspaceNameSchema } from './workspaces.js';

export const PROJECT_DIRECTORY = '.synomem';
export const PROJECT_CONFIG_FILE = 'config.json';

export const projectConfigSchema = z.object({
  /** The local workspace this project's records belong in. */
  workspace: workspaceNameSchema.optional(),
  /** The agent this project's records are written by, when it is always one. */
  actor: z.string().trim().min(1).max(63).optional(),
});

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ProjectSelection extends ProjectConfig {
  /** The directory whose `.synomem` was used, so tools can say where it came from. */
  directory: string;
}

/**
 * The nearest project configuration at or above `from`.
 *
 * Walking up stops at the filesystem root, and never treats the Synomem home
 * itself as a project: `~/.synomem/config.json` is a real Synomem config with a
 * different shape, and reading it as a project pointer would silently apply a
 * home's settings to every command run anywhere under the home directory.
 */
export function findProjectSelection(
  from: string = process.cwd(),
  home?: string,
): ProjectSelection | undefined {
  const stopAt = parse(resolve(from)).root;
  let directory = resolve(from);
  for (;;) {
    const candidate = join(directory, PROJECT_DIRECTORY, PROJECT_CONFIG_FILE);
    // `<home>/config.json` is the home's own config, not a project pointer, and
    // the home is never a project directory.
    const isHome = home !== undefined && resolve(home) === join(directory, PROJECT_DIRECTORY);
    if (!isHome && existsSync(candidate)) {
      return { ...readProjectConfig(candidate), directory };
    }
    if (directory === stopAt) return undefined;
    const parent = dirname(directory);
    if (parent === directory) return undefined;
    directory = parent;
  }
}

function readProjectConfig(path: string): ProjectConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    throw new SynomemError('CONFIG_INVALID', `${path} is not readable JSON.`);
  }
  const parsed = projectConfigSchema.safeParse(raw);
  if (!parsed.success) {
    throw new SynomemError(
      'CONFIG_INVALID',
      `${path} is not a valid Synomem project file: ${parsed.error.issues[0]?.message ?? 'unknown problem'}`,
    );
  }
  return parsed.data;
}

/** Writes the pointer for a directory, creating `.synomem/` if needed. */
export function writeProjectSelection(directory: string, config: ProjectConfig): string {
  const parsed = projectConfigSchema.parse(config);
  const folder = join(resolve(directory), PROJECT_DIRECTORY);
  mkdirSync(folder, { recursive: true });
  const path = join(folder, PROJECT_CONFIG_FILE);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`);
  return path;
}

/**
 * Which workspace to act in, and as whom.
 *
 * One resolver, used by both the CLI and the stdio MCP server, so the two
 * cannot disagree about precedence. Order, most specific first:
 *
 *   1. `--workspace` / `--actor` — said on this invocation
 *   2. `SYNOMEM_WORKSPACE` / `SYNOMEM_ACTOR_ID` — set for this process
 *   3. `.synomem/config.json` in the project, found by walking up from the
 *      working directory
 *   4. the root home, which is the default workspace
 *
 * The project file is third rather than first because a flag someone typed
 * should always beat a file they may have forgotten is there.
 */
export function resolveWorkspaceSelection(input: {
  flag?: string;
  actorFlag?: string;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  explicitRoot?: string;
}): { home: string; workspace?: string; actor?: string; source: string } {
  const env = input.env ?? process.env;
  const root = resolveHome(input.explicitRoot);

  if (input.flag) {
    return {
      home: localWorkspaceHome(input.flag, input.explicitRoot),
      workspace: input.flag,
      ...(input.actorFlag ? { actor: input.actorFlag } : {}),
      source: 'the --workspace option',
    };
  }

  const fromEnv = env.SYNOMEM_WORKSPACE?.trim();
  if (fromEnv) {
    return {
      home: localWorkspaceHome(fromEnv, input.explicitRoot),
      workspace: fromEnv,
      ...((input.actorFlag ?? env.SYNOMEM_ACTOR_ID?.trim())
        ? { actor: input.actorFlag ?? env.SYNOMEM_ACTOR_ID?.trim() }
        : {}),
      source: 'SYNOMEM_WORKSPACE',
    };
  }

  const project = findProjectSelection(input.cwd ?? process.cwd(), root);
  if (project?.workspace) {
    return {
      home: localWorkspaceHome(project.workspace, input.explicitRoot),
      workspace: project.workspace,
      ...((input.actorFlag ?? project.actor) ? { actor: input.actorFlag ?? project.actor } : {}),
      source: join(project.directory, PROJECT_DIRECTORY, PROJECT_CONFIG_FILE),
    };
  }

  return {
    home: root,
    ...((input.actorFlag ?? project?.actor) ? { actor: input.actorFlag ?? project?.actor } : {}),
    source: 'the default workspace',
  };
}
