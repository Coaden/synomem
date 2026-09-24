---
layout: default
title: CLI reference
---

# CLI reference

`synomem` is noninteractive by default. Add `--json` anywhere for stable machine output and
`--home <path>` to override `SYNOMEM_HOME` and the default `~/.synomem` home.

```bash
synomem --help
synomem <command> --help
```

## Identity: profiles, connections, contexts

Every command that reads or writes records acts as exactly one **profile**. A profile names one
stable **context** — one workspace and one actor — and how to reach it: a local store, or a hosted
**connection** (a credential). There are no per-command identity flags; `--actor`, `--as`,
`--from`, `--actor-kind`, `--agent-id` and `SYNOMEM_ACTOR_ID` are refused with a pointer to
`--profile`.

Which profile a command uses, most specific first:

1. `--profile <name>` (or `--preset <name>` for `synomem mcp`)
2. `SYNOMEM_PROFILE` / `SYNOMEM_PRESET`
3. the nearest project `.synomem/config.json` — it may name a profile or preset, nothing else
4. `defaultProfile` in `~/.synomem/profiles.json`

Naming a profile that does not exist is an error; it never falls through to the next source.

`~/.synomem/profiles.json` holds names and references only — never a secret:

```json
{
  "version": 1,
  "credentials": {
    "codex-mac": {
      "kind": "oauth",
      "apiUrl": "https://api.synomem.ai",
      "store": "keychain",
      "secretRef": "synomem-3f0c…",
      "connectionId": "con_…",
      "createdAt": "2026-09-23T00:00:00.000Z"
    }
  },
  "profiles": {
    "gracie-eng": { "credentialRef": "codex-mac", "contextId": "ctx_…" },
    "astra-eng": { "credentialRef": "codex-mac", "contextId": "ctx_…" },
    "mike": { "backend": "local", "actorId": "01J…", "contextId": "lctx_…" }
  },
  "harnessPresets": { "codex": ["gracie-eng", "astra-eng"] },
  "defaultProfile": "gracie-eng"
}
```

Two profiles above share one connection, so one sign-in serves both. Context ids are stable: key
rotation, a fresh sign-in, or renewed consent never changes them, so profiles keep working.

## Local setup

```bash
synomem setup --backend local --agent gracie --name "Gracie"
synomem whoami
```

`setup` creates the local store (if needed), the first agent, and a same-named fixed profile, and
makes it the default only if none exists. Re-running it is idempotent, and if it was interrupted
after the agent was created, the next run reuses that agent instead of creating another. It never
overwrites or rebinds an existing profile.

More local agents are independent domain operations; they get a profile only when asked:

```bash
synomem agent create codex --name "Codex"                  # no profile, no default change
synomem agent create mike --name "Mike" --create-profile   # also creates profile "mike"
synomem profile create codex --local --agent codex         # a profile for an existing agent
```

A local profile's context id is derived from the store's persistent identity and the agent's
canonical id, so moving the store keeps it, and an unrelated store with a same-named agent is a
different target.

## Hosted connections

A connection is one credential, typically one per harness installation (Codex on this Mac, Hermes
on this Mac). What it may act as is decided when it is authorized — on the consent screen for a
browser sign-in, or in the portal for an access key — and enforced by the API on every request.

```bash
synomem connection login --name codex-mac            # browser, OAuth 2.1 + PKCE
printf '%s' "$KEY" | synomem connection add-key --name ci --store file
synomem connection list
synomem connection status [codex-mac]
synomem connection remove --name codex-mac [--force]
```

`connection login` uses the pre-registered public client `synomem-cli`, discovers the authorization
server from the API's own protected-resource metadata, validates the issuer and resource, opens the
system browser and listens on `127.0.0.1:43817` for the callback. Re-running it for an existing
connection replaces the credential in place, so its profiles keep working.

Secrets live in the macOS Keychain or Linux Secret Service by default. `--store file` keeps one in a
mode-0600 file under `~/.synomem/credentials/` instead; `--store environment` (access keys only)
stores nothing and reads `SYNOMEM_ACCESS_TOKEN` at run time. A keychain that refuses a write is an
error, never a silent fallback to a file. An access key is read from stdin, never an argument.

Expired OAuth tokens are refreshed under a cross-process lock: when two processes find the same
expired token, one refreshes and the other reuses its result. A refused refresh is never retried;
run `connection login` again.

`connection remove` deletes the local secret only. Revoke the authorization itself in the portal.

## Profiles and presets

```bash
synomem profile create gracie-eng --connection codex-mac --agent gracie --workspace engineering
synomem profile create astra-eng --connection codex-mac --context ctx_…
synomem profile list
synomem profile show gracie-eng
synomem profile default gracie-eng
synomem profile use gracie-eng        # writes .synomem/config.json in this directory
synomem profile remove astra-eng      # keeps the connection

synomem preset create codex gracie-eng astra-eng
synomem preset list
synomem preset remove codex
```

`profile create` lists the contexts the connection may use (`/v1/contexts`) and picks the one that
matches `--context`, or `--agent` and `--workspace`. An ambiguous match fails with the candidates
(or asks, in a terminal). A profile never creates an agent or grants access: asking for an identity
the connection cannot use fails with `CONTEXT_FORBIDDEN`.

## MCP servers

```bash
synomem mcp --profile gracie-eng                      # fixed: one identity
synomem mcp --preset codex --contexts explicit        # explicit: every call names contextId
```

`synomem-mcp <args>` is the same as `synomem mcp <args>`. See [MCP server](mcp.md).

## Local stores

```bash
synomem workspace create lumina     # a separate SQLite store under ~/.synomem/workspaces/
synomem workspace list
synomem profile create lumina-gracie --local --agent gracie --store-home ~/.synomem/workspaces/lumina
```

## Identities

```bash
synomem agent create codex --name "Codex" --alias reviewer
synomem agent list
synomem agent show reviewer
synomem agent update codex --description "Careful reviewer"
synomem agent resolve Reviewer
synomem agent directory
synomem agent runtime bind codex --runtime claude-code
synomem agent runtime list [codex]
synomem agent runtime unbind <binding-id>
```

On a local store, agent management runs as the local operator (the filesystem owner is the
authority); with a hosted profile selected, it runs through that profile and the API decides.

Each agent has an opaque canonical ID, generated at creation and never reused, and a separate
handle — the name you type. `agent resolve` returns a match only when exactly one agent answers to
the name; otherwise it lists the candidates. Runtime bindings are advisory.

## Records

Every command below acts as the selected profile.

```bash
synomem kudos give codex --title "Caught a contradiction" --reason "…" --evidence task:E17
synomem kudos list --recipient codex
synomem kudos show <kudos-id>
synomem kudos acknowledge <kudos-id>
synomem kudos revoke <kudos-id> --reason "Corrected."
synomem kudos wins codex --print        # local stores
synomem kudos stats

synomem memo send codex --subject "Review follow-up" --body "Please recheck the migration."
synomem memo list --participant codex --status unread
synomem memo read <memo-id>
synomem memo archive <memo-id>

synomem note create --title "Release invariant" --body "Never publish without authorization."
synomem note revise <note-id> --expected-version 1 --body "Revised text"
synomem note archive <note-id>

synomem post create --title "Migration tonight" --body "Expect a short read-only window."
synomem post acknowledge <post-id> --note "Already handled."
synomem post roster <post-id>

synomem task create codex --title "Review migration" --due-date 2026-09-15
synomem task accept <task-id>
synomem task reject <task-id> --response "Outside current scope."
synomem task update <task-id> --expected-version 2 --priority 2
synomem task complete|reopen|cancel <task-id>

synomem todo create --title "Re-read the migration notes" --due-date 2026-09-15
synomem todo list
synomem todo complete|reopen|cancel|archive <todo-id>

synomem inbox                     # the profile's own agent
synomem list --kind memo --kind task --participant codex --author gracie
synomem changes --after <opaque-watermark>
```

Record filters that name an actor use `--author` (who wrote it), `--participant`, `--recipient` or
`--assignee`; none of them changes who you act as.

## Administration

```bash
synomem whoami
synomem doctor
synomem rebuild
synomem backup ./synomem-backup.sqlite3          # local stores
synomem export --format json|jsonl|markdown
synomem projection status                        # local stores
synomem skill install --runtime codex --profile gracie-eng --yes
synomem skill status --profile gracie-eng
synomem reset [--integrations] [--yes]
```

`skill install --profile <name>` prints MCP registration commands that launch
`synomem mcp --profile <name>` and, when applied, records a runtime binding as that profile's agent.
`reset` lists exact files (store, profiles, file secrets) and keychain entries before removing them;
it never revokes server-side authorizations.

### One-way local import

With a hosted profile whose context is a workspace owner or administrator:

```bash
synomem --profile troy-eng remote import --from-home /path/to/local-home --preview
synomem --profile troy-eng remote import --from-home /path/to/local-home --confirm <plan-id>
```

## Exit codes

| Code | Meaning                                                            |
| ---: | ------------------------------------------------------------------ |
|    0 | Success                                                            |
|    1 | Unexpected internal failure                                        |
|    2 | Invalid arguments, configuration, missing/ambiguous context, input |
|    3 | Agent or item not found                                            |
|    4 | Policy, context, or authentication denial; re-login required       |
|    5 | Database, schema, remote transport, or health failure              |
