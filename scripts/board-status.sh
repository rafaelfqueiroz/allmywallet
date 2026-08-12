#!/usr/bin/env bash
# Set the board Status field for an issue: ./scripts/board-status.sh <issue> <status>
# Status is one of: Backlog | Ready | "In progress" | "In review" | Done
#
# The board is the source of truth for *what is being built now* (CLAUDE.md), so
# it has to move as work moves — a board that lags the branches is worse than no
# board, because it is confidently wrong.
set -euo pipefail

PROJECT_ID="PVT_kwHOADuqWs4BgJTC"
STATUS_FIELD="PVTSSF_lAHOADuqWs4BgJTCzhaXFx0"

issue="${1:?usage: board-status.sh <issue-number> <status>}"
status="${2:?usage: board-status.sh <issue-number> <status>}"

case "$status" in
  "Backlog")     option="f75ad846" ;;
  "Ready")       option="61e4505c" ;;
  "In progress") option="47fc9ee4" ;;
  "In review")   option="df73e18b" ;;
  "Done")        option="98236657" ;;
  *) echo "unknown status: $status" >&2; exit 1 ;;
esac

item=$(gh api graphql -f query='query{ user(login:"rafaelfqueiroz"){ projectV2(number:3){ items(first:50){ nodes{ id content{ ... on Issue { number } } } } } } }' \
  --jq ".data.user.projectV2.items.nodes[] | select(.content.number == $issue) | .id")

if [[ -z "$item" ]]; then
  echo "issue #$issue is not on the board" >&2
  exit 1
fi

gh api graphql -f query='
  mutation($project:ID!, $item:ID!, $field:ID!, $option:String!) {
    updateProjectV2ItemFieldValue(input:{
      projectId:$project, itemId:$item, fieldId:$field,
      value:{ singleSelectOptionId:$option }
    }) { projectV2Item { id } }
  }' -f project="$PROJECT_ID" -f item="$item" -f field="$STATUS_FIELD" -f option="$option" >/dev/null

echo "#$issue → $status"
