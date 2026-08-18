#!/usr/bin/env bash
# Watch a PR's checks to completion: ./scripts/ci-watch.sh <pr-number> [ceiling-minutes]
#
# Opening a PR or pushing to one costs roughly 14 billable minutes across eight
# parallel jobs, against a 2.000-minute monthly tier this project has already run
# close to. So a push is worth watching rather than firing and forgetting: a run
# nobody is looking at spends the budget silently, and a green local gate is not
# evidence that CI agreed.
#
# Past the ceiling the run is **cancelled**, not merely reported. A hung job
# bills for as long as it hangs, so the safe default is to stop it and let a
# person decide whether to retry — hence a non-zero exit, which also stops this
# from being wired into anything that would blindly re-run it.
set -euo pipefail

repo="${REPO:-rafaelfqueiroz/allmywallet}"
pr="${1:?usage: ci-watch.sh <pr-number> [ceiling-minutes]}"
ceiling="${2:-20}"
interval="${POLL_SECONDS:-30}"

run=$(gh pr view "$pr" --repo "$repo" --json statusCheckRollup \
  -q '[.statusCheckRollup[].detailsUrl // empty] | first' | sed -E 's#.*/runs/([0-9]+)/.*#\1#')

echo "PR #${pr} — polling every ${interval}s, cancelling past ${ceiling} min"
started=$(date +%s)

while :; do
  checks=$(gh pr checks "$pr" --repo "$repo" 2>&1 || true)
  elapsed=$(( ($(date +%s) - started) / 60 ))

  if ! grep -q "pending" <<<"$checks"; then
    echo "$checks"
    if [[ -n "$run" ]]; then
      echo
      "$(dirname "$0")/ci-minutes.sh" "$run"
    fi
    grep -qE "	fail|	cancel" <<<"$checks" && exit 1
    exit 0
  fi

  if (( elapsed >= ceiling )); then
    echo "Checks still pending after ${elapsed} min — cancelling run ${run:-?} to stop it billing." >&2
    [[ -n "$run" ]] && gh run cancel "$run" --repo "$repo" >&2
    exit 2
  fi

  sleep "$interval"
done
