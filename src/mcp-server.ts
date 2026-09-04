#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { actorSchema } from './schemas.js';
import { startMcpServer } from './mcp/index.js';
import { packageVersion } from './version.js';

const version = packageVersion();

const { values } = parseArgs({
  options: {
    home: { type: 'string' },
    'actor-id': { type: 'string' },
    'actor-kind': { type: 'string' },
    'actor-name': { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
  },
});

if (values.help) {
  process.stdout.write(`synomem-mcp ${version}

Actor-bound Synomem MCP server (stdio transport)

Options:
  --home <path>          Storage root
  --actor-id <id>        Bound actor ID (or SYNOMEM_ACTOR_ID)
  --actor-kind <kind>    human, agent, or system (or SYNOMEM_ACTOR_KIND)
  --actor-name <name>    Optional display name (or SYNOMEM_ACTOR_NAME)
  -h, --help             Show help
  -v, --version          Show version
`);
} else if (values.version) {
  process.stdout.write(`${version}\n`);
} else {
  const actor = actorSchema.parse({
    id: values['actor-id'] ?? process.env.SYNOMEM_ACTOR_ID,
    kind: values['actor-kind'] ?? process.env.SYNOMEM_ACTOR_KIND,
    displayName: values['actor-name'] ?? process.env.SYNOMEM_ACTOR_NAME,
  });

  await startMcpServer({
    actor,
    ...(values.home ? { home: values.home } : {}),
  });
}
