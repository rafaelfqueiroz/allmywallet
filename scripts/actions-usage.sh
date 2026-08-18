#!/usr/bin/env bash
# Month-to-date Actions consumption against the free tier: ./scripts/actions-usage.sh [YYYY-MM]
#
# The free tier on a private repository is 2.000 minutes/month. This project has
# come close to it once (1.687 minutes by 2026-08-18) and the cause was volume,
# not any single slow run: every push to a PR branch fans out to eight jobs for
# roughly 14 minutes, and every merge to main costs that again plus the deploy.
#
# The billing REST endpoint needs the `user` OAuth scope, which `gh` here does
# not carry, so this reconstructs the figure from the runs themselves — the same
# arithmetic as ci-minutes.sh, over a whole month.
set -euo pipefail

repo="${REPO:-rafaelfqueiroz/allmywallet}"
month="${1:-$(date -u +%Y-%m)}"
tier="${TIER_MINUTES:-2000}"

echo "Actions usage for ${repo}, ${month} (free tier: ${tier} min)"
echo "Collecting runs — one API call per run, so this takes a moment..."

gh api "/repos/${repo}/actions/runs" --paginate \
  -q '.workflow_runs[] | [.id, .name, .created_at] | @tsv' |
  grep -F "	${month}-" |
  while IFS=$'\t' read -r id name created; do
    gh api "/repos/${repo}/actions/runs/${id}/jobs" --paginate \
      -q ".jobs[] | [\"${name}\", \"${created}\", .name, .started_at, .completed_at] | @tsv" 2>/dev/null || true
  done |
  python3 -c '
import sys, math, datetime, collections, os

tier = int(os.environ.get("TIER_MINUTES", "2000"))
total = 0
by_workflow, by_job, by_day = collections.Counter(), collections.Counter(), collections.Counter()

for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 5 or not parts[3] or not parts[4]:
        continue
    started = datetime.datetime.fromisoformat(parts[3].replace("Z", "+00:00"))
    ended = datetime.datetime.fromisoformat(parts[4].replace("Z", "+00:00"))
    minutes = math.ceil((ended - started).total_seconds() / 60)
    total += minutes
    by_workflow[parts[0]] += minutes
    by_job[parts[2]] += minutes
    by_day[parts[1][:10]] += minutes

remaining = tier - total
print(f"\n  {total:5d} min used, {remaining:5d} left ({total * 100 // tier}% of tier)\n")
print("  by workflow:")
for name, minutes in by_workflow.most_common():
    print(f"    {minutes:5d}  {name}")
print("\n  most expensive jobs:")
for name, minutes in by_job.most_common(5):
    print(f"    {minutes:5d}  {name}")
print("\n  heaviest days:")
for day, minutes in sorted(by_day.items(), key=lambda item: item[1], reverse=True)[:5]:
    print(f"    {minutes:5d}  {day}")
'
