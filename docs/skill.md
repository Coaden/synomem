---
layout: default
title: Agent skill
---

# Agent skill

The distributable skill lives at [`skills/synomem`](https://github.com/Coaden/synomem/blob/main/skills/synomem/SKILL.md) and is included in the npm tarball. It teaches skill-aware agents when durable recognition is appropriate, how to use MCP or CLI, how to sanitize evidence, and how to retry safely.

## Repository-local installation

Copy or link the skill into the runtime-specific repository skill directory. This keeps setup reviewable and scoped to one project.

```text
<repository>/.codex/skills/synomem/SKILL.md
<repository>/.claude/skills/synomem/SKILL.md
```

## User installation

The CLI verifies and manages these user-level layouts:

| Runtime     | Skill destination            | Home override                  |
| ----------- | ---------------------------- | ------------------------------ |
| Claude Code | `~/.claude/skills/synomem`   | `CLAUDE_CONFIG_DIR`            |
| Codex       | `~/.codex/skills/synomem`    | `CODEX_HOME`                   |
| Hermes      | `~/.hermes/skills/synomem`   | `HERMES_HOME` (active profile) |
| OpenClaw    | `~/.openclaw/skills/synomem` | `OPENCLAW_STATE_DIR`           |
| Cursor      | `~/.cursor/skills/synomem`   | —                              |
| Grok Build  | `~/.grok/skills/synomem`     | `GROK_HOME`                    |

These locations follow the current vendor documentation for [Claude Code](https://code.claude.com/docs/en/skills), [Cursor](https://cursor.com/docs/skills), [Hermes](https://hermes-agent.nousresearch.com/docs/user-guide/features/skills), [OpenClaw](https://docs.openclaw.ai/skills), and [Grok Build](https://docs.x.ai/build/features/skills-plugins-marketplaces). Codex uses its native `$CODEX_HOME/skills` convention.

```bash
synomem skill install                                      # dry-run every detected runtime
synomem skill install --runtime codex --yes                # install one copied skill
synomem skill install --runtime claude --link --yes         # explicit package-linked install
synomem skill install --runtime hermes --yes                # active HERMES_HOME profile
synomem skill install --runtime openclaw --yes              # active OpenClaw state directory
synomem skill install --runtime cursor --yes
synomem skill install --runtime grokbot --yes                # alias for grok
synomem skill status
synomem skill uninstall --runtime claude                    # dry-run removal
synomem skill uninstall --runtime claude --yes
```

Bare `install` and `uninstall` commands are dry runs. The installer applies only with `--yes`, only when the runtime home already exists, and only to its `skills/synomem` child. Copies carry an ownership/version stamp so `status` can report stale installations after npm updates. Existing unowned directories are conflicts and require explicit `--force`; unrelated sibling skills are never touched.

Copy mode is the stable default. `--link` points at the skill inside the installed npm package, which updates with an in-place global package upgrade but may break if that package moves. Run `status` after package updates either way.

Copied bundles preserve the packaged file modes so executable helper scripts remain executable.
Skill content is operational guidance rather than confidential Synomem data and does not use the
database and projection file-mode policy. The Synomem ownership/version stamp is restricted to the
local user where POSIX modes are available.

Add identity options to print a ready-to-review actor-bound MCP command for Codex, Claude Code,
Hermes, OpenClaw, or Grok Build:

```bash
synomem skill install --runtime codex --actor-id codex --actor-name "Codex"
synomem skill install --runtime claude --actor-id claude --actor-name "Claude"
synomem skill install --runtime openclaw --actor-id mycroft --actor-name "Mycroft"
```

Cursor discovers skills automatically but currently requires MCP definitions in its global
`~/.cursor/mcp.json` or project `.cursor/mcp.json`. Merge a `synomem` entry without replacing other
servers. Use `synomem-mcp` as the command and pass `--actor-id`, `--actor-kind agent`, and
`--actor-name` as arguments. The installer deliberately does not rewrite shared JSON configuration.

Global skill installation changes agent configuration and is always an explicit user action. Synomem has no postinstall script and never modifies those directories implicitly.

## MCP and skill roles

The skill guides agent decisions; the MCP server performs and enforces operations. Install both for the best experience:

1. Install `synomem`.
2. Create stable profiles with the human CLI.
3. Register one actor-bound MCP process per runtime.
4. Install the skill where that runtime discovers skills.

When MCP is unavailable, the skill permits using the local `synomem` CLI if command execution is allowed.

## Runtime boundaries

All supported installers target local filesystem runtimes. A hosted Grok Bot does not automatically
share the desktop's `~/.agents` database. It can use Synomem only if its persistent machine supports
Node.js, local stdio MCP, and its own durable Synomem home. Otherwise give it the public
[`SKILL.md`](https://github.com/Coaden/synomem/blob/main/skills/synomem/SKILL.md) as guidance and do
not tunnel or copy the live SQLite database.

Other harnesses may use the same Agent Skills format, but Synomem does not write to an unverified
directory. Inspect authoritative documentation or a real installation before copying the packaged
skill or configuring MCP.
