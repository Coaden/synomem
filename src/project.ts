/**
 * Per-project profile selection.
 *
 * Opening an agent in a repository should be enough to act as the right
 * identity: a `.synomem/project.json` found by walking up from the working
 * directory may name a profile (or an MCP preset) from the user's own
 * `profiles.json`.
 *
 * It may name ONLY that. A cloned repository is untrusted input, so the file
 * cannot carry a credential, an API origin, a context id, or an actor — it can
 * point at a profile the user already created, and nothing else. An unknown
 * key is refused rather than ignored, so an old `{ "workspace", "actor" }`
 * pointer fails loudly instead of silently doing nothing.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';
import { z } from 'zod';
import { SynomemError } from './errors.js';

export const PROJECT_DIRECTORY = '.synomem';
/*
 * `project.json`, never `config.json`: a Synomem home (a local store) keeps its
 * own policy in `.synomem/config.json`, and the walk up from a project directory
 * passes through the user's home — so a shared name would read the store's
 * config as a project pointer and break every command run beneath it.
 */
export const PROJECT_CONFIG_FILE = 'project.json';

const nameSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9][a-z0-9._-]{0,62}$/i, 'must be a profile or preset name');

export const projectConfigSchema = z
  .object({
    profile: nameSchema.optional(),
    preset: nameSchema.optional(),
  })
  .strict()
  .refine((value) => !(value.profile && value.preset), {
    message: 'name a profile or a preset, not both',
  });

export type ProjectConfig = z.infer<typeof projectConfigSchema>;

export interface ProjectSelection extends ProjectConfig {
  /** The file that supplied the selection, so errors can say where it came from. */
  path: string;
}

/**
 * The nearest project file at or above `from`. The Synomem home itself is
 * never treated as a project directory.
 */
export function findProjectSelection(
  from: string = process.cwd(),
  home?: string,
): ProjectSelection | undefined {
  const stopAt = parse(resolve(from)).root;
  let directory = resolve(from);
  for (;;) {
    const folder = join(directory, PROJECT_DIRECTORY);
    const candidate = join(folder, PROJECT_CONFIG_FILE);
    const isHome = home !== undefined && resolve(home) === folder;
    if (!isHome && existsSync(candidate)) {
      return { ...readProjectConfig(candidate), path: candidate };
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
      `${path} is not a valid Synomem project file (it may name only a "profile" or a "preset"): ${
        parsed.error.issues[0]?.message ?? 'unknown problem'
      }`,
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
