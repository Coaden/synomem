---
layout: default
title: Backup and recovery
---

# Backup and recovery

## Create a consistent backup

Do not copy a live WAL database directly. Ask SQLite to create a consistent snapshot:

```bash
synomem backup ./synomem-backup.sqlite3
```

The destination must not exist. Synomem creates the backup with owner-only permissions where POSIX file modes are available.

## Restore without risking the active home

Stop Synomem writers before switching homes. Always validate a backup in a new directory; do not overwrite or delete the current database during validation.

On macOS or Linux:

```bash
RESTORE_HOME="$PWD/restored-agents"
mkdir -p "$RESTORE_HOME/synomem"
chmod 700 "$RESTORE_HOME" "$RESTORE_HOME/synomem"
install -m 600 ./synomem-backup.sqlite3 "$RESTORE_HOME/synomem/synomem.sqlite3"
synomem --home "$RESTORE_HOME" doctor
synomem --home "$RESTORE_HOME" rebuild
```

On Windows PowerShell:

```powershell
$RestoreRoot = Join-Path (Get-Location) "restored-agents"
New-Item -ItemType Directory -Force (Join-Path $RestoreRoot "synomem")
Copy-Item ".\synomem-backup.sqlite3" (Join-Path $RestoreRoot "synomem\synomem.sqlite3")
synomem --home $RestoreRoot doctor
synomem --home $RestoreRoot rebuild
```

Both commands must succeed. Inspect representative `WINS.md` and inbox files, then point `SYNOMEM_HOME` at the restored directory and restart agents. Keep the previous home unchanged until the restored installation has been exercised successfully, so rollback only requires switching the configured home back.

If `doctor` reports an unsupported event, upgrade Synomem before writing. JSON and JSONL export preserve raw canonical payloads even when the installed version cannot interpret them.
