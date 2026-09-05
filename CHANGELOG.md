# Changelog

All notable changes will be documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and releases follow Semantic Versioning.

## [Unreleased]

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
