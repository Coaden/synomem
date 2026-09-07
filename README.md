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

Synomem runs two ways, and the CLI, the library and the MCP server behave identically on both.
**Local** keeps an append-only SQLite database on this machine, needs no account, and opens no
network listener. **Synomem Cloud** keeps canonical state in a hosted workspace shared across
machines and agents, with organizations, roles and administration. `synomem config` sets up either
one. Nothing is synchronized between them and choosing the hosted backend never creates a shadow
local database. See the [CLI reference](docs/cli.md#backend-and-authentication).

</div>

Synomem gives humans and AI agents durable ways to coordinate beyond a disappearing chat:

- **Kudos** recognize a concrete contribution.
- **Memos** deliver a message to another agent or to one's future self.
- **Notes** retain agent-owned, revisable knowledge.
- **Posts** announce something to everyone in the workspace, and record who has acknowledged it.
- **Tasks** delegate work to another agent, with their consent.
- **Todos** track an agent's own actions, private to them, with optional date-only or
  timezone-aware deadlines.

## Core philosophy

Traditional AI memory layers resemble an isolated file cabinet for one model. Synomem turns memory
into a shared, transactional canvas: independently operating agents can retain private knowledge,
deliver durable context, delegate work with consent, track commitments, and recognize good
collaboration through one auditable protocol. The same agent identities and semantics work on one
machine or across many: the local backend keeps everything on disk, and Synomem Cloud keeps it in a
hosted workspace reached over HTTPS.

One append-only event store powers the TypeScript library, `synomem` CLI, actor-bound stdio MCP
server, compact change feeds, and readable Markdown projections. On the local backend that store is
SQLite on this machine, and nothing listens on the network. On Synomem Cloud it is a hosted
Postgres workspace reached over HTTPS with actor-scoped credentials. Events are never rewritten on
either one.

> [!IMPORTANT]
> Synomem is pre-1.0 software. Review the release notes before upgrading persisted storage or public
> API consumers.

## Quick start

```bash
npm install --global synomem
synomem config          # asks where state should live, then sets it up
```

`synomem config` is interactive. Its deterministic equivalents, for a machine with no terminal:

```bash
# Local: SQLite on this machine, no account.
synomem config init --backend local --yes

# Synomem Cloud with an installation access key from
# https://portal.synomem.ai/installations. The key names its own workspace, so
# there is no ID to look up -- and it is piped rather than passed as an
# argument, which the shell history and the process list would both keep.
printf '%s' "$SYNOMEM_KEY" | synomem config init \
  --backend remote --auth access-key --access-token-stdin --yes
```

Check either one at any time:

```bash
synomem backend status      # connects, and reports what answered
synomem projection status   # local only: are the generated files current?
synomem doctor
```

Everything below works the same on both backends.

```bash
export SYNOMEM_HOME="$(mktemp -d)/.synomem"
synomem config init --backend local --yes
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

# A post is readable by everyone in the workspace, and tracks acknowledgement.
synomem post create --as gracie \
  --title "Migration tonight" --body "Expect a short read-only window."
synomem post acknowledge <post-id> --as codex --note "Already handled."
synomem post roster <post-id>

synomem agent resolve Mike
synomem agent directory
synomem agent runtime list
synomem list
```

Tests and demos always use temporary homes and never modify an existing configured home.

## Let your agent set it up

Paste this prompt into Claude Code, Codex, Hermes, OpenClaw, Cursor, local Grok Build, or another
terminal-capable agent. The Synomem package contains the portable
[`skills/synomem`](https://github.com/Coaden/synomem/tree/main/skills/synomem) skill and a guarded
installer for the six named local harnesses.

```text
Set up Synomem for this agent and runtime. Synomem is a coordination system for six durable record kinds, told apart by who each one is for: kudos recognize one agent's contribution, memos deliver a message to one agent or to your future self, notes hold knowledge this agent owns, posts tell everyone in the workspace something and record who acknowledged it, tasks assign work to another agent who must accept or reject it, and todos are this agent's own private reminders that nobody else can see or assign. A task is work for somebody else; a todo is a reminder for yourself. It runs on an append-only event store, an actor-bound stdio MCP server, and a portable Agent Skill. The store is either local SQLite under ~/.synomem, which needs no account and opens no network listener, or a hosted Synomem Cloud workspace reached over HTTPS. Nothing is synchronized between the two. Multiple local agents may share a local database, but every MCP server must be bound to its own stable identity.

Each agent has an opaque canonical ID, generated at creation and never reused, and a separate handle that people type and that can be renamed later. `agent create` takes the handle. Never assert an ID yourself.

Work autonomously through the safe, reversible steps below. Do not expose secrets, overwrite unrelated configuration, invent an identity, use --force without my explicit approval, or modify another agent's integration.

1. Verify Node.js 22.13+ and npm are available. Install or update the public package with `npm install --global synomem` if needed, then report `synomem --version`.
2. Preserve an existing `SYNOMEM_HOME`; otherwise use the default ~/.synomem. Run `synomem config show` first: if a backend is already configured, leave it alone and do not reconfigure it. Otherwise ask me whether this machine should use the local backend or Synomem Cloud, and never guess. For local, run `synomem config init --backend local --yes`. For Synomem Cloud, ask me for an installation access key from https://portal.synomem.ai/installations and pipe it in — `printf '%s' "$KEY" | synomem config init --backend remote --auth access-key --access-token-stdin --yes` — because an argument is kept by both the shell history and the process list. The key names its own workspace, so do not ask me for a workspace ID. Then run `synomem backend status` and `synomem doctor`. Never point tests or experiments at another Synomem home.
3. Run `synomem agent list`. Determine this agent's existing identity from the current harness or Synomem configuration and reuse its canonical ID. If no identity is clearly established, ask me for the handle and display name before running `synomem agent create <handle> --name <name>`, then record the canonical ID it reports. Never silently merge or rename identities.
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

This is the local backend. On Synomem Cloud the canonical store is a hosted Postgres workspace and
nothing below is written to this machine.

```text
~/.synomem/
├── config.json
├── synomem.sqlite3
├── credentials/
│   └── installation.json   # only when an access key is stored in a file
└── <handle>/               # one directory per agent, named by handle
    ├── profile.json
    ├── WINS.md
    ├── MEMORY.md
    ├── TASKS.md
    ├── NOTES.md
    └── inbox/{kudos,memos,tasks}/<record-id>.md
```

The home IS the storage directory: `config.json` and the database sit directly in it, with no
nested `synomem/` level.

Agent directories are named by HANDLE, because they exist to be read. The canonical agent ID is
what stored events reference, so renaming an agent leaves its history untouched.

Renaming moves the whole directory, `NOTES.md` included. That file is yours rather than Synomem's,
so a rebuild will never delete it — which is exactly why the rename moves the directory instead of
regenerating it somewhere new and leaving your notes behind.

SQLite events are canonical and append-only. Markdown and current-state tables are rebuildable
projections — run `synomem rebuild` to regenerate them, and `synomem projection status` to see
whether they currently match the events. Posts and todos project no files: a post belongs to the
whole workspace rather than to one agent's directory, and a todo is private to its owner.

`NOTES.md` is human-owned and is never overwritten; canonical agent notes project to `MEMORY.md`.
Each projection can be turned off individually, in which case its file is not written at all.

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
