#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createConfiguredService } from './backend.js';
import { SynomemError } from './errors.js';
import { actorSchema } from './schemas.js';
import { startMcpServer } from './mcp/index.js';
import type { ActorIdentity } from './types.js';
import { packageVersion } from './version.js';

const version = packageVersion();

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
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
  process.stdout.write(`synomem-mcp ${version}

Actor-bound Synomem MCP server (stdio transport)

Options:
  --home <path>          Storage root
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
`);
} else if (values.version) {
  process.stdout.write(`${version}\n`);
} else {
  const agentId = values['agent-id'] ?? process.env.SYNOMEM_AGENT_ID;
  const actor = agentId
    ? await resolveAgentActor(agentId, values.home)
    : actorSchema.parse({
        id: values['actor-id'] ?? process.env.SYNOMEM_ACTOR_ID,
        kind: values['actor-kind'] ?? process.env.SYNOMEM_ACTOR_KIND,
        displayName: values['actor-name'] ?? process.env.SYNOMEM_ACTOR_NAME,
      });

  await startMcpServer({
    actor,
    ...(values.home ? { home: values.home } : {}),
  });
}
