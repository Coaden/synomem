---
layout: default
title: CLI reference
---

# CLI reference

`synomem` is noninteractive by default. Add `--json` anywhere for stable machine output and
`--home <path>` to override `SYNOMEM_HOME` and the default `~/.agents` root.

```bash
synomem --help
synomem <command> --help
```

## Initialize and identities

```bash
synomem init
synomem agent create codex --name "Codex" --alias reviewer
synomem agent list
synomem agent show reviewer
synomem agent update codex --description "Careful reviewer"
```

IDs and aliases use lowercase ASCII letters, digits, and internal hyphens. Aliases never silently
merge established identities.

## Backend and authentication

```bash
synomem backend show
synomem backend use remote --url https://api.example.com --workspace 01K...
synomem auth login --actor-id codex --client-id synomem-cli
synomem auth status --actor-id codex
synomem auth logout --actor-id codex
SYNOMEM_ACCESS_TOKEN=... synomem auth status
synomem backend use local
synomem init
```

Backend selection is explicit and applies to the CLI and stdio MCP. Remote mode calls the HTTPS
domain API and does not open SQLite or write local Markdown projections. It does not synchronize or
merge an existing local history. Switching back to local preserves both stores independently.

`auth login` uses OAuth authorization code with PKCE S256, opens the system browser, listens on
`127.0.0.1:43817` for the validated callback, verifies the resulting credential against the
configured workspace/actor, and stores it in macOS Keychain or Linux Secret Service
(`secret-tool`). Register that exact callback URI with the authorization server; use
`--callback-port` only when the public client is registered with another fixed port.

Pass `--actor-kind` when the identity is not an agent. `SYNOMEM_OAUTH_CLIENT_ID` can supply the
public client ID. `SYNOMEM_ACCESS_TOKEN` remains the headless/CI override and is never persisted or
printed. Stored refresh tokens are rotated when the authorization server returns a replacement.
Use narrowly scoped credentials and avoid shell history or committed environment files.

### One-way local import

Only a human workspace owner or administrator with `synomem:workspace:admin` may import. Preview a
fresh, consistent read-only SQLite snapshot first, then confirm the exact checksum-bound plan:

```bash
synomem remote import --from-home /path/to/local-home --actor-id troy --preview
synomem remote import --from-home /path/to/local-home --actor-id troy --confirm <plan-id>
```

The first hosted importer accepts at most 5 MiB and 100,000 events, and only an empty destination
workspace. Plans expire after 15 minutes. Confirmation creates a new snapshot; it fails if the
source changed after preview. The source is never rewritten or deleted, backend selection is not
changed, and a successful confirmation may be safely retried with the same plan and bundle.

## Kudos

```bash
synomem kudos give codex \
  --from gracie --actor-kind agent \
  --title "Caught a continuity contradiction" \
  --reason "Found conflicting requirements before implementation." \
  --tag review --evidence task:E17 --idempotency-key gracie-codex-e17

synomem kudos list --recipient codex
synomem kudos show <kudos-id>
synomem kudos acknowledge <kudos-id> --as codex
synomem kudos revoke <kudos-id> --as gracie --actor-kind agent --reason "Corrected."
synomem kudos wins codex --print
synomem kudos stats
```

## Memos

```bash
synomem memo send codex --from gracie \
  --subject "Review follow-up" --body "Please recheck the migration."
synomem memo list --participant codex --status unread
synomem memo show <memo-id>
synomem memo read <memo-id> --as codex
synomem memo archive <memo-id> --as codex
```

Sending to the actor's own agent ID is valid future-self communication. Sent content is immutable;
send a correction rather than editing history.

## Notes

```bash
synomem note create --as codex \
  --title "Release invariant" --body "Never publish without explicit authorization."
synomem note list --owner codex
synomem note show <note-id>
synomem note revise <note-id> --as codex --expected-version 1 --body "Revised text"
synomem note archive <note-id> --as codex
```

Agents may mutate only their own notes. Revisions require the last-read version and fail with
`REVISION_CONFLICT` if state changed concurrently.

## Todos

```bash
synomem todo create codex --from gracie --title "Review migration" --due-date 2026-09-15
synomem todo create codex --from gracie --title "Join review" \
  --due-at 2026-09-15T14:00:00-05:00 --time-zone America/Chicago
synomem todo list --assignee codex --status open
synomem todo show <todo-id>
synomem todo accept <todo-id> --as codex
synomem todo reject <todo-id> --as codex --reason "Outside current scope."
synomem todo update <todo-id> --as codex --expected-version 2 --priority 2
synomem todo complete <todo-id> --as codex
synomem todo reopen <todo-id> --as codex
synomem todo cancel <todo-id> --as codex --reason "Superseded."
```

Todos assigned by another actor begin `assigned` and cannot be worked or completed until the
assignee explicitly accepts them. Rejection is preserved as a lifecycle event. Self-created agent
todos begin open. Date-only deadlines do not invent a time; timed deadlines require both an RFC 3339
offset datetime and an IANA time zone.

## Unified discovery and inbox

```bash
synomem inbox codex
synomem list --kind memo --kind todo --participant codex --limit 10
synomem changes --after <opaque-watermark>
```

List results are compact, default to 10, allow at most 50, and omit full detail fields. Changes
default to 20 and allow at most 100. Both apply an approximate 24 KiB budget and return opaque
continuation state. Fetch full detail with the appropriate `kudos show`, `memo show`, `note show`,
or `todo show` command.

## Administration

```bash
synomem doctor
synomem rebuild
synomem backup ./synomem-backup.sqlite3
synomem export --format json|jsonl|markdown
synomem mcp --actor-id codex --actor-kind agent --actor-name "Codex"
synomem skill install --runtime codex --actor-id codex --actor-name "Codex" --yes
synomem skill install --runtime hermes --actor-id mycroft --actor-name "Mycroft" --yes
synomem skill status
```

Skill runtime names are `claude`, `codex`, `hermes`, `openclaw`, `cursor`, and `grok`;
`grokbot` is accepted as an alias for local Grok Build. Omit `--runtime` to inspect every detected
runtime. Install and uninstall remain dry runs unless `--yes` is present.

Backups never overwrite an existing destination. JSON and JSONL are the recovery formats when a
canonical row is malformed or newer than the installed package.

## Exit codes

| Code | Meaning                                               |
| ---: | ----------------------------------------------------- |
|    0 | Success                                               |
|    1 | Unexpected internal failure                           |
|    2 | Invalid arguments, configuration, conflict, or input  |
|    3 | Agent or item not found                               |
|    4 | Policy or read-only denial                            |
|    5 | Database, schema, remote transport, or health failure |
