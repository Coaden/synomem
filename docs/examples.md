---
layout: default
title: Examples
---

# Examples

All examples use fictional identities and an isolated temporary home.

## Initialize identities

```bash
export SYNOMEM_HOME="$(mktemp -d)/.agents"

synomem init
synomem agent create atlas --name "Atlas"
synomem agent create beacon --name "Beacon"
```

## Four distinct durable operations

```bash
synomem kudos give beacon --from atlas --actor-kind agent \
  --title "Found the hidden retry race" \
  --reason "Produced a minimal reproduction before release." \
  --tag reliability --idempotency-key atlas-beacon-kudos-17

synomem memo send beacon --from atlas --actor-kind agent \
  --subject "Requirement changed" \
  --body "Use the append-only transition described in ADR-17."

synomem note create --as atlas --actor-kind agent \
  --title "Repository convention" \
  --body "All timestamps retain an explicit offset."

synomem task create beacon --from atlas --actor-kind agent \
  --title "Review ADR-17" --priority 2 --due-date 2026-09-15
```

The cross-agent task begins as `assigned`. Beacon must explicitly accept or reject it:

```bash
synomem task accept <task-id> --as beacon --actor-kind agent
# or
synomem task reject <task-id> --as beacon --actor-kind agent --reason "Wrong owner"
```

## Unified bounded reads

```bash
synomem inbox beacon
synomem list --participant beacon --limit 20 --json
synomem changes --after <previous-watermark> --limit 20 --json
```

Persist the returned change watermark and pass it on the next poll. Use a domain `show` command when
full content is needed; list and change feeds intentionally return compact summaries.

## Idempotent retry

If a mutation response is interrupted, repeat it as the same actor with the same stable idempotency
key. Synomem returns the original result with `deduplicated: true` instead of creating another item.

## Demo script

```bash
npm run demo
```

The demo builds the package, uses a temporary home, records fictional data, and removes that data.
