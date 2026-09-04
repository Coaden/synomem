# Security policy

## Supported versions and reporting

Synomem is pre-release. Security fixes target the latest release and `main`. Report vulnerabilities
through GitHub private vulnerability reporting for `Coaden/synomem`; do not open a public issue with
exploit details, secrets, or private record data.

## Trust model

Synomem is a local audit-friendly record, not a tamper-proof ledger.

- The local filesystem owner can alter the database, configuration, binaries, and projections.
- Actor-bound MCP processes prevent ordinary callers from selecting another actor per tool call;
  they do not cryptographically prove who launched the process.
- The CLI intentionally permits a local human to choose an actor within the local-owner boundary.
- MCP clients can invoke mutations available to the configured actor and are trusted local software.
- Visibility policies constrain application behavior, not the filesystem owner.

## Authorization model

- Humans have local administrative authority.
- Actor principals are the `(kind, id)` pair. A system or agent does not inherit another kind's
  author access merely because its textual ID matches.
- Agents may acknowledge only their own kudos and change only memo state addressed to them.
- Agents may create and revise only their own notes.
- Todo creators and assignees may change a todo; cross-agent assignment is configurable.
- System actors are automation identities with no implicit agent or administrative authority.
- Administrative MCP tools are disabled by default.

`private` records remain visible to their direct participants. `workspace` records are visible to
authorized actors in the local workspace. `public` means eligible for public export; it does not
automatically publish anything.

## Filesystem and SQLite

- IDs reject traversal syntax, separators, controls, and reserved names.
- Existing symlink components are rejected, and all derived paths stay under the configured home.
- Cleanup removes only regular files recorded in the generated-files manifest.
- Database, WAL, shared-memory, configuration, projection, export, and backup files are restricted to
  the local user where POSIX modes are available.
- WAL, foreign keys, full synchronization, bounded busy waits, and transactions reduce corruption
  and concurrency risks.
- Database triggers reject event updates and deletes. Lifecycle changes append events.
- Backups use SQLite `VACUUM INTO`; never copy a live database naively.
- Never use Git, Dropbox, generic network storage, or file-copy synchronization as a multi-writer
  protocol for the live database.

## Sensitive content

Synomem never captures tool output automatically. Do not record:

- tokens, passwords, cookies, private keys, authentication headers, or environment values;
- raw sensitive tool arguments or outputs;
- private file contents or whole chat transcripts;
- sensitive URLs or query strings;
- personal information unnecessary for the durable purpose.

Evidence is descriptive metadata such as a safe task reference, relative file path, commit, URL, or
sanitized tool description. Memos, notes, and todos often contain operational detail, so use the
least content necessary. Review every export before sharing it.

## Malformed and future data

Canonical payloads are validated on read. Diagnostics identify malformed or unsupported rows by
storage ID. Writes and full rebuilds fail closed when installed code cannot interpret the complete
event stream. Raw JSON and JSONL export remains available for recovery.

Read-only clients never migrate databases. Newer database versions fail before queries interpret
their schema. Use `synomem backup` before any migration that cannot be safely reversed.

## Nonrepudiation and hosted operation

Append-only application behavior makes ordinary changes explicit, but an unsigned database owned by
the local user can be rewritten. Do not describe Synomem as cryptographically tamper-proof or legally
nonrepudiable.

The local data plane and stdio MCP server expose no inbound network listener or hosted trust
boundary. `synomem auth login` temporarily opens an exact loopback OAuth callback and closes it when
the flow finishes. A hosted service requires server-side authentication, authorization, workspace
isolation, transport security, conflict handling, availability controls, audit policy, and explicit
migration. Client-side checks alone are insufficient.

The experimental remote client accepts only HTTPS origins, with an explicit loopback HTTP exception
for development. It does not follow redirects, bounds response bodies, keeps credentials out of
configuration and request bodies, and never sends its expected actor as authority. The future
server must derive actor and workspace authority from a validated audience-bound credential; these
client checks are not a substitute for server-side authorization.

Backend configuration may contain a remote service origin and workspace identifier, but never an
access token, refresh token, password, or private key. The SQLite-backed client fails closed when it
encounters a remote backend and does so before creating or opening a database. This prevents a
misconfigured remote workspace from silently diverging into local state.

Interactive CLI credentials are stored in macOS Keychain or Linux Secret Service and keyed to the
service, workspace, and stable actor pair. The macOS helper receives secret JSON through stdin
rather than command-line arguments. OAuth login requires PKCE S256, validates callback state, binds
the token request to the discovered resource, refuses non-HTTPS authorization/token endpoints, and
verifies the returned credential against the configured actor before retaining it.

The local import client snapshots SQLite with `VACUUM INTO`, validates bounded event/profile counts
and a whole-bundle checksum, and requires separate preview and confirmation commands. The remote
service—not this package—is responsible for administrative authorization, signed-plan validation,
empty-target enforcement, and atomic ingestion.

## Skill installer

No install hook changes agent configuration. `synomem skill install` and `uninstall` are explicit and
dry-run unless `--yes` is supplied. They recognize verified Claude Code, Codex, Hermes, OpenClaw,
Cursor, and local Grok layouts; honor documented runtime-home overrides; never create a missing
runtime home; constrain changes to `skills/synomem`; and refuse unowned conflicts without `--force`.
Copied skill files preserve their packaged permission modes, including execute bits needed by helper
scripts. Skill bundles are operational instructions rather than confidential Synomem data; the
`0600`/`0700` data-file policy above does not apply to them. The ownership stamp is written `0600`
where POSIX modes are available.
The installer prints MCP setup commands where the harness has a verified noninteractive command but
does not execute them or rewrite shared MCP configuration.
