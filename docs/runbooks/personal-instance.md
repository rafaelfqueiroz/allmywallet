# Personal instance

The personal production instance ([SPEC-021](https://github.com/rafaelfqueiroz/allmywallet/wiki/SPEC-021-Personal-Deployment), ARCHITECTURE AR-71–AR-75). It holds the **only copy** of manual entries, wallets, allocations, typed rates and reconciliation adjustments. Nothing here is disposable.

## Before anything

- FileVault is on. `init.sh` refuses otherwise.
- A **separate drive** for backups, and an `age` identity kept **off the laptop**: `age-keygen -o /Volumes/<somewhere safe>/allmywallet.age-identity` prints the public key for `BACKUP_AGE_RECIPIENT`.
- Raw B3 extracts live outside the repository — `~/Documents/allmywallet-extracts/`, say — never under the working tree (DV-24, TS-19, BR-021-37). Delete each one after importing it.
- **Never source the personal env file in a development shell.** The refusal guard is the second barrier, not the first.

## First run

```bash
scripts/personal/init.sh
```

1. The first run writes two files with generated secrets and stops: `~/.config/allmywallet/personal.env`, what web and worker run with; and `migrator.env` beside it, the migrator credential, which only the scripts read and no running container ever sees.
   Running `init.sh` again after that refuses; upgrades belong to `start.sh`, which backs up first.
2. Fill in `AUTH_GOOGLE_ID`, `AUTH_GOOGLE_SECRET`, `BACKUP_DIR`, `BACKUP_AGE_RECIPIENT` and `PGDATA_HOST_PATH`. Register `http://localhost:3100/api/auth/callback/google` on the Google OAuth client.
3. Run it again. It pulls the image, migrates, sets the database marker, takes the first backup and starts everything at <http://localhost:3100>.

Real email: set `RESEND_API_KEY` and `EMAIL_FROM` in the env file, and the deployment-level config key `notifications.email_provider` to `resend`.

## Every day

Nothing to do: `init.sh` installs a launchd agent (`~/Library/LaunchAgents/com.allmywallet.personal.plist`) that runs `scripts/personal/start.sh` at login and daily at 09:00, logging to `~/Library/Logs/allmywallet-personal.log`. Web and worker no longer restart on their own when Docker starts, so every start goes through it. By hand:

```bash
scripts/personal/start.sh
```

Upgrades when `:latest` has moved (backup → pull → migrate → start → health check → last-known-good or rollback), takes the day's first backup, and starts the current image when the network is off. State lives in `~/.local/state/allmywallet/`.

## When something is wrong

| Symptom | Do |
|---|---|
| "Backup failed" notice in the app, or `backup` degraded in `/api/health` | Read the reason. Mount the drive, fix the path, run `scripts/personal/backup.sh`. The notice clears on the next success. |
| `start.sh` says the backup failed and the upgrade was aborted | The current image is running and nothing migrated. Fix the backup, run `start.sh` again. |
| `start.sh` says the migration failed | The current image is running; the migration transaction rolled back. Do not retry by hand — report the migration as a defect. |
| `start.sh` rolled back to last-known-good | The old image is running **on the new schema**. It will not retry that image (`failed-digest`). A later merge produces a new digest and is tried normally. |
| Last-known-good is not healthy either | Stop. Restore (below). |
| A holding reads zero after an upgrade whose migration deleted a position cache it could not replay (`0024`, [#136](https://github.com/rafaelfqueiroz/allmywallet/issues/136)) | Replay the ledger into the cache — it is authoritative, the cache is derived (SPEC-007 BR-007-14): `IMAGE_TAG=$(cat ~/.local/state/allmywallet/current-tag) docker compose -f docker-compose.personal.yml run --rm --no-deps -T web node dist/ops.js rebuild-positions`. It reports how many tenants disagreed with the ledger and writes the replayed figures. |

**Do not** run `docker compose down -v`, `pnpm db:*`, or any test suite with the personal env loaded.

## Restore drill — quarterly (BR-021-21)

```bash
scripts/personal/restore-drill.sh /Volumes/<safe>/allmywallet.age-identity
```

Restores the newest dump into a throwaway container with no network and compares every table's row count with the counts taken inside the dump's own snapshot. It never touches the personal database.

## Restoring for real

Deliberate and manual (SPEC-021 Out of Scope: no automatic restore).

1. `scripts/personal/backup.sh` — keep a copy of the broken state too.
2. Stop the app: `docker compose -p allmywallet-personal stop web worker`.
3. Decrypt and restore into the personal database with `pg_restore --clean --if-exists` through `docker compose -p allmywallet-personal exec -T postgres`.
4. A dump carries no database settings. **Re-apply the marker** before anything else touches it: `ALTER DATABASE allmywallet SET allmywallet.instance_role = 'personal';`
5. `scripts/personal/start.sh`.

## Known gaps

- Laptop and backup drive lost together lose everything (DL-021-02).
- Intraday opportunity alerts fire only while the laptop is awake (DL-021-03).
- The image is built for `linux/amd64`; on Apple Silicon it runs under emulation.
