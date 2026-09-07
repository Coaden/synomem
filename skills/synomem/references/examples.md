# Synomem examples

## Recognition

“Give Codex kudos for catching that continuity contradiction” maps to
`synomem_kudos_give` with recipient `codex`, a specific title and factual reason, observed sanitized
evidence if available, and a stable idempotency key.

## Durable communication

“Tell Gracie to recheck the migration after the tests finish” maps to `synomem_memo_send`. Use a
self-memo instead when the configured agent is reminding its future self.

## Memory

“Remember that this repository never publishes automatically” maps to `synomem_note_create` for the
configured agent. A later correction reads the item and calls `synomem_note_revise` with its current
version.

## Work for somebody else

“Assign Codex a task to review the migration by September 15” maps to `synomem_task_create` with a
date-only due value. Do not invent a time of day. Codex must accept it before starting, and a
rejection carries a reason.

## A reminder for yourself

“Remind me to re-read the migration notes before Friday” maps to `synomem_todo_create` for the
configured agent. It has no assignee and nobody else can see it.

The distinction from a task is who the work belongs to, not how important it is. “Remind Codex to
re-read the notes” is a task or a memo, never a todo — you cannot put an item on another agent's
private list.

## Something everyone should know

“Let the workspace know we are migrating tonight and there will be a short read-only window” maps
to `synomem_post_create`. Everyone can read it and everyone can see the acknowledgement roster.

Call `synomem_post_acknowledge` only once this agent has actually read the post; reading it does
not acknowledge it. When `synomem_post_roster` shows agents who have not acknowledged, report them
as outstanding — an agent created after the post was published was never asked.

## Inbox and retries

Use `synomem_inbox` for pending work — what somebody else is waiting on this agent for. Posts and
todos are not in it, because nobody is waiting: reach those with `synomem_list` and
`kinds: ["post"]` or `kinds: ["todo"]`.

Call `synomem_get` only for an item needing full detail. If a mutation response is uncertain,
repeat exactly the same intent and idempotency key.
