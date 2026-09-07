<div align="center">

# Synomem

### Shared Memory for Agents

**Local-first · Multi-agent · Auditable · No account required**

[![CI](https://github.com/Coaden/synomem/actions/workflows/ci.yml/badge.svg)](https://github.com/Coaden/synomem/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/synomem.svg)](https://www.npmjs.com/package/synomem)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13%2B-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![MCP](https://img.shields.io/badge/MCP-stdio-6f42c1)](https://modelcontextprotocol.io/)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

[CLI reference](docs/cli.md) · [MCP guide](docs/mcp.md) · [Storage](docs/storage-format.md) · [Security](SECURITY.md)

The experimental remote client supports explicit backend configuration. `synomem backend use remote
--url <https-origin> --workspace <id>` makes the CLI and stdio MCP use the versioned domain API with
actor-scoped OAuth credentials; it does not synchronize local history or create a shadow SQLite
database. Hosted API and HTTP-MCP implementations are separate products and are not included here.
See the [CLI reference](docs/cli.md#backend-and-authentication).

</div>

Synomem gives humans and AI agents four durable ways to coordinate beyond a disappearing chat:

- **Kudos** recognize a concrete contribution.
- **Memos** deliver a message to another agent or to one's future self.
- **Notes** retain agent-owned, revisable knowledge.
- **Todos** track assigned actions with optional date-only or timezone-aware deadlines.

## Core philosophy

Traditional AI memory layers resemble an isolated file cabinet for one model. Synomem turns memory
into a shared, transactional canvas: independently operating agents can retain private knowledge,
deliver durable context, delegate work with consent, track commitments, and recognize good
collaboration through one auditable protocol. V1 provides that substrate locally; its interfaces are
designed so the same agent identities and semantics can later cross machines through an explicitly
configured service.

One append-only SQLite event store powers the TypeScript library, `synomem` CLI, actor-bound stdio
MCP server, compact change feeds, and readable Markdown projections. V1 runs entirely on one machine
and opens no network listener.

> [!IMPORTANT]
> Synomem is pre-1.0 software. Review the release notes before upgrading persisted storage or public
> API consumers.

## Quick start

```bash
npm install --global synomem

export SYNOMEM_HOME="$(mktemp -d)/.synomem"
synomem init
synomem agent create codex --name "Codex"
synomem agent create gracie --name "Gracie"

synomem kudos give codex \
  --from gracie --actor-kind agent \
  --title "Caught a continuity contradiction" \
  --reason "Found conflicting requirements before implementation."

synomem memo send codex \
  --from gracie --subject "Review follow-up" \
  --body "Please recheck the migration after the tests pass."

synomem note create --as gracie \
  --title "Release invariant" \
  --body "Never publish without explicit maintainer authorization."

synomem task create codex \
  --from gracie --title "Review the migration" --due-date 2026-09-15

synomem inbox codex
synomem task accept <task-id> --as codex --response "Starting after the tests."

# A todo is private to the agent that wrote it; nobody else can assign one.
synomem todo create --as codex --title "Re-read the migration notes"

synomem agent resolve Mike
synomem agent directory
synomem list
```

Tests and demos always use temporary homes and never modify an existing configured home.

## Let your agent set it up

Paste this prompt into Claude Code, Codex, Hermes, OpenClaw, Cursor, local Grok Build, or another
terminal-capable agent. The Synomem package contains the portable
[`skills/synomem`](https://github.com/Coaden/synomem/tree/main/skills/synomem) skill and a guarded
installer for the six named local harnesses.

```text
Set up Synomem for this agent and runtime. Synomem is a local-first coordination system for durable kudos, one-to-one memos, private agent notes, consent-based assigned tasks, and private todos. It uses an append-only SQLite database under ~/.synomem by default, an actor-bound stdio MCP server, and a portable Agent Skill. Multiple local agents may share the database, but every MCP server must be bound to its own stable identity.

Work autonomously through the safe, reversible steps below. Do not expose secrets, overwrite unrelated configuration, invent an identity, use --force without my explicit approval, or modify another agent's integration.

1. Verify Node.js 22.13+ and npm are available. Install or update the public package with `npm install --global synomem` if needed, then report `synomem --version`.
2. Preserve an existing `SYNOMEM_HOME`; otherwise use the default ~/.synomem. Run `synomem init`, then `synomem doctor`. Never point tests or experiments at another Synomem home.
3. Run `synomem agent list`. Determine this agent's existing stable ID from the current harness or Synomem configuration and reuse it. If no identity is clearly established, ask me for the agent ID and display name before running `synomem agent create <id> --name <name>`. Never silently merge or rename identities.
4. Detect the current harness from actual local evidence and its installed CLI help. Use runtime `claude` for Claude Code, `codex` for Codex, `hermes` for Hermes, `openclaw` for OpenClaw, `cursor` for Cursor, or `grok` for local Grok Build (`grokbot` is accepted as an alias). Check `synomem skill install --help`, then preview with `synomem skill install --runtime <runtime> --agent <agent-id>`. Review the exact destination and apply the same command with `--yes`; it must report `current`. If the installed release does not yet list this runtime, locate the packaged source under the global npm root at `synomem/skills/synomem` and follow the verified destination and conflict rules in https://github.com/Coaden/synomem/blob/main/docs/skill.md instead. Do not guess a path, overwrite an existing skill, or create a fake harness home to make an unavailable runtime appear installed.
5. Inspect any actor-bound MCP registration command printed by the installer. Check the harness's existing MCP list/config first, then run the command only if `synomem` is absent or incorrect. Do not create duplicates. Cursor has no noninteractive MCP-add command: carefully merge a `synomem` stdio entry into its documented user `~/.cursor/mcp.json`, using command `synomem-mcp` and the single argument `--agent-id <agent-id>` (the display name and kind come from the agent's profile, so nothing in a shared config file asserts an identity); preserve every existing entry.
6. Verify the harness can discover the installed skill and MCP server using its own list/status commands, then run `synomem doctor`. Start a new agent session if that harness does not live-reload a newly created skills directory.
7. If this is hosted Grok Bot rather than local Grok Build, do not claim it shares the desktop's local SQLite database. Install the package and skill only inside a persistent terminal environment where `npm`, local stdio MCP, and ~/.grok are actually available. Otherwise provide the skill URL https://github.com/Coaden/synomem/blob/main/skills/synomem/SKILL.md and explain the unsupported boundary; do not expose the local database through a tunnel.
8. Report the package version, stable actor ID, storage home, installed skill path, MCP registration and verification status, whether a new session is needed, and every file or configuration changed. Do not print record contents or environment values beyond the non-secret actor identity and home path.
```

## TypeScript API

```ts
import { SynomemClient } from 'synomem';

const client = new SynomemClient({
  actor: { kind: 'agent', id: 'gracie', displayName: 'Gracie' },
});

await client.init();

await client.memos.send({
  recipientAgentId: 'codex',
  subject: 'Review follow-up',
  body: 'Please recheck the migration after the tests pass.',
  idempotencyKey: 'gracie-codex-migration-follow-up',
});

const note = await client.notes.create({
  title: 'Release invariant',
  body: 'Never publish without explicit maintainer authorization.',
});

await client.notes.revise({
  noteId: note.record.event.id,
  expectedVersion: note.record.current.version,
  body: 'Never publish or create a release without explicit maintainer authorization.',
});

// A task is assigned to someone else and needs their consent.
await client.tasks.create({
  assigneeAgentId: 'codex',
  title: 'Review the migration',
  due: { kind: 'date', date: '2026-09-15' },
});

// A todo is the agent's own reminder, visible to no one else.
await client.todos.create({
  title: 'Re-read the migration notes',
  due: { kind: 'date', date: '2026-09-14' },
});

const page = await client.items.list({ kinds: ['memo', 'task'], limit: 10 });
const changes = await client.items.changes({ after: page.watermark });

await client.close();
```

The library performs no filesystem work at import time and never terminates its host process.

## Context-safe reads

`client.items.list()` and MCP `synomem_list` return 10 compact summaries by default and at most 50.
Summaries omit message bodies, kudos reasons and evidence, note bodies, task and todo details, source,
and metadata. Fetch one authorized detail record with `items.get(id)` or `synomem_get`.

Incremental reads return at most 20 changes by default and 100 at most. List and change responses
also stop around a 24 KiB item-data budget and return opaque continuation cursors. Agents should save
watermarks and must not drain historical pages speculatively.

## MCP

Every runtime launches the same stdio server with its own fixed actor identity while sharing one
local home:

```bash
codex mcp add synomem \
  --env SYNOMEM_ACTOR_ID=codex \
  --env SYNOMEM_ACTOR_KIND=agent \
  --env SYNOMEM_ACTOR_NAME=Codex \
  -- synomem-mcp
```

MCP tool arguments cannot override the bound actor. Purpose-specific write tools enforce ownership
and lifecycle rules; `synomem_list`, `synomem_get`, `synomem_changes`, and `synomem_inbox` provide
bounded reads. See [the MCP guide](docs/mcp.md).

## Agent skill

The package includes [`skills/synomem`](skills/synomem). Installation is explicit and dry-run first:

```bash
synomem skill install --runtime codex --agent codex
synomem skill install --runtime codex --agent codex --yes
synomem skill install --runtime hermes --agent mycroft --yes
synomem skill status
```

No postinstall hook changes an agent runtime. The installer never creates a missing runtime home and
refuses unowned conflicts unless `--force` is explicitly supplied. Supported local runtime names
are `claude`, `codex`, `hermes`, `openclaw`, `cursor`, and `grok`; `grokbot` aliases `grok`.

## Storage

```text
~/.synomem/
├── synomem/
│   ├── config.json
│   └── synomem.sqlite3
└── <agent-id>/
    ├── profile.json
    ├── WINS.md
    ├── MEMORY.md
    ├── TASKS.md
    ├── inbox/{kudos,memos,tasks}/
    └── NOTES.md
```

SQLite events are canonical and append-only. Markdown and current-state tables are rebuildable
projections. `NOTES.md` is human-owned and is never overwritten; canonical agent notes project to
`MEMORY.md`.

Override the root with `SYNOMEM_HOME`, `--home`, or the library's `home` option. Use
`synomem backup` for a consistent snapshot and JSON or JSONL export for recovery. Never synchronize
the live database with Git, Dropbox, a network share, or a file-copy tool.

## Trust and privacy

Synomem is audit-friendly, not tamper-proof. The local filesystem owner ultimately controls the
database and configuration. Actor binding protects ordinary MCP use but does not cryptographically
prove who launched a process.

Do not store credentials, cookies, tokens, authentication headers, environment values, private keys,
raw sensitive tool output, or unnecessary private content. `public` means eligible for public export;
Synomem never publishes automatically. Review [SECURITY.md](SECURITY.md) before sharing exports.

## Future hosted direction

A later hosted service may preserve the same workspace-scoped event semantics, aggregate versions,
idempotency, and bounded feeds. It will require a separately designed authenticated service with
authorization, tenant isolation, transport security, conflict handling, availability, and explicit
migration. The SQLite file is never a cloud synchronization protocol.

## Development

```bash
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run pack:check
```

See [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/releasing.md](docs/releasing.md). Do not publish or
create releases without explicit maintainer authorization.

## License

MIT © Troy Locke. See [LICENSE](LICENSE).
