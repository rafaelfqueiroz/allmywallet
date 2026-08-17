#!/usr/bin/env bash
# Create the deferred-work tickets and ensure they are on project board 3.
#
# Idempotent: skips any ticket whose title already exists, and only adds to the
# board if not already present (the board has an auto-add workflow).
#
# Bodies are written to files and passed with --body-file rather than built with
# $(cat <<EOF ...) — macOS ships bash 3.2, which mis-parses heredocs nested
# inside command substitution.
set -euo pipefail

REPO="rafaelfqueiroz/allmywallet"
PROJECT_OWNER="rafaelfqueiroz"
PROJECT_NUMBER=3
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# ---------- preflight ----------
if ! ACTIVE=$(gh api user --jq .login 2>/dev/null); then
  echo "✗ gh cannot authenticate (no stored credential, or keychain unreadable)."
  echo "  Run: gh auth login --hostname github.com --scopes project"
  exit 1
fi
if [[ "$ACTIVE" != "$PROJECT_OWNER" ]]; then
  echo "✗ Authenticated as '$ACTIVE', expected '$PROJECT_OWNER'."
  echo "  Run: gh auth switch --user $PROJECT_OWNER"
  exit 1
fi
if ! PROJECT_TITLE=$(gh api graphql -f query="query{ user(login:\"$PROJECT_OWNER\"){ projectV2(number:$PROJECT_NUMBER){ title } } }" --jq '.data.user.projectV2.title' 2>/dev/null); then
  echo "✗ Cannot read project $PROJECT_NUMBER — missing 'project' scope."
  echo "  Run: gh auth refresh --scopes project"
  exit 1
fi
echo "✓ $ACTIVE → board \"$PROJECT_TITLE\" (#$PROJECT_NUMBER)"
echo

# ---------- labels (idempotent) ----------
gh label create "deferred"       --repo "$REPO" --color "fbca04" --description "Decided but not built; has a trigger" --force >/dev/null 2>&1 || true
gh label create "infrastructure" --repo "$REPO" --color "0e8a16" --description "Hosting, backups, observability"      --force >/dev/null 2>&1 || true

# ---------- bodies ----------
cat > "$TMP/bl-001.md" <<'BODY'
**Status:** deferred. **Provider decided: Cloudflare R2. Frequency: weekly.**

## Trigger

**Before the first non-test user account exists.**

Not "before launch", not "before M6" — before one real person's data lands in the database. This is deliberately earlier than the M6 milestone SPEC-016 BR-016-09 would suggest, because the risk begins with the first user, not with general availability.

## Why deferring is safe right now

There is no production data. No users, no deploy, nothing to lose. Building backup infrastructure before the thing being backed up exists is work with no return.

## Why it stops being safe, precisely

The moment one real user imports one real B3 extract. From that instant a disk failure or a bad migration destroys financial records the user cannot reconstruct — their broker keeps the trades, but not the wallet structure, the manual entries, the reconciliation adjustments, or the corrections they made. That data exists only here.

## What is already decided

| | |
|---|---|
| Provider | **Cloudflare R2** (S3-compatible, zero egress) |
| Frequency | **Weekly** — accepts up to 7 days' data loss; see SPEC-016 DL-016-08 |
| Mechanism | `pg_dump` (custom format, compressed), `age`-encrypted client-side before upload |
| Retention | 30 days, enforced by **bucket lifecycle rule** — not a cron job |
| Credentials | **Write-only** on the VPS; restore credentials held separately, off the box |
| Immutability | Object lock for the retention window |
| Alerting | A failed upload raises an alert — a silent backup failure is indistinguishable from having no backups |
| Verification | Quarterly restore drill: restore locally, verify row counts, confirm deleted-user data is absent |

Full requirements: `docs/guidelines/ARCHITECTURE.md` §15 (AR-60–AR-66).

## Consequences that travel with this

- **R2 is outside Brazil**, so the dump is an international transfer under LGPD Art. 33. Permitted with standard contractual clauses and a DPA, but it must appear in the privacy policy and subprocessor inventory (SPEC-004 BR-004-18). **That work lands in M6 regardless of when backups are built.**
- **Two specs cannot be marked complete until this ships:** SPEC-016 BR-016-09/10 and SPEC-004 BR-004-16 — the latter's "one backup cycle" is now a **week**, and that is the figure the privacy policy must state.
- **The restore drill is also the migration rehearsal** (AR-65). With no staging environment (BL-003), restoring production locally is the only realistic way to test a risky migration. Until this ships, migrations rehearse against seeded data — which has neither production's shape nor its volume.
- **Hostinger's included weekly backups are not this.** They now match the frequency, but are not restore-tested, not verified against BR-004-16, and not under your control. A fortunate second copy, not a plan.

## Definition of done

- [ ] Weekly `pg_dump` job runs on the VPS
- [ ] Dump encrypted with `age` before upload
- [ ] R2 bucket created with 30-day lifecycle expiry rule
- [ ] Write-only credentials on the VPS; restore credentials stored off-box
- [ ] Object lock enabled for the retention window
- [ ] Upload failure raises an alert
- [ ] One full restore drill executed and documented
- [ ] Restore drill confirms deleted-user data absent (SPEC-004 BR-004-16)
BODY

cat > "$TMP/bl-002.md" <<'BODY'
**Status:** deferred to M4. **Undecided:** self-hosted vs managed.

## Trigger

**M4**, when the worker and quote budget exist.

Before then there are no background jobs to graph, and Sentry + Pino + Uptime Kuma answer every question that will actually come up. Standing up ~1.5 GB of monitoring to watch a system with no background jobs is cost with no return.

## What this would give

Trends and thresholds rather than events. Sentry tells you a job threw; metrics tell you the quote-budget burn rate projects to exhaustion on the 22nd, that job queue depth has climbed for three days, that report p95 crept from 1.2s to 2.8s over a month.

SPEC-008 BR-008-21's "projected month-end burn visible to operators" is, concretely, a Prometheus query.

## The decision to make at M4

| Option | Cost |
|---|---|
| **Self-host** OpenTelemetry collector + Prometheus + Grafana | ~1.5 GB RAM on an 8 GB box, two more services to operate |
| **Grafana Cloud free tier** (10k series) | One more subprocessor; operational metrics leave the box (metrics, not personal data) |

On Hostinger KVM 2 (8 GB) the managed option is attractive — it recovers ~1.5 GB and removes two services from the box.

## Metrics worth having when this lands

- Provider request budget consumed and projected month-end burn (SPEC-008)
- Job queue depth and failure rate
- Report render p95
- Import duration

Reference: `docs/guidelines/ARCHITECTURE.md` §12 (AR-48–AR-51).
BODY

cat > "$TMP/bl-003.md" <<'BODY'
**Status:** deliberately not built. Production is the only deployed environment; migrations rehearse locally.

## Trigger

**A second developer joins**, or **the first time a migration causes a production incident** — whichever comes first.

## The consequence already absorbed

Expand/contract schema changes are **mandatory, not optional** (AR-69). Every migration must be safe to deploy alongside the previous version of the code, and safe to roll back to. That discipline is what substitutes for the missing safety net.

Migrations are rehearsed against a restored production backup, locally (AR-68) — which is why the restore drill in BL-001 carries double duty. Until BL-001 ships there is no such backup, so rehearsal runs against seeded data and carries less assurance.

## If this is revisited

Options, cheapest first:

1. Second Docker Compose stack on the same VPS, separate database — nearly free, shares hardware, not a true infrastructure rehearsal
2. Separate small VPS — genuine isolation and a real deployment rehearsal, roughly doubles hosting cost and patching surface

Reference: `docs/guidelines/ARCHITECTURE.md` §16 (AR-67–AR-70).
BODY

# ---------- create, skipping any that already exist ----------
EXISTING=$(gh issue list --repo "$REPO" --state all --limit 200 --json title --jq '.[].title')

url_for() {
  gh issue list --repo "$REPO" --state all --limit 200 --json title,url \
    --jq ".[] | select(.title==\"$1\") | .url"
}

create_or_skip() {
  local key="$1" title="$2" bodyfile="$3"
  if printf '%s\n' "$EXISTING" | grep -Fqx "$title"; then
    echo "  = $key exists already" >&2
    url_for "$title"
  else
    echo "  + $key created" >&2
    gh issue create --repo "$REPO" --title "$title" --label "deferred,infrastructure" --body-file "$bodyfile"
  fi
}

U1=$(create_or_skip "BL-001" "BL-001 — Backups to Cloudflare R2"                  "$TMP/bl-001.md")
U2=$(create_or_skip "BL-002" "BL-002 — Metrics stack: self-host vs Grafana Cloud" "$TMP/bl-002.md")
U3=$(create_or_skip "BL-003" "BL-003 — Staging environment"                       "$TMP/bl-003.md")

# ---------- ensure on board ----------
echo
ON_BOARD=$(gh project item-list "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --format json --limit 200 \
           | python3 -c 'import sys,json;[print(i.get("content",{}).get("url","")) for i in json.load(sys.stdin).get("items",[])]')

for U in "$U1" "$U2" "$U3"; do
  [ -z "$U" ] && continue
  if printf '%s\n' "$ON_BOARD" | grep -Fqx "$U"; then
    echo "  = already on board: $U"
  else
    gh project item-add "$PROJECT_NUMBER" --owner "$PROJECT_OWNER" --url "$U" >/dev/null
    echo "  + added to board:   $U"
  fi
done

echo
echo "Board: https://github.com/users/$PROJECT_OWNER/projects/$PROJECT_NUMBER/views/1"
