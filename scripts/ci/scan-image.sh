#!/usr/bin/env bash
#
# SPEC-021 BR-021-14 (AR-73) — the published image is public and cannot be
# made private again, so nothing secret or personal may ever be in it.
#
#   scripts/ci/scan-image.sh <image>
#
# Scans EVERY layer, not the merged filesystem: a file added in one layer and
# deleted in the next is invisible in a running container and still published
# in the image. Fails on:
#   - secret- or data-shaped file names (.env files, spreadsheets, dumps, keys);
#   - key-shaped strings (private keys, age identities, GitHub, Google OAuth,
#     AWS, Anthropic, Resend and Slack tokens);
#   - CPF-shaped numbers outside node_modules;
#   - secret-named variables in the image's own environment.
#
# scripts/ci/image-scan-allowlist.txt holds path regexes for reviewed false
# positives, one per line, each with a comment saying why.
set -euo pipefail

image=${1:?usage: scan-image.sh <image>}
allowlist="$(dirname "$0")/image-scan-allowlist.txt"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

docker save "$image" -o "$work/image.tar"
mkdir "$work/image" "$work/layers"
tar -xf "$work/image.tar" -C "$work/image"

layer=0
while IFS= read -r blob; do
  if tar -tf "$blob" >/dev/null 2>&1; then
    layer=$((layer + 1))
    mkdir "$work/layers/$layer"
    # Device nodes and whiteouts may refuse to extract unprivileged; their
    # names are still listed above and they carry no content to scan.
    tar -xf "$blob" -C "$work/layers/$layer" 2>/dev/null || true
  fi
done < <(find "$work/image" -type f \( -path '*/blobs/sha256/*' -o -name 'layer.tar' \))
[ "$layer" -gt 0 ] || { echo "scan-image: no layers found in $image" >&2; exit 1; }
# Readable by the scanning user, so a grep error below means a broken scan, not
# a file some layer happened to mark mode 000.
chmod -R u+rX "$work/layers" 2>/dev/null || true
echo "scan-image: scanning $layer layers of $image"

# grep exits 0 on a match, 1 on none, and 2 when it could not search at all.
# Status 2 fails the scan: a check that silently cannot run is a check that
# always passes — which is exactly how the key-shaped scan once let every
# image through, its pattern starting with `-----BEGIN` and read as an option.
scan_grep() {
  local status=0
  (cd "$work/layers" && grep "$@" .) >"$work/grep.out" 2>"$work/grep.err" || status=$?
  if [ "$status" -gt 1 ]; then
    echo "scan-image: grep could not run (exit $status): $(head -3 "$work/grep.err")" >&2
    exit 2
  fi
  cat "$work/grep.out"
}

filter_allowed() {
  if [ -s "$allowlist" ]; then
    grep -vEf <(grep -vE '^\s*(#|$)' "$allowlist") || true
  else
    cat
  fi
}

findings="$work/findings"
: >"$findings"

(cd "$work/layers" && find . \( -type f -o -type l \) \( \
  -name '.env' -o -name '.env.*' -o -name '*.env' \
  -o -iname '*.xlsx' -o -iname '*.xls' -o -iname '*.csv' \
  -o -name '*.dump' -o -name '*.age' -o -name '*.sql.gz' \
  -o -name '*.pem' -o -name '*.p12' -o -name '*.key' \
  -o -name 'id_rsa*' -o -name 'id_ed25519*' -o -name '.npmrc' \
  \) | sed 's|^|name: |') | filter_allowed >>"$findings"

key_patterns='-----BEGIN ((RSA|EC|DSA|OPENSSH|ENCRYPTED) )?PRIVATE KEY-----|AGE-SECRET-KEY-1[0-9A-Z]{58}|ghp_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{60,}|GOCSPX-[A-Za-z0-9_-]{28}|AKIA[0-9A-Z]{16}|sk-ant-[A-Za-z0-9_-]{20,}|re_[A-Za-z0-9]{8}_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}'
# `-e`: the pattern starts with dashes, and without it grep takes it as an option.
scan_grep -rIlE -e "$key_patterns" >"$work/keys"
sed 's|^|key-shaped: |' "$work/keys" | filter_allowed >>"$findings"

scan_grep -rIlE --exclude-dir=node_modules -e '\b[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}\b' >"$work/cpfs"
sed 's|^|cpf-shaped: |' "$work/cpfs" | filter_allowed >>"$findings"

docker image inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" |
  grep -E '^(AUTH_SECRET|AUTH_GOOGLE_SECRET|AUTH_GOOGLE_ID|DATABASE_URL|DATABASE_MIGRATION_URL|POSTGRES_PASSWORD|RESEND_API_KEY|SENTRY_DSN|BACKUP_AGE_RECIPIENT)=' |
  sed 's/=.*$/=<redacted>/; s|^|image env: |' >>"$findings" || true

if [ -s "$findings" ]; then
  echo "scan-image: FAILED — the image would publish these:" >&2
  cat "$findings" >&2
  exit 1
fi
echo "scan-image: no secret or personal data found"
