# Architecture

Synomem is one ESM package with four adapters over a shared asynchronous domain-service port:

```text
TypeScript library ─┐                         ┌─> SynomemClient ─> SynomemStorage ─> SQLite events
CLI                ─┼─> configured factory ──┤                                       ├─> indexes
stdio MCP          ─┘                         └─> RemoteSynomemService ─> HTTPS API    └─> files
```

A single package keeps validation, policy, migrations, types, CLI behavior, and MCP behavior
consistent. Public operations are asynchronous. CLI and MCP receive the service through an
injectable factory and do not reach into concrete storage or projection objects. SQLite remains
behind the local service so a later hosted transport can preserve domain semantics without exposing
database APIs remotely.

## Domain model

One workspace contains stable agent identities and four record aggregates:

- Kudos: given, acknowledged, or revoked recognition.
- Memos: sent, read, or archived one-to-one messages, including self-memos.
- Notes: owner-scoped knowledge with optimistic revisions and archive state.
- Todos: assigned actions with updates, completion, reopening, and cancellation.

Every mutation appends a versioned event with a workspace ID, aggregate ID, aggregate version,
actor, timestamp, optional actor-scoped idempotency key, source, and metadata. The store assigns a
monotonic ingestion sequence inside the write transaction. Historical rows are never updated or
deleted to represent state changes.

SQLite schema version 3 adds the generalized event envelope and `items_current`. Existing kudos
events remain valid through deterministic legacy normalization. Unsupported or malformed semantics
make writes and rebuilds fail closed while raw JSON and JSONL export remains available.

## Query models

`events` is canonical. `agents`, `aliases`, `kudos_current`, and `items_current` are transactional,
rebuildable query indexes. `items_current` stores only bounded summary fields and participant IDs;
full bodies, reasons, evidence, descriptions, source data, and metadata stay in canonical events.

List reads default to 10 records and allow at most 50. Change reads default to 20 and allow at most 100. Both use opaque sequence cursors and an approximate 24 KiB item-data budget. Detail reads
reconstruct one requested aggregate. Generated Markdown is never a machine query source.

## Authorization

MCP servers bind one actor at startup, and tool inputs cannot override it. Humans have local
administrative authority. Agents can manage their own notes, recipient memo state, and todos they
created or received. System actors have no implicit agent or administrator authority. Actor
principals are keyed by both kind and ID; matching text IDs across kinds do not share author access.

Delivery and ownership are distinct from visibility. Direct participants can access their record;
`workspace` grants other workspace actors access; `public` makes a record eligible for public export.
The filesystem owner remains the ultimate local authority.

## Concurrency and durability

SQLite uses WAL, foreign keys, `synchronous=FULL`, a bounded busy handler, and `BEGIN IMMEDIATE`
transactions. Actor-scoped idempotency protects retries. Note and todo revisions use aggregate
versions so stale writes fail with `REVISION_CONFLICT` rather than overwriting concurrent state.

V1 supports one machine and one filesystem owner. A future hosted service must enforce the same
policies server-side and add authentication, tenant isolation, transport security, conflict handling,
availability, and explicit data migration.

## Projections

Normal mutations synchronize only affected agents. `rebuild` recreates all derived indexes and
files. `WINS.md`, `MEMORY.md`, `TODOS.md`, inbox entries, and `profile.json` are generated.
`NOTES.md` is human-owned and never overwritten or added to the generated-files manifest.

Cleanup removes only manifest-listed regular files beneath the configured home and never follows
symlinks. Projection timestamps derive from canonical event time for deterministic rebuilds.

## Module boundaries

- `src/types.ts`: public types and event contracts.
- `src/schemas.ts`: runtime validation and payload limits.
- `src/storage.ts`: SQLite ownership, migrations, indexes, transactions, backups, and raw recovery.
- `src/client.ts`: public domain API, policy, lifecycle, and aggregate reconstruction.
- `src/service.ts`: transport-neutral asynchronous service, capability, and factory contracts.
- `src/ports/`: repository and projection contracts injected into the authoritative core.
- `src/import.ts`: consistent local snapshot, bounded canonical bundle, and remote import client.
- `src/oauth.ts` and `src/credentials.ts`: PKCE login/refresh and OS credential-store boundary.
- `src/projections.ts`: deterministic safe filesystem views.
- `src/cli.ts`: command parsing, human/JSON output, and stable exit codes.
- `src/mcp/index.ts`: actor binding, tools, resources, prompts, and visibility enforcement.
- `src/skill-install.ts`: explicit constrained skill placement.

## Future boundary

`SynomemCore` receives repository and projection ports; `SynomemClient` composes it with the local
SQLite and filesystem implementations and retains local administration. The current storage class
is not a public API contract. Adapters use explicit service capabilities and administrative methods
instead of accessing it. A hosted implementation should expose domain operations through an
authenticated service, not connect clients directly to a remote database or synchronize SQLite
files.

Repository operations are async-capable even though SQLite executes its statements synchronously.
The local adapter serializes asynchronous domain transactions on each connection and keeps a
separate synchronous transaction primitive for migrations and local projection maintenance. This
lets a remote implementation hold a transaction across awaited driver calls without changing
domain behavior or allowing overlapping transactions on one SQLite connection.

`RemoteSynomemService` is the client-side implementation of the same service contract. It calls the
versioned domain API described by `openapi/synomem-v1.yaml`, sends credentials only in the
authorization header, moves retry keys to `Idempotency-Key`, and never sends actor identity as
authority. It does not connect to Postgres or create local projections.

Configuration schema version 3 makes backend selection explicit. Existing schema version 2 files
migrate to `{ "kind": "local" }`; remote selection records only the service origin and workspace
identifier. Credentials are never stored in `config.json`. `SynomemClient` remains intentionally
local-only and refuses a remote backend before creating or opening SQLite; adapter factories are
responsible for selecting `RemoteSynomemService`. The CLI and stdio MCP use that configured factory
by default, so remote mode performs no SQLite or filesystem projection writes.

Remote credentials are indexed by service origin, workspace, and stable `(kind,id)` actor identity;
display-name changes do not orphan them. The environment token takes precedence without
persistence. Interactive authorization uses protected-resource and authorization-server discovery,
PKCE S256, a fixed registered loopback callback, and OS credential storage. Refresh tokens never
enter Synomem configuration or events.

Local-to-remote import is deliberately not synchronization. The client creates a consistent,
checksummed SQLite snapshot bundle, previews it against an explicit destination, and submits it only
after confirmation. The remote service owns authorization, plan signing, empty-target enforcement,
validation, and transactional ingestion. The local source and backend configuration remain
unchanged.
