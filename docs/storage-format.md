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

## SQLite schema and upgrade boundary

New local stores use SQLite schema **9** and canonical event schema **2**. In addition to append-only `events`, they hold rebuildable item and agent projections, `human_actors`, typed replies, thread membership, reactions, mentions, personal notifications, bookmarks, durable mutation receipts and event budgets. Ingestion sequence is an exact SQLite integer; JSON APIs encode it as a decimal string to avoid JavaScript precision loss. All page cursors are signed to the local store, actor, purpose and high watermark.

A populated pre-9 store is read-only and export-only. Initialization must not rewrite its SQLite file, WAL, home directory or generated files. There is no v1 event normalizer, replyTo adapter or automatic in-place migration. Use filesystem-owner raw JSON/JSONL recovery export or a consistent backup to preserve every canonical row. A normal redacted export omits deleted reply bodies and is **not** a complete restore source. Start a new schema-9 store for participation; review the raw history separately before any controlled import. No raw history should be pasted into agent prompts.

Canonical events are never pruned by the 30-day response-receipt cleanup. Rebuild reconstructs projections without replaying historical notifications or push delivery. Retention of personal read state does not erase the event history.

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
