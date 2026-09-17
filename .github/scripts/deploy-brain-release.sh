#!/usr/bin/env bash
# Build an immutable brain release, atomically switch the service symlink, and
# restore the previous target if readiness/version verification fails. This is
# executed on the VPS by deploy-host.yml; it never touches the live worktree.
set -euo pipefail

: "${SHA:?deploy-brain-release: SHA is required}"

REPO_ROOT="${BRAIN_REPO_ROOT:-/opt/svitanok-brain}"
RELEASE_ROOT="${BRAIN_RELEASE_ROOT:-/opt/svitanok-brain-releases}"
CURRENT_LINK="${BRAIN_CURRENT_LINK:-/opt/svitanok-brain-current}"
LAYOUT_MARKER="${BRAIN_SHARED_ROOT:-/opt/svitanok-brain-shared}/release-layout-v1"
SERVICE="${BRAIN_SERVICE:-svitanok-brain}"
RELEASE_DIR="$RELEASE_ROOT/$SHA"

fail() {
  echo "deploy-brain-release: $*" >&2
  exit 1
}

[ -f "$LAYOUT_MARKER" ] || fail "immutable layout not bootstrapped; see docs/release-compatibility.md"
[ -d "$REPO_ROOT/.git" ] || fail "missing repository at $REPO_ROOT"

cd "$REPO_ROOT"
git fetch --quiet origin
git cat-file -e "$SHA^{commit}" || fail "unknown commit $SHA"
git cat-file -e "$SHA:brain/package.json" || fail "commit $SHA has no brain release"

mkdir -p "$RELEASE_ROOT"
if [ -e "$RELEASE_DIR" ]; then
  [ -d "$RELEASE_DIR/.git" ] || fail "release path exists but is not a worktree: $RELEASE_DIR"
  [ "$(git -C "$RELEASE_DIR" rev-parse HEAD)" = "$SHA" ] || fail "release path belongs to another commit"
else
  git worktree add --detach "$RELEASE_DIR" "$SHA"
fi

cd "$RELEASE_DIR/brain"
npm ci --omit=dev
npm run build

node --input-type=module -e '
  import { readFileSync } from "node:fs";
  const [manifestPath, expected] = process.argv.slice(1);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest?.schema !== 1 || manifest?.release?.gitSha !== expected) process.exit(1);
' "$RELEASE_DIR/brain/dist/release-manifest.json" "$SHA" || fail "release manifest mismatch"

previous=""
if [ -L "$CURRENT_LINK" ]; then previous="$(readlink -f "$CURRENT_LINK")"; fi

rollback() {
  if [ -n "$previous" ] && [ -d "$previous/brain" ]; then
    echo "deploy-brain-release: readiness failed; rolling back to $previous" >&2
    ln -s "$previous" "$CURRENT_LINK.next"
    mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
    sudo systemctl restart "$SERVICE" || true
  fi
}

ln -s "$RELEASE_DIR" "$CURRENT_LINK.next"
mv -Tf "$CURRENT_LINK.next" "$CURRENT_LINK"
sudo systemctl restart "$SERVICE"

health=""
for _ in $(seq 1 20); do
  sleep 2
  health="$(curl -sf http://127.0.0.1:8788/ready || true)"
  [ -n "$health" ] && break
done
if [ -z "$health" ] || ! printf '%s' "$health" | grep -Fq "$SHA"; then
  rollback
  fail "new release did not become ready with expected gitSha"
fi

echo "deploy-brain-release: active $SHA (previous: ${previous:-none})"
