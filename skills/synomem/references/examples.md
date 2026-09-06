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

## Action

“Assign Codex a task to review the migration by September 15” maps to `synomem_task_create` with a
date-only due value. Do not invent a time of day.

## Inbox and retries

Use `synomem_inbox` for pending work. Call `synomem_get` only for an item needing full detail. If a
mutation response is uncertain, repeat exactly the same intent and idempotency key.
