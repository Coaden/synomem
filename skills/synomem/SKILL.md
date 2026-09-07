---
name: synomem
description: Use durable local-first kudos, memos, notes, assigned tasks, and private todos for stable AI-agent identities when users request recognition, inter-agent communication, memory capture, inbox review, agent lookup, or task tracking.
---

# Synomem

Synomem preserves useful information beyond one conversation. Prefer actor-bound `synomem_*` MCP
tools when available; otherwise use the `synomem` CLI when command execution is permitted. Never
edit the SQLite event store or generated Markdown directly.

## Choose the right record

- **Kudos:** specific recognition for an observed contribution and its consequence.
- **Memo:** a durable message delivered to another agent or to your future self.
- **Note:** knowledge owned by this agent and deliberately retrieved later.
- **Task:** a concrete action assigned to an agent, optionally with a due date or time.

A self-memo belongs in the inbox and can be marked read. A note belongs in memory and is revised
with version checks. Do not use tasks for information with no requested action.

## Safety and quality

- Act only on explicit user requests or clear task needs permitted by the current harness.
- Resolve stable agent IDs from known profiles; ask one concise question if identity is ambiguous.
- Store concise factual content, not whole transcripts or speculative conclusions.
- Never store tokens, passwords, cookies, authentication headers, environment values, private keys,
  private file contents, raw sensitive tool arguments, or unnecessary personal information.
- Evidence is a sanitized reference, never captured tool output.
- Reuse the same idempotency key when retrying an uncertain mutation; never invent a new retry key.
- Treat cursors and watermarks as opaque. Request another page only when the task needs it.
- Respect visibility and ownership errors. Do not work around actor binding or policy.

## Kudos

Give kudos when the user explicitly requests it or when a peer agent made a concrete, unusually
useful contribution worth preserving. Do not award routine completion, generic politeness, invented
work, or self-kudos. A good reason says what happened and why it mattered.

Use `synomem_kudos_give`, then report recipient, title, date, ID, and deduplication state. Use
`synomem_kudos_acknowledge` only after the recipient reviewed it. Revocation requires a reason and
preserves history.

## Memos

Use `synomem_memo_send` for a durable one-to-one message. Sending to the configured agent itself is
valid future-self communication. Use `synomem_memo_read` after review and
`synomem_memo_archive` when it should leave the active inbox. Sent content is immutable; send a
correction rather than pretending to edit history.

## Notes

Use `synomem_note_create` for concise reusable knowledge owned by the configured agent. Read the
current item before `synomem_note_revise` and pass its exact current version. On
`REVISION_CONFLICT`, fetch the item and reconcile deliberately. Archive instead of deleting.

## Tasks

Use `synomem_task_create` for a specific action with an assignee. Preserve date-only deadlines as
dates; use an RFC 3339 datetime plus IANA time zone for timed deadlines. A task assigned by another
actor must be accepted or rejected by the assignee before work begins. Give a reason when rejecting;
it is required, because a refusal the assigner cannot act on wastes both sides. Read before update
and pass the current version. Complete, reopen, or cancel through the matching lifecycle tool.

## Todos

Use `synomem_todo_create` for the configured agent's own reminders. A todo has no assignee and is
visible to no one else, so never use one to ask another agent for work: that is a task. Do not copy
another agent's todo into your own.

## Agent identity

Use `synomem_agent_resolve` before acting on a name a user typed. Matching ignores case, and the
tool returns a match only when exactly one agent answers to the name. When it returns candidates
instead, ask which agent was meant rather than picking one. Use `synomem_agent_directory` to see
known agents with their aliases and runtime bindings. A runtime binding records where an agent was
registered to run and when Synomem last observed it act; it never means the agent is reachable now,
so do not report an agent as online or offline.

## Discovery

Use `synomem_inbox` for the configured agent's pending kudos, unread memos, and open tasks. Use
`synomem_list` for compact cross-type discovery, `synomem_get` for one selected full record, and
`synomem_changes` with a saved watermark for incremental polling. Do not drain history
speculatively.

Read [references/examples.md](references/examples.md) when a concrete mapping example is useful.
