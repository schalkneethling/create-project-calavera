#!/usr/bin/env bash
# Removes the folder resolve-target.sh made, and the git worktree inside it if there is one.
#
#   cleanup.sh <out-dir>
set -euo pipefail
OUT="${1:?give the folder resolve-target.sh printed}"
[[ -d "$OUT" ]] || exit 0
# Refuse anything that is not a collector folder, so a repository path can never be deleted by mistake.
[[ -f "$OUT/meta.json" && -f "$OUT/diff.patch" ]] || { echo "cleanup: $OUT is not a folder resolve-target.sh made (no meta.json and diff.patch); nothing removed" >&2; exit 1; }
CHECKOUT="$OUT/checkout"
if [[ -d "$CHECKOUT" ]] && [[ -f "$CHECKOUT/.git" ]]; then
  # A worktree: ask its main repository to drop it, so the repo does not keep a stale entry.
  main="$(git -C "$CHECKOUT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null || true)"
  if [[ -n "$main" ]]; then
    git -C "$(dirname "$main")" worktree remove --force "$CHECKOUT" 2>/dev/null || true
    git -C "$(dirname "$main")" worktree prune 2>/dev/null || true
  fi
fi
rm -rf "$OUT"
echo "removed $OUT"
