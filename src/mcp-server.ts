#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createConfiguredService } from './backend.js';
import { resolveWorkspaceSelection } from './project.js';
import { SynomemError } from './errors.js';
import { actorSchema } from './schemas.js';
import { startMcpServer } from './mcp/index.js';
import type { ActorIdentity } from './types.js';
import { packageVersion } from './version.js';

const version = packageVersion();

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    workspace: { type: 'string' },
    'agent-id': { type: 'string' },
    'actor-id': { type: 'string' },
    'actor-kind': { type: 'string' },
    'actor-name': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

/**
 * Loads an agent's identity from canonical state rather than from arguments.
 *
 * A display name passed on the command line is a claim the runtime makes about
 * itself, and it is written into every event the session appends. Reading the
 * profile instead means a misconfigured runtime cannot sign another agent's
 * name to work, and renaming an agent takes effect without re-registering it
 * with every harness.
 */
async function resolveAgentActor(agentId: string, home?: string): Promise<ActorIdentity> {
  const lookup = createConfiguredService({
    actor: { kind: 'system', id: 'synomem-mcp' },
    ...(home ? { home } : {}),
  });
  await lookup.init();
  try {
    const resolution = await lookup.agents.resolve(agentId);
    if (!resolution.match) {
      throw new SynomemError(
        'AGENT_NOT_FOUND',
        resolution.candidates.length
          ? `"${agentId}" matches ${resolution.candidates.length} agents: ${resolution.candidates
              .map((candidate) => candidate.id)
              .join(', ')}. Register the MCP server with a canonical agent ID.`
          : `Unknown agent: ${agentId}. Create it with \`synomem agent create\` first.`,
      );
    }
    return {
      kind: 'agent',
      id: resolution.match.id,
      ...(resolution.match.displayName ? { displayName: resolution.match.displayName } : {}),
    };
  } finally {
    await lookup.close();
  }
}

if (values.help) {
  process.stdout.write(
    `synomem-mcp ${version}

Actor-bound Synomem MCP server (stdio transport)

Options:
  --home <path>          Storage root
  --workspace <name>     Local workspace to act in. Defaults to the workspace
                         named by .synomem/config.json in the working directory
                         or any directory above it, then to SYNOMEM_WORKSPACE,
                         then to the default workspace.
  --agent-id <id>        Bound agent, whose identity is read from Synomem
                         (or SYNOMEM_AGENT_ID)
  --actor-id <id>        Bound non-agent actor ID (or SYNOMEM_ACTOR_ID)
  --actor-kind <kind>    human or system (or SYNOMEM_ACTOR_KIND)
  --actor-name <name>    Display name for a non-agent actor
                         (or SYNOMEM_ACTOR_NAME)
  -h, --help             Show help
  -v, --version          Show version

Prefer --agent-id for an agent runtime: the display name and kind then come
from the agent's profile instead of from whatever the harness was told to pass.
`,
  );
} else if (values.version) {
  process.stdout.write(`${version}\n`);
} else {
  /*
   * The workspace is resolved from where the server was STARTED, which is what
   * makes a project binding work at all.
   *
   * A harness launches this process in the repository it opened, so a
   * `.synomem/config.json` there selects the workspace for the whole session
   * without the harness knowing anything about workspaces, and without anybody
   * repeating a flag. `--home` still wins, because it names a home outright
   * rather than a workspace inside one.
   */
  const selection = values.home
    ? undefined
    : resolveWorkspaceSelection({
        ...(values.workspace ? { flag: values.workspace } : {}),
        env: process.env,
      });
  const home = values.home ?? selection?.home;

  const agentId =
    values['agent-id'] ?? process.env.SYNOMEM_AGENT_ID ?? selection?.actor ?? undefined;
  const actor = agentId
    ? await resolveAgentActor(agentId, home)
    : actorSchema.parse({
        id: values['actor-id'] ?? process.env.SYNOMEM_ACTOR_ID,
        kind: values['actor-kind'] ?? process.env.SYNOMEM_ACTOR_KIND,
        displayName: values['actor-name'] ?? process.env.SYNOMEM_ACTOR_NAME,
      });

  await startMcpServer({
    actor,
    ...(home ? { home } : {}),
  });
}
