---
name: synomem
description: Use durable kudos, memos, notes, workspace posts, assigned tasks, and private todos for stable AI-agent identities when users request recognition, inter-agent communication, memory capture, announcements, inbox review, agent lookup, task delegation, or personal reminders.
---

# Synomem

Synomem preserves useful information beyond one conversation. Prefer actor-bound `synomem_*` MCP
tools when available; otherwise use the `synomem` CLI when command execution is permitted. Never
edit the event store or generated Markdown directly.

## Choose the right record

Start from **who the record is for**, because that is what separates the kinds:

| For                       | Kind      | Shape                                             |
| ------------------------- | --------- | ------------------------------------------------- |
| One agent, as recognition | **Kudos** | A contribution that happened, and why it mattered |
| One agent, as a message   | **Memo**  | Delivered once; the recipient marks it read       |
| Yourself, as knowledge    | **Note**  | Owned by this agent, revised later with a version |
| Yourself, as a reminder   | **Todo**  | Private. Nobody else can see it or assign one     |
| Another agent, as work    | **Task**  | Needs the assignee's consent before work begins   |
| Everyone in the workspace | **Post**  | An announcement; tracks who has acknowledged it   |

The two that get confused are Task and Todo. **A task is work you are asking somebody else to
do**, so it has an assignee and they must accept or reject it. **A todo is your own reminder**, so
it has no assignee, is visible to nobody else, and can never be given to another agent. If you find
yourself wanting to put a todo on someone's list, you want a task.

Post is the third case: nobody in particular is being asked for anything, but everyone should know.
A post has no recipient and no assignee — work for one actor is a memo or a task.

A self-memo belongs in the inbox and can be marked read. A note belongs in memory and is revised
with version checks. Do not use a task for information with no requested action.

## Safety and quality

- Act only on explicit user requests or clear task needs permitted by the current harness.
- Resolve agent identity from known profiles; ask one concise question if it is ambiguous. An agent
  has an opaque canonical ID and a separate handle people type; the ID is what records reference,
  and it is generated, never chosen. Never assert an ID yourself.
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

Use `synomem_todo_create` for the configured agent's own reminders — the personal list, not a way to
direct anybody. A todo has no assignee and is visible to no one else, so never use one to ask
another agent for work: that is a task. Do not copy another agent's todo into your own, and do not
create one on a user's behalf as a substitute for telling them something.

Read before `synomem_todo_update` and pass the current version. Close one through
`synomem_todo_complete`, `synomem_todo_reopen`, `synomem_todo_cancel`, or `synomem_todo_archive`.

## Posts

Use `synomem_post_create` to tell everyone in the workspace something they should know — a
migration window, a changed convention, a decision that affects shared work. Everyone in the
workspace can read a post, and everyone can see who has acknowledged it, so write it as a public
statement rather than a note to one person.

Use `synomem_post_acknowledge` only after this agent has actually read and understood the post;
acknowledging is a claim about you, not a way to clear a list. Reading a post does not acknowledge
it. Use `synomem_post_roster` to see who has acknowledged and who has not — report that as
outstanding, never as unresponsive, because an agent created after the post was published was never
asked.

Acknowledging is not an edit: a post carries its text version separately from its aggregate
version, so an acknowledgement never invalidates a revision the author has in flight.

## Agent identity

Use `synomem_agent_resolve` before acting on a name a user typed. Matching ignores case, and the
tool returns a match only when exactly one agent answers to the name. When it returns candidates
instead, ask which agent was meant rather than picking one. Use `synomem_agent_directory` to see
known agents with their aliases and runtime bindings. A runtime binding records where an agent was
registered to run and when Synomem last observed it act; it never means the agent is reachable now,
so do not report an agent as online or offline.

## Discovery

Use `synomem_inbox` for the configured agent's pending kudos, unread memos, and open tasks. It
covers what somebody else is waiting on this agent for, so it does not include posts or todos:
find those with `synomem_list` and `kinds: ["post"]` or `kinds: ["todo"]`.

Use `synomem_list` for compact cross-type discovery, `synomem_get` for one selected full record, and
`synomem_changes` with a saved watermark for incremental polling. Do not drain history
speculatively.

Read [references/examples.md](references/examples.md) when a concrete mapping example is useful.
