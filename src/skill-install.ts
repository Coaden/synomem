import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SynomemError } from './errors.js';
import { actorSchema } from './schemas.js';
import { packageVersion } from './version.js';

export const skillRuntimeNames = [
  'codex',
  'claude',
  'hermes',
  'openclaw',
  'cursor',
  'grok',
] as const;
export type SkillRuntime = (typeof skillRuntimeNames)[number];
export type SkillState = 'current' | 'stale' | 'missing' | 'unavailable' | 'conflict';

export interface SkillLocation {
  runtime: SkillRuntime;
  runtimeHome: string;
  target: string;
  state: SkillState;
  installedVersion?: string;
  mode?: 'copy' | 'link';
}

export interface SkillOperationResult {
  changed: boolean;
  dryRun: boolean;
  packageVersion: string;
  locations: SkillLocation[];
  mcpCommands: string[];
}

interface Stamp {
  package: 'synomem';
  version: string;
  runtime: SkillRuntime;
  mode: 'copy';
}

export interface SkillOptions {
  runtimes?: SkillRuntime[];
  apply?: boolean;
  force?: boolean;
  link?: boolean;
  /**
   * The agent this installation binds to.
   *
   * Only the canonical ID is written into the generated registration command.
   * The display name and kind are read from the agent's profile at startup, so
   * a harness cannot sign another agent's name to work it did.
   */
  agentId?: string;
  userHome?: string;
  env?: NodeJS.ProcessEnv;
  source?: string;
}

const stampName = '.synomem-install.json';

function runtimeHomes(userHome: string, env: NodeJS.ProcessEnv): Record<SkillRuntime, string> {
  return {
    codex: resolve(env.CODEX_HOME || join(userHome, '.codex')),
    claude: resolve(env.CLAUDE_CONFIG_DIR || join(userHome, '.claude')),
    hermes: resolve(env.HERMES_HOME || join(userHome, '.hermes')),
    openclaw: resolve(env.OPENCLAW_STATE_DIR || join(userHome, '.openclaw')),
    cursor: resolve(join(userHome, '.cursor')),
    grok: resolve(env.GROK_HOME || join(userHome, '.grok')),
  };
}

function selectedRuntimes(options: SkillOptions): SkillRuntime[] {
  const defaults: SkillRuntime[] = [...skillRuntimeNames];
  return [...new Set(options.runtimes?.length ? options.runtimes : defaults)];
}

function sourcePath(options: SkillOptions): string {
  return resolve(options.source ?? fileURLToPath(new URL('../skills/synomem', import.meta.url)));
}

function assertSource(source: string): void {
  if (!existsSync(join(source, 'SKILL.md'))) {
    throw new SynomemError('INTERNAL_ERROR', 'The packaged Synomem skill is missing.');
  }
}

function readStamp(target: string): Stamp | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(target, stampName), 'utf8')) as Partial<Stamp>;
    if (
      parsed.package === 'synomem' &&
      typeof parsed.version === 'string' &&
      skillRuntimeNames.some((runtime) => runtime === parsed.runtime) &&
      parsed.mode === 'copy'
    ) {
      return parsed as Stamp;
    }
  } catch {
    // Missing or invalid stamps are treated as unowned conflicts.
  }
  return undefined;
}

function entryExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function linkIsOurs(target: string, source: string): boolean {
  if (!entryExists(target) || !lstatSync(target).isSymbolicLink()) return false;
  return resolve(dirname(target), readlinkSync(target)) === source;
}

function inspect(runtime: SkillRuntime, runtimeHome: string, source: string): SkillLocation {
  const target = join(runtimeHome, 'skills', 'synomem');
  if (!existsSync(runtimeHome)) return { runtime, runtimeHome, target, state: 'unavailable' };
  const skillsHome = dirname(target);
  if (
    lstatSync(runtimeHome).isSymbolicLink() ||
    !lstatSync(runtimeHome).isDirectory() ||
    (entryExists(skillsHome) &&
      (lstatSync(skillsHome).isSymbolicLink() || !lstatSync(skillsHome).isDirectory()))
  ) {
    return { runtime, runtimeHome, target, state: 'conflict' };
  }
  if (!entryExists(target)) return { runtime, runtimeHome, target, state: 'missing' };
  if (linkIsOurs(target, source)) {
    return { runtime, runtimeHome, target, state: 'current', mode: 'link' };
  }
  if (lstatSync(target).isSymbolicLink() || !lstatSync(target).isDirectory()) {
    return { runtime, runtimeHome, target, state: 'conflict' };
  }
  const stamp = readStamp(target);
  if (!stamp || stamp.runtime !== runtime)
    return { runtime, runtimeHome, target, state: 'conflict' };
  return {
    runtime,
    runtimeHome,
    target,
    state: stamp.version === packageVersion() ? 'current' : 'stale',
    installedVersion: stamp.version,
    mode: 'copy',
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function mcpCommand(runtime: SkillRuntime, agentId?: string): string | undefined {
  if (!agentId) return undefined;
  const identity = actorSchema.parse({ kind: 'agent', id: agentId });
  const args = ['--agent-id', identity.id];
  if (runtime === 'codex') {
    return `codex mcp add synomem -- synomem-mcp ${args.map(shellQuote).join(' ')}`;
  }
  if (runtime === 'claude') {
    return `claude mcp add --scope user synomem -- synomem-mcp ${args.map(shellQuote).join(' ')}`;
  }
  if (runtime === 'hermes') {
    return `hermes mcp add synomem --command synomem-mcp --args ${args.map(shellQuote).join(' ')}`;
  }
  if (runtime === 'openclaw') {
    return `openclaw mcp add synomem --command synomem-mcp ${args.map((item) => `--arg=${shellQuote(item)}`).join(' ')}`;
  }
  if (runtime === 'grok') {
    return `grok mcp add synomem -- synomem-mcp ${args.map(shellQuote).join(' ')}`;
  }
  return undefined;
}

function assertSafeTarget(runtimeHome: string, target: string): void {
  if (target !== join(runtimeHome, 'skills', 'synomem')) {
    throw new SynomemError('UNSAFE_PATH', 'Refusing an unexpected skill destination.');
  }
  const skillsHome = dirname(target);
  if (
    !existsSync(runtimeHome) ||
    lstatSync(runtimeHome).isSymbolicLink() ||
    !lstatSync(runtimeHome).isDirectory() ||
    (entryExists(skillsHome) &&
      (lstatSync(skillsHome).isSymbolicLink() || !lstatSync(skillsHome).isDirectory()))
  ) {
    throw new SynomemError('UNSAFE_PATH', `Refusing an unsafe runtime skill path: ${runtimeHome}`);
  }
}

function replaceTarget(
  location: SkillLocation,
  source: string,
  runtime: SkillRuntime,
  link: boolean,
): void {
  const parent = dirname(location.target);
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const temporary = join(parent, `.synomem-${process.pid}-${Date.now()}.tmp`);
  const backup = join(parent, `.synomem-${process.pid}-${Date.now()}.bak`);
  try {
    if (link) {
      symlinkSync(source, temporary, process.platform === 'win32' ? 'junction' : 'dir');
    } else {
      cpSync(source, temporary, { recursive: true, errorOnExist: true });
      const stamp: Stamp = {
        package: 'synomem',
        version: packageVersion(),
        runtime,
        mode: 'copy',
      };
      writeFileSync(join(temporary, stampName), `${JSON.stringify(stamp, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      });
    }
    if (entryExists(location.target)) renameSync(location.target, backup);
    renameSync(temporary, location.target);
    if (existsSync(backup)) rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    if (!entryExists(location.target) && entryExists(backup)) renameSync(backup, location.target);
    throw error;
  } finally {
    if (entryExists(temporary)) rmSync(temporary, { recursive: true, force: true });
  }
}

export function skillStatus(options: SkillOptions = {}): SkillOperationResult {
  const userHome = resolve(options.userHome ?? homedir());
  const source = sourcePath(options);
  assertSource(source);
  const homes = runtimeHomes(userHome, options.env ?? process.env);
  const locations = selectedRuntimes(options).map((runtime) =>
    inspect(runtime, homes[runtime], source),
  );
  return {
    changed: false,
    dryRun: true,
    packageVersion: packageVersion(),
    locations,
    mcpCommands: locations
      .map((location) => mcpCommand(location.runtime, options.agentId))
      .filter((value): value is string => Boolean(value)),
  };
}

export function installSkill(options: SkillOptions = {}): SkillOperationResult {
  const result = skillStatus(options);
  const source = sourcePath(options);
  const desiredMode = options.link ? 'link' : 'copy';
  for (const location of result.locations) {
    if (
      location.state === 'unavailable' ||
      (location.state === 'current' && location.mode === desiredMode)
    ) {
      continue;
    }
    if (location.state === 'conflict' && options.apply && !options.force) {
      throw new SynomemError(
        'INVALID_INPUT',
        `${location.target} already exists and is not owned by Synomem; use --force to replace it.`,
      );
    }
    if (options.apply) {
      assertSafeTarget(location.runtimeHome, location.target);
      replaceTarget(location, source, location.runtime, Boolean(options.link));
      result.changed = true;
    }
  }
  result.dryRun = !options.apply;
  if (!options.apply) return result;
  const updated = skillStatus({ ...options, apply: false });
  return { ...updated, changed: result.changed, dryRun: false };
}

export function uninstallSkill(options: SkillOptions = {}): SkillOperationResult {
  const result = skillStatus(options);
  for (const location of result.locations) {
    if (location.state === 'missing' || location.state === 'unavailable') continue;
    if (location.state === 'conflict' && options.apply && !options.force) {
      throw new SynomemError(
        'INVALID_INPUT',
        `${location.target} is not owned by Synomem; refusing to remove it without --force.`,
      );
    }
    if (options.apply) {
      assertSafeTarget(location.runtimeHome, location.target);
      rmSync(location.target, { recursive: true, force: false });
      result.changed = true;
    }
  }
  result.dryRun = !options.apply;
  if (!options.apply) return result;
  const updated = skillStatus({ ...options, apply: false });
  return { ...updated, changed: result.changed, dryRun: false };
}

export function formatSkillResult(
  result: SkillOperationResult,
  operation: 'status' | 'install' | 'uninstall',
): string {
  const lines = result.locations.map((location) => {
    const version = location.installedVersion ? ` (version ${location.installedVersion})` : '';
    return `${location.runtime.padEnd(6)} ${location.state.padEnd(11)} ${location.target}${version}`;
  });
  if (operation !== 'status' && result.dryRun)
    lines.push('', 'Dry run only. Re-run with --yes to apply.');
  if (result.mcpCommands.length) lines.push('', 'MCP registration:', ...result.mcpCommands);
  else if (operation === 'install') {
    lines.push('', 'Tip: add --agent <agent-id> to print MCP registration commands.');
  }
  return lines.join('\n');
}
