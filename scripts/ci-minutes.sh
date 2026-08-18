#!/usr/bin/env bash
# Billable Actions minutes for one workflow run: ./scripts/ci-minutes.sh <run-id>
#
# **Wall-clock duration is not cost.** The runs list shows how long a run took
# start to finish, which includes queue wait, and queue wait is not billed. The
# CI run of 2026-08-18T02:17Z reads as 364 minutes there and cost 14 — mistaking
# one for the other sends you hunting a hang that never happened.
#
# So this sums the *jobs* endpoint, and rounds each job up to the whole minute,
# which is how GitHub bills. The `/timing` endpoint is not used: it reports zero
# on this repository.
set -euo pipefail

repo="${REPO:-rafaelfqueiroz/allmywallet}"
run="${1:?usage: ci-minutes.sh <run-id>}"

gh api "/repos/${repo}/actions/runs/${run}/jobs" --paginate \
  -q '.jobs[] | [.name, .conclusion, .started_at, .completed_at, (.steps | length)] | @tsv' |
  python3 -c '
import sys, math, datetime
total = 0
for line in sys.stdin:
    parts = line.rstrip("\n").split("\t")
    if len(parts) < 4 or not parts[2] or not parts[3]:
        continue
    # A job with no steps never ran — the runner refused it, which is what a
    # spent quota looks like. Billing it a minute would inflate the figure this
    # script exists to keep honest.
    if len(parts) > 4 and parts[4] == "0":
        label = "not started"
        print(f"     - min  {label:10s} {parts[0]}")
        continue
    started = datetime.datetime.fromisoformat(parts[2].replace("Z", "+00:00"))
    ended = datetime.datetime.fromisoformat(parts[3].replace("Z", "+00:00"))
    minutes = math.ceil((ended - started).total_seconds() / 60)
    total += minutes
    print(f"  {minutes:4d} min  {parts[1] or 'running':10s} {parts[0]}")
print(f"  {total:4d} min  TOTAL billable")
'
