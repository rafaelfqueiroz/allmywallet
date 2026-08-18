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

appear_deadline="${APPEAR_MINUTES:-3}"

while :; do
  checks=$(gh pr checks "$pr" --repo "$repo" 2>&1 || true)
  elapsed=$(( ($(date +%s) - started) / 60 ))

  # "no checks reported" is NOT success, and treating it as such is how this
  # script reported PR #79 green when GitHub had dispatched nothing at all —
  # exactly the failure mode of a check that passes because it never ran. A run
  # normally registers within seconds; past the deadline, no workflow was
  # dispatched, which on this repository has meant the Actions quota is spent.
  if grep -q "no checks reported" <<<"$checks"; then
    if (( elapsed >= appear_deadline )); then
      echo "No checks were dispatched for PR #${pr} after ${elapsed} min." >&2
      echo "Nothing ran — do not read this as passing. Check the Actions quota:" >&2
      echo "  scripts/actions-usage.sh" >&2
      exit 3
    fi
    sleep "$interval"
    continue
  fi

  if ! grep -q "pending" <<<"$checks"; then
    echo "$checks"
    if [[ -n "$run" ]]; then
      echo
      "$(dirname "$0")/ci-minutes.sh" "$run"
    fi
    if grep -qE "	fail|	cancel" <<<"$checks"; then
      # **A red run is not always a red change.** When the Actions quota is
      # spent, GitHub fails every job in two or three seconds having run
      # nothing — no steps, no logs — and `gh pr checks` reports that
      # identically to a test failure. Reading it as "the branch is broken"
      # sends someone hunting a defect that is not there, so the two are
      # separated here by the one thing that distinguishes them: a job that
      # never started has an empty `steps` array.
      if [[ -n "$run" ]]; then
        stepless=$(gh api "/repos/${repo}/actions/runs/${run}/jobs" \
          -q '[.jobs[] | select(.conclusion == "failure" and (.steps | length) == 0)] | length' \
          2>/dev/null || echo 0)
        if [[ "$stepless" -gt 0 ]]; then
          echo >&2
          echo "${stepless} job(s) failed without running a single step." >&2
          echo "That is the Actions quota, not this branch. Check with:" >&2
          echo "  scripts/actions-usage.sh" >&2
          exit 4
        fi
      fi
      exit 1
    fi
    exit 0
  fi

  if (( elapsed >= ceiling )); then
    echo "Checks still pending after ${elapsed} min — cancelling run ${run:-?} to stop it billing." >&2
    [[ -n "$run" ]] && gh run cancel "$run" --repo "$repo" >&2
    exit 2
  fi

  sleep "$interval"
done
