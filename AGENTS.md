# AGENTS.md

This repository is a public TypeScript package. Changes should be reviewable, portable, secure by default, and appropriate for an OSS audience.

## Working agreement

- Read `ARCHITECTURE.md`, `SECURITY.md`, and the local `.docs/plan.md` when present before architectural changes.
- Use Node.js 22.13 or newer, ESM, strict TypeScript, and the built-in `node:sqlite` API.
- Keep V1 single-machine and local-first. Do not add hosted services, telemetry, accounts, network listeners, or postinstall behavior.
- Do not publish packages, create releases, alter npm configuration, or write into a user’s real `~/.agents` directory without explicit authorization.
- Tests and demos must use isolated temporary homes.
- Never commit real Synomem data, SQLite databases, environment files, secrets, generated coverage, or npm tarballs.

## Architectural invariants

- SQLite event rows are canonical and append-only. State changes are new events.
- Agent IDs are validated stable identities; aliases never silently merge identities.
- MCP writes use the actor bound at server startup. Tool arguments cannot override it.
- `WINS.md`, inbox files, and `profile.json` are generated projections. `NOTES.md` is human-owned and must never be overwritten.
- Machine reads stay context-bounded: compact list/change feeds have conservative defaults, hard limits, byte budgets, and opaque cursors. `WINS.md` is not a machine query source.
- Projection cleanup may remove only regular files listed in the generated-files manifest.
- Normal mutations must not rebuild or rewrite every pending inbox entry; full regeneration belongs to the explicit rebuild operation.
- `system` actors are automation identities and have no implicit agent or administrative authority.
- Raw JSON/JSONL export must remain available when canonical rows are unsupported or malformed; writes must fail closed across unknown event semantics.
- Do not follow symlinks outside the configured home.
- Evidence is descriptive metadata, never captured tool output or secret material.
- No filesystem work occurs at module import time, and library code never calls `process.exit()`.

## Quality gates

Run these before handing work off:

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:coverage
npm run pack:check
```

Update documentation and `CHANGELOG.md` when behavior, commands, policy, storage, or public types change. Add tests for security boundaries and observable behavior, not merely implementation details.
