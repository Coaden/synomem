# Changelog

All notable changes will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow Semantic Versioning.

## [0.5.2] - 2026-09-07

### Documentation

- The packaged Agent Skill did not mention posts at all, and left todos out of
  the record chooser, so an agent reading it had no way to reach either. The
  chooser is now organised by **who a record is for**, which is the thing that
  actually separates the kinds, and spells out the pair that gets confused: a
  task is work assigned to another agent, who must accept it; a todo is this
  agent's own private reminder that nobody else can see or assign.
- The Skill now covers `synomem_post_create`, `synomem_post_acknowledge` and
  `synomem_post_roster`, including that reading a post does not acknowledge it
  and that an agent created after publication was never asked.
- The Skill, examples and the pasteable install prompt say where posts and
  todos are found, since `synomem_inbox` deliberately holds only what somebody
  else is waiting on: it covers kudos, memos and tasks, not posts or todos.
- The MCP server's own instruction string, which every client sees, listed four
  record kinds out of six.

## [0.5.1] - 2026-09-07

### Documentation

- The README and CLI reference were rewritten for the two backends. They still
  described Synomem as running only on one machine, listed four record kinds
  when there are six, and pointed at `synomem init` rather than `synomem
config`. The pasteable agent-setup prompt was stale in the same ways.

### Fixed

- CI could not install the project at all. A dependency bump moved TypeScript to
  7, which is outside `typescript-eslint`'s peer range, so every `npm ci` failed
  on resolution while local runs kept working against an older `node_modules`.
  TypeScript is pinned to 6 until `typescript-eslint` supports 7.

### Changed

- Commander 15.

## [0.5.0] - 2026-09-07

### Added

- **`synomem backend status`** — connects to the selected backend and reports
  what answered. `backend show` still reads the configuration file and connects
  to nothing; a person debugging a broken setup needs that, and a person
  confirming a working one needs a connection to have been made.
- **`synomem projection status`** — whether the generated files match the
  canonical events, when they were last rebuilt, and which ones drifted. The
  comparison is against Synomem's own manifest, so a file somebody added to the
  projection tree by hand is not reported as drift.
- **`synomem remote workspaces`** — the organizations and workspaces a
  credential can reach, with the IDs `backend use remote --workspace` takes.
- `agent runtime list` with no agent named lists every agent that runs
  anywhere. Requiring the agent meant already knowing the answer to the
  question being asked.

### Changed

- **Remote setup no longer asks for a workspace ID.** An installation access
  key is bound to exactly one workspace, so the service is asked which one
  rather than the person; `config init --backend remote --access-token-stdin`
  needs no `--workspace`. Typing `ws-04psqx2rkt8ttft7a1t2z69r97` from memory
  was never something a person could do.
- The Windows credential-store choice is the restricted file rather than
  Credential Manager, which the credential layer does not implement. Offering a
  store that cannot read its own credential back fails on first use, after
  setup has already claimed the credential was safe.

### Fixed

- `doctor` reported every workspace's projections as stale once any agent had a
  generated ID: the expected-path list was built from canonical IDs while the
  files, the manifest and the cleanup all used handles.
- `doctor`'s agent-directory symbolic-link check inspected a path built from the
  canonical ID, so it examined a directory that does not exist and passed on a
  workspace whose agent directory really had been replaced with a link.

## [0.4.0] - 2026-09-07

Published as 0.3.0 and 0.4.0 on the same day; the entries below cover both.

### Changed

- **Agents have an opaque canonical ID and a separate handle.** `agent create
<handle>` generates a ULID; the handle is what people type and can be renamed
  with `agent rename` without orphaning the events written under the old name.
  Events, rosters and statistics key on the canonical ID.
- The home IS the storage directory. It was `<home>/synomem`, which produced
  `~/.synomem/synomem` once the home moved — a path the layout rules out.
- The default home is `~/.synomem`. There is no detection of or migration from
  `~/.agents`, per the greenfield policy.
- Projection directories are named by handle, since they exist to be read.

### Added

- **`synomem config`** — the onboarding wizard, with `configure` and `setup` as
  aliases. It refuses to run without a terminal and names the deterministic
  flags instead of blocking forever on a pipe.
- **`synomem config init`** — the non-interactive equivalent, including
  `--access-token-stdin` so an installation key is never passed as an argument
  where the shell history and process list would keep it.
- **`synomem config show`** — reports where a credential comes from, never the
  credential.
- **`synomem reset`** — lists every exact target before removing anything.
  Installed skills and MCP registrations are left alone unless
  `--integrations` is passed.
- Synomem Cloud is implicit: `backend use remote` needs only `--workspace`.
  `--url` remains for private deployments and stays out of the public docs.
- A discriminated credential model, so an installation key is no longer treated
  as a refreshable OAuth credential.
- `agent rename`, `agent archive`, `agent restore`, and `agent alias add` /
  `alias remove`, which add and remove aliases without replacing the set.
- The MCP server reports the canonical actor rather than the requested name, so
  a misconfigured runtime cannot appear to act as somebody it is not.

### Schema

- Version 7 adds `agents.handle` (backfilled from the ID, uniquely indexed) and
  `agents.status`. Existing agents keep their name-shaped ID; only new agents
  get a generated one.

### Added

- Posts: publication to everyone in a workspace, with per-actor acknowledgements
  so an author can see who has responded. A post has no recipient and no
  assignee — work for one actor is a memo or a task.
- `post roster` answers who has acknowledged and who has not, counting agents
  created after the post separately rather than listing them as outstanding.
- Schema version 6 adds `post_acknowledgments`.

### Changed

- The MCP server binds to an agent with `--agent-id`, reading the display name and actor kind from
  the agent's profile. `synomem skill install --agent <id-or-alias>` resolves the agent before
  writing anything, records a runtime binding for each runtime it installs, and generates a
  registration command carrying only the canonical ID.

## [0.2.0] - 2026-09-05

### Added

- Private todos as a distinct domain: a todo belongs to the agent that wrote it, is visible to no
  one else, and cannot be assigned. Work meant for another agent is a task.
- Optional responses when accepting a task and required responses when rejecting one, so a refusal
  always tells the assigner why.
- Discovery for work that has stalled: tasks awaiting a response and tasks past their deadline.
- Case-insensitive agent aliases with `agent resolve`, which returns candidates instead of guessing
  when several agents answer to one name, and `agent directory`.
- Advisory runtime bindings recording where an agent was registered to run, with `agent runtime
bind`, `list`, and `unbind`, and the matching `synomem_agent_resolve` and
  `synomem_agent_directory` MCP tools.

### Changed

- Schema version 5 adds a normalized alias column with a unique index and an
  `agent_runtime_bindings` table. Existing databases migrate in place.
- Aliases are stored folded to lowercase, so one name cannot be claimed twice in two casings.

## [0.1.1] - 2026-09-04

### Fixed

- Allow configured `SYNOMEM_ACTOR_ID`, `SYNOMEM_ACTOR_KIND`, and `SYNOMEM_ACTOR_NAME` values to
  override historical CLI default identities for remote commands while preserving local fallbacks.

## [0.1.0] - 2026-09-04

### Added

- Four distinct event-sourced domains: kudos, one-recipient memos, owner-private notes, and todos.
- Consent-based cross-agent todo assignment with explicit acceptance and rejection.
- Unified, context-bounded item and change feeds with opaque sequence watermarks.
- Persistent workspace and agent identities, actor-scoped idempotency, and optimistic revisions.
- Local-first SQLite storage with append-only canonical events and rebuildable projections.
- TypeScript library, `synomem` CLI, actor-bound `synomem-mcp` stdio server, and portable agent skill.
- Explicit local and remote backend configuration through a shared asynchronous domain-service
  boundary.
- OAuth authorization-code PKCE, OS credential storage, and an HTTPS remote service client.
- Previewed, checksummed local-to-remote import without implicit synchronization.
- Public OpenAPI contract for independently operated hosted services.

### Security

- MCP mutations cannot override the actor bound at server startup.
- Notes remain owner-private, and direct-record authorization distinguishes actor kind and ID.
- Machine-facing reads enforce hard item limits, byte budgets, and opaque cursors.
- Unknown canonical semantics fail writes closed while raw JSON and JSONL recovery remain available.
- Remote credentials remain outside configuration, events, command arguments, and normal output.
- Skill installation is explicit, constrained to supported runtime directories, and dry-run by
  default.

[Unreleased]: https://github.com/Coaden/synomem/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/Coaden/synomem/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/Coaden/synomem/releases/tag/v0.1.0
