---
layout: default
title: Storage format
---

# Storage format

## Home layout

```text
~/.synomem/
├── synomem/
│   ├── config.json
│   ├── synomem.sqlite3
│   ├── synomem.sqlite3-wal
│   └── synomem.sqlite3-shm
└── <agent-id>/
    ├── profile.json
    ├── WINS.md
    ├── MEMORY.md
    ├── TASKS.md
    ├── inbox/{kudos,memos,tasks}/<item-id>.md
    └── NOTES.md
```

`SYNOMEM_HOME`, the CLI `--home` option, or the library's `home` option changes the root.

`config.json` schema version 3 contains an explicit backend:

```json
{ "kind": "local" }
```

or a remote service location and workspace identifier:

```json
{
  "kind": "remote",
  "baseUrl": "https://synomem.example",
  "workspaceId": "01K..."
}
```

Schema version 2 configurations migrate to the local backend. Remote credentials are not stored in
this file. The local SQLite client refuses remote configuration rather than creating a shadow local
database.

## SQLite schema

Schema version 3 contains:

- `events`: canonical append-only validated JSON events with workspace, aggregate, query, and
  monotonic sequence fields;
- `items_current`: compact cross-type summary and lifecycle state;
- `kudos_current`: focused recognition summary and acknowledgment/revocation state;
- `agents` and `aliases`: current identity projections;
- `projection_manifest`: generated paths eligible for constrained cleanup;
- `schema_migrations`: applied database migrations.

Events use transactionally assigned ingestion sequences for cursors and watermarks. Aggregate
versions provide optimistic concurrency for notes and tasks. Actor-scoped idempotency keys protect
all retryable mutations.

Current tables and files are rebuildable. Full bodies, reasons, evidence, descriptions, source, and
metadata remain in canonical events and require detail reads. Machine APIs never parse Markdown.

## Generated and owned files

`profile.json`, `WINS.md`, `MEMORY.md`, `TASKS.md`, and inbox entries are generated. Normal mutations
synchronize only affected agents; `synomem rebuild` performs full deterministic regeneration.
Cleanup removes only manifest-listed regular files and never follows symlinks.

`NOTES.md` is human-owned, is never placed in the manifest, and is never overwritten. Canonical
agent notes project to `MEMORY.md`.

## Recovery

Use `synomem backup` for a consistent SQLite snapshot. Use JSON or JSONL export for portable raw
recovery, including unsupported or malformed rows. Markdown export may omit rows it cannot safely
render.

Never edit canonical tables, overwrite an active database, copy a live database naively, or
synchronize it through Git, Dropbox, a network share, or a file-copy tool.
