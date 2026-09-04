import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { z } from 'zod';
import { SynomemError } from './errors.js';
import type { SynomemConfig, SynomemConfigOverrides } from './types.js';

export const defaultConfig: SynomemConfig = {
  schemaVersion: 3,
  backend: { kind: 'local' },
  workspaceId: 'workspace',
  defaultVisibility: 'workspace',
  allowSelfAwards: false,
  allowCrossAgentTodos: true,
  allowAgentCreationViaMcp: false,
  allowRebuildViaMcp: false,
  includePrivateInStats: false,
  projection: {
    writeWinsMarkdown: true,
    writeMemoryMarkdown: true,
    writeTodosMarkdown: true,
    writeInboxEntries: true,
  },
};

const backendSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('local') }),
  z.object({
    kind: z.literal('remote'),
    baseUrl: z.url().refine(
      (value) => {
        try {
          const parsed = new URL(value);
          const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
          return (
            (parsed.protocol === 'https:' || (parsed.protocol === 'http:' && loopback)) &&
            !parsed.username &&
            !parsed.password &&
            !parsed.search &&
            !parsed.hash &&
            parsed.pathname === '/'
          );
        } catch {
          return false;
        }
      },
      { message: 'Remote baseUrl must be an HTTPS origin (loopback HTTP is allowed).' },
    ),
    workspaceId: z.string().trim().min(1).max(100),
  }),
]);

const policySchema = z.object({
  workspaceId: z.string().trim().min(1).max(100),
  defaultVisibility: z.enum(['private', 'workspace', 'public']),
  allowSelfAwards: z.boolean(),
  allowCrossAgentTodos: z.boolean(),
  allowAgentCreationViaMcp: z.boolean(),
  allowRebuildViaMcp: z.boolean(),
  includePrivateInStats: z.boolean(),
  projection: z.object({
    writeWinsMarkdown: z.boolean(),
    writeMemoryMarkdown: z.boolean(),
    writeTodosMarkdown: z.boolean(),
    writeInboxEntries: z.boolean(),
  }),
});

const legacyConfigSchema = policySchema.extend({ schemaVersion: z.literal(2) });

export const configSchema = policySchema.extend({
  schemaVersion: z.literal(3),
  backend: backendSchema,
});

export function resolveHome(explicitHome?: string): string {
  const candidate = explicitHome ?? process.env.SYNOMEM_HOME ?? resolve(homedir(), '.agents');
  if (candidate.includes('\0')) throw new SynomemError('UNSAFE_PATH', 'Storage home contains NUL.');
  return resolve(candidate);
}

export function mergeConfig(
  fileConfig: unknown,
  explicit?: SynomemConfigOverrides,
  env: NodeJS.ProcessEnv = process.env,
): SynomemConfig {
  const parsedFile = parseFileConfig(fileConfig);
  if (!parsedFile.success) {
    throw new SynomemError('CONFIG_INVALID', 'Synomem configuration file is invalid.', {
      issues: parsedFile.error.issues,
    });
  }
  const fromFile = parsedFile.data;
  const fromEnvironment = environmentConfig(env);
  const merged: SynomemConfig = {
    ...fromFile,
    ...fromEnvironment,
    ...explicit,
    projection: {
      ...fromFile.projection,
      ...fromEnvironment.projection,
      ...explicit?.projection,
    },
    schemaVersion: 3,
  };
  const result = configSchema.safeParse(merged);
  if (!result.success) {
    throw new SynomemError('CONFIG_INVALID', 'Synomem configuration is invalid.', {
      issues: result.error.issues,
    });
  }
  return result.data;
}

function parseFileConfig(fileConfig: unknown) {
  if (fileConfig === undefined) return { success: true as const, data: defaultConfig };
  const current = configSchema.safeParse(fileConfig);
  if (current.success) return current;
  const legacy = legacyConfigSchema.safeParse(fileConfig);
  if (legacy.success) {
    return {
      success: true as const,
      data: { ...legacy.data, schemaVersion: 3 as const, backend: { kind: 'local' as const } },
    };
  }
  return current;
}

function optionalBoolean(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
  const value = env[name];
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new SynomemError('CONFIG_INVALID', `${name} must be true or false.`);
}

function environmentConfig(env: NodeJS.ProcessEnv): SynomemConfigOverrides {
  const visibility = env.SYNOMEM_DEFAULT_VISIBILITY;
  if (visibility && !['private', 'workspace', 'public'].includes(visibility)) {
    throw new SynomemError(
      'CONFIG_INVALID',
      'SYNOMEM_DEFAULT_VISIBILITY must be private, workspace, or public.',
    );
  }

  const writeWinsMarkdown = optionalBoolean(env, 'SYNOMEM_WRITE_WINS_MARKDOWN');
  const writeMemoryMarkdown = optionalBoolean(env, 'SYNOMEM_WRITE_MEMORY_MARKDOWN');
  const writeTodosMarkdown = optionalBoolean(env, 'SYNOMEM_WRITE_TODOS_MARKDOWN');
  const writeInboxEntries = optionalBoolean(env, 'SYNOMEM_WRITE_INBOX_ENTRIES');
  const allowSelfAwards = optionalBoolean(env, 'SYNOMEM_ALLOW_SELF_AWARDS');
  const allowCrossAgentTodos = optionalBoolean(env, 'SYNOMEM_ALLOW_CROSS_AGENT_TODOS');
  const allowAgentCreationViaMcp = optionalBoolean(env, 'SYNOMEM_ALLOW_AGENT_CREATION_VIA_MCP');
  const allowRebuildViaMcp = optionalBoolean(env, 'SYNOMEM_ALLOW_REBUILD_VIA_MCP');
  const includePrivateInStats = optionalBoolean(env, 'SYNOMEM_INCLUDE_PRIVATE_IN_STATS');
  const projection = {
    ...(writeWinsMarkdown !== undefined ? { writeWinsMarkdown } : {}),
    ...(writeMemoryMarkdown !== undefined ? { writeMemoryMarkdown } : {}),
    ...(writeTodosMarkdown !== undefined ? { writeTodosMarkdown } : {}),
    ...(writeInboxEntries !== undefined ? { writeInboxEntries } : {}),
  };

  return {
    ...(visibility ? { defaultVisibility: visibility as SynomemConfig['defaultVisibility'] } : {}),
    ...(allowSelfAwards !== undefined ? { allowSelfAwards } : {}),
    ...(allowCrossAgentTodos !== undefined ? { allowCrossAgentTodos } : {}),
    ...(allowAgentCreationViaMcp !== undefined ? { allowAgentCreationViaMcp } : {}),
    ...(allowRebuildViaMcp !== undefined ? { allowRebuildViaMcp } : {}),
    ...(includePrivateInStats !== undefined ? { includePrivateInStats } : {}),
    ...(Object.keys(projection).length ? { projection } : {}),
  };
}
