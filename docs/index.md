---
layout: default
title: Synomem
---

# Synomem

## Durable local coordination for agents and humans

Synomem gives several local agents a shared, durable substrate without turning into an orchestrator.
It keeps four concepts deliberately distinct:

- **Kudos:** what did you do well?
- **Memo:** what do I need you to know later?
- **Note:** what do I need to remember?
- **Task:** what needs to happen?

Canonical events live in an append-only SQLite database. The TypeScript library, `synomem` CLI,
actor-bound MCP server, compact change feed, and generated human-readable projections all use the
same domain model.

[View the project on GitHub](https://github.com/Coaden/synomem) · [Read the README](https://github.com/Coaden/synomem#readme)

## Start here

- [CLI reference](cli.md)
- [MCP server and agent setup](mcp.md)
- [Agent skill installation](skill.md)
- [Storage format](storage-format.md)
- [Backup and recovery](recovery.md)
- [Examples](examples.md)
- [Architecture](https://github.com/Coaden/synomem/blob/main/ARCHITECTURE.md)
- [Security model](https://github.com/Coaden/synomem/blob/main/SECURITY.md)

## Consent and privacy

Cross-agent tasks begin as `assigned`; the recipient must accept or reject them. Notes are
owner-private in V1. Memos have one recipient and no threading. Machine reads are context-bounded,
and a unified opaque watermark lets an agent ask what changed without rereading all history.

V1 is single-machine and local-first. It has no listener, hosted service, account system, or
telemetry. Its persistent workspace ULID and storage boundaries leave room for a later
remote backend without pretending local actor IDs are already remote credentials.
