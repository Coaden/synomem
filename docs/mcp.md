---
layout: default
title: MCP server
---

# MCP server

`synomem-mcp` is an actor-bound stdio server built with the official TypeScript SDK. It opens no
network listener.

```text
SYNOMEM_ACTOR_ID=codex
SYNOMEM_ACTOR_KIND=agent
SYNOMEM_ACTOR_NAME=Codex
```

Malformed or missing identity configuration fails startup. The server inserts the bound identity
into mutations; callers cannot override it in tool arguments.

## Registration

```bash
codex mcp add synomem \
  --env SYNOMEM_ACTOR_ID=codex \
  --env SYNOMEM_ACTOR_KIND=agent \
  --env SYNOMEM_ACTOR_NAME=Codex \
  -- synomem-mcp
```

Add `--env SYNOMEM_HOME=/absolute/shared/path` when not using `~/.agents`.

When that home selects a remote backend, the same stdio MCP command uses the remote API and creates
no local SQLite database or projections. Run `synomem auth login --actor-id <id> --client-id <id>`
first, or provide `SYNOMEM_ACCESS_TOKEN` to the MCP process as a secret environment variable. The
configured `--actor-*` values select the matching OS credential entry and describe the expected
binding, but the hosted service remains authoritative and derives actor/workspace permissions from
the token; request bodies cannot override them.

## Tools

Shared bounded reads:

```text
synomem_list             synomem_get
synomem_changes          synomem_inbox
```

Purpose-specific writes:

```text
synomem_kudos_give       synomem_kudos_acknowledge   synomem_kudos_revoke
synomem_memo_send        synomem_memo_read            synomem_memo_archive
synomem_note_create      synomem_note_revise          synomem_note_archive
synomem_todo_create      synomem_todo_update          synomem_todo_complete
synomem_todo_accept      synomem_todo_reject          synomem_todo_reopen
synomem_todo_cancel
```

Focused kudos reads and administration remain available:

```text
synomem_kudos_list       synomem_kudos_get            synomem_kudos_changes
synomem_kudos_stats      synomem_agent_list           synomem_agent_create
synomem_doctor           synomem_rebuild
```

Agent creation and rebuild are disabled by default. Every tool declares precise schemas, stable
errors, structured and concise text content, the bound actor, and MCP behavior annotations.

`synomem_list` returns 10 compact summaries by default and at most 50. `synomem_changes` returns 20
changes by default and at most 100. Both stop around a 24 KiB item-data budget. Bodies, reasons,
evidence, descriptions, source, and metadata require one explicit `synomem_get`.

## Resources

```text
synomem://agents
synomem://agents/<agent-id>/profile
synomem://agents/<agent-id>/wins
synomem://agents/<agent-id>/inbox
synomem://items/<item-id>
synomem://events/<event-id>
```

Resources apply the same participant and visibility policy as tools. Agents may read only their own
inbox resource. Canonical event resources authorize against their aggregate before returning data.

## Policy

Edit `<home>/synomem/config.json` while writers are stopped. Safe defaults deny self-kudos, MCP
identity creation, and MCP rebuild. Notes are unconditionally owner-private in V1. Cross-agent todo assignment is enabled; ownership and
participant rules still apply.

Human actors have local administrative authority. Agent actors manage only their own note, recipient
memo state, and todos they created or received. System actors have no implicit authority. The
filesystem owner remains the ultimate local authority.
