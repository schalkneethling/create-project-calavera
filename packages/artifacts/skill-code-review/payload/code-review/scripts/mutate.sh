#!/usr/bin/env bash
# Runs the tests against a mutated copy of the change, to prove whether the tests notice.
#
#   mutate.sh <out-dir> --revert            [--test "<command>"]   # base code + branch tests
#   mutate.sh <out-dir> --patch <file.diff> [--test "<command>"]   # the head commit + one targeted mutation
#   mutate.sh <out-dir> --sed <path> '<sed expression>' [--test "<command>"]   # same, as an in-place sed on one file
#
# <out-dir> is the folder resolve-target.sh printed. The work happens in a throwaway
# worktree at <out-dir>/mutant, never in the user's checkout, and the worktree is removed
# at the end. The test command is --test, else "npm test" (package.json with a test
# script), "pytest -q" (pyproject.toml, pytest.ini or setup.cfg), "go test ./..." (go.mod)
# or "cargo test" (Cargo.toml).
#
# --revert puts every changed non-test file back to its base version (added ones are
# deleted) and keeps the branch's tests. A new or changed test that still passes does not
# exercise the change.
#
# Prints the test exit code on the first line ("TESTS_EXIT=<n>"), then the last 60 lines
# of test output. Exit code is 0 when the mutation ran, regardless of the test result.
set -uo pipefail

# Runs a command with a time limit. GNU timeout where it exists (Linux, or coreutils on macOS as
# gtimeout); otherwise a watcher process, so the script also works on a stock macOS.
run_with_limit() {
  local seconds="$1" cmd="$2"
  if command -v timeout >/dev/null 2>&1; then timeout "$seconds" bash -c "$cmd"
  elif command -v gtimeout >/dev/null 2>&1; then gtimeout "$seconds" bash -c "$cmd"
  else
    # Job control gives the command its own process group, so the limit also stops its children.
    set -m; bash -c "$cmd" & local pid=$!; set +m
    # The watcher closes stdout, or a caller capturing output would wait for it instead of the command.
    ( sleep "$seconds"; kill -TERM -- "-$pid" 2>/dev/null ) >/dev/null 2>&1 & local watcher=$!
    wait "$pid"; local code=$?
    kill "$watcher" 2>/dev/null; wait "$watcher" 2>/dev/null
    return "$code"
  fi
}

OUT="${1:?give the folder resolve-target.sh printed}"; shift
MODE="" PATCH="" TEST_CMD="" SED_PATH="" SED_EXPR=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --revert) MODE=revert ;;
    --patch) MODE=patch; PATCH="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"; shift ;;
    --sed) MODE=sed; SED_PATH="$2"; SED_EXPR="$3"; shift 2 ;;
    --test) TEST_CMD="$2"; shift ;;
    *) echo "mutate: unknown argument $1" >&2; exit 1 ;;
  esac; shift
done
[[ -n "$MODE" ]] || { echo "mutate: give --revert, --patch <file> or --sed <path> '<expr>'" >&2; exit 1; }
[[ -f "$OUT/meta.json" ]] || { echo "mutate: no meta.json in $OUT" >&2; exit 1; }

meta() { python3 -c 'import json,sys;v=json.load(open(sys.argv[1])).get(sys.argv[2],"");print(v if v is not None else "")' "$OUT/meta.json" "$1"; }
CHECKOUT="$(meta checkout)"; HEAD_SHA="$(meta head_sha)"; BASE="$(meta base)"; MODE_META="$(meta mode)"
MUTANT="$OUT/mutant"

git -C "$CHECKOUT" worktree remove --force "$MUTANT" 2>/dev/null || true
git -C "$CHECKOUT" worktree add --quiet --detach "$MUTANT" "$HEAD_SHA" || { echo "mutate: cannot create worktree" >&2; exit 1; }
cleanup() { git -C "$CHECKOUT" worktree remove --force "$MUTANT" 2>/dev/null || true; }
trap cleanup EXIT

cd "$MUTANT"
# Uncommitted work the collector recorded is part of the reviewed change, so the mutant carries it too.
if [[ -f "$OUT/uncommitted.patch" && -s "$OUT/uncommitted.patch" ]]; then
  git apply "$OUT/uncommitted.patch" || { echo "mutate: the uncommitted changes no longer apply; rerun the collector" >&2; exit 1; }
fi
if [[ -f "$OUT/untracked.txt" ]]; then
  while IFS= read -r f; do
    [[ -n "$f" && -f "$CHECKOUT/$f" ]] || continue
    mkdir -p "$(dirname "$f")"; cp "$CHECKOUT/$f" "$f"
  done < "$OUT/untracked.txt"
fi

# The files the change touched: the committed diff, plus uncommitted edits and untracked files.
CHANGED="$OUT/mutant-files.txt"
cut -f4 "$OUT/files.txt" > "$CHANGED"
[[ -f "$OUT/uncommitted.patch" ]] && grep -E '^\+\+\+ b/' "$OUT/uncommitted.patch" | sed 's#^+++ b/##' >> "$CHANGED"
[[ -f "$OUT/untracked.txt" ]] && cat "$OUT/untracked.txt" >> "$CHANGED"
sort -u -o "$CHANGED" "$CHANGED"

is_test_file() {
  [[ "$1" =~ (^|/)(test|tests|__tests__|spec|specs)(/|$) ]] || [[ "$1" =~ \.(test|spec)\.[A-Za-z0-9]+$ ]] || [[ "$1" =~ _test\.(go|py|rb|rs|ts|js)$ ]] || [[ "$1" =~ (^|/)test_[^/]+\.py$ ]]
}
# Test setup stays as the branch wrote it: a reverted package.json or runner config could drop the new
# suite from the run and turn a skipped test into a green result.
is_test_setup() {
  case "$(basename "$1")" in
    package.json|package-lock.json|pnpm-lock.yaml|yarn.lock|bun.lockb|jest.config.*|vitest.config.*|.mocharc*|karma.conf*|playwright.config.*|pytest.ini|pyproject.toml|setup.cfg|tox.ini|conftest.py|go.mod|go.sum|Cargo.toml|Cargo.lock) return 0 ;;
    *) return 1 ;;
  esac
}
if [[ "$MODE" == "revert" ]]; then
  # The base to revert to: the merge base the collector recorded, else the base branch tip it recorded,
  # else a local base branch. This script never fetches: the worktree shares the user's repository,
  # and a fetch with --depth there would make that repository shallow.
  BASE_REF=""
  for candidate in "$(meta merge_base)" "$(meta base_sha)" "origin/$BASE" "$BASE"; do
    [[ -n "$candidate" ]] && git cat-file -e "$candidate^{commit}" 2>/dev/null && { BASE_REF="$candidate"; break; }
  done
  [[ -n "$BASE_REF" ]] || { echo "mutate: the base commit is not in this checkout; rerun the collector, which records it, or fetch $BASE in the repository first" >&2; exit 1; }
  reverted=0; kept=""
  while IFS= read -r path; do
    [[ -n "$path" ]] || continue
    # Test files stay as the branch wrote them; that is the point. So does the test setup.
    is_test_file "$path" && continue
    if is_test_setup "$path"; then kept="$kept $path"; continue; fi
    if git cat-file -e "$BASE_REF:$path" 2>/dev/null; then
      git checkout --quiet "$BASE_REF" -- "$path"
    else
      rm -f "$path"
    fi
    reverted=$((reverted + 1))
  done < "$CHANGED"
  echo "mutate: reverted $reverted non-test file(s) to $BASE_REF, kept the branch's tests${kept:+ and its test setup ($kept )}" >&2
  echo "mutate: check that the test output names the new or changed tests; a suite that did not run them proves nothing" >&2
elif [[ "$MODE" == "patch" ]]; then
  git apply --index "$PATCH" || { echo "mutate: patch does not apply" >&2; exit 1; }
  echo "mutate: applied $(basename "$PATCH")" >&2
else
  # The path is relative to the repository root, so the edit stays inside the throwaway worktree.
  SED_PATH="${SED_PATH#"$CHECKOUT"/}"
  case "$SED_PATH" in /*|../*|*/../*|*/..) echo "mutate: give a path relative to the repository root, not $SED_PATH" >&2; exit 1 ;; esac
  [[ -f "$SED_PATH" ]] || { echo "mutate: no such file $SED_PATH in the worktree" >&2; exit 1; }
  # Resolve symlinks: a linked directory or file in the branch must not lead the edit outside the worktree.
  python3 - "$MUTANT" "$SED_PATH" <<'PY4' || exit 1
import os, sys
root, rel = sys.argv[1:]
real_root = os.path.realpath(root); real = os.path.realpath(os.path.join(root, rel))
if os.path.islink(os.path.join(root, rel)) or not real.startswith(real_root + os.sep):
    sys.exit(f"mutate: {rel} resolves to {real}, outside the worktree; refusing to edit through a symlink")
PY4
  # Not sed -i: BSD sed on macOS reads "-e" as a backup suffix and leaves a stray file.
  sed -e "$SED_EXPR" "$SED_PATH" > "$SED_PATH.mutant" && mv "$SED_PATH.mutant" "$SED_PATH"
  if git diff --quiet -- "$SED_PATH"; then echo "mutate: the sed expression changed nothing in $SED_PATH" >&2; exit 1; fi
  echo "mutate: mutated $SED_PATH:" >&2; git diff --no-color -U0 -- "$SED_PATH" | grep '^[-+][^-+]' >&2
fi

if [[ -z "$TEST_CMD" ]]; then
  if [[ -f package.json ]] && python3 -c 'import json,sys;sys.exit(0 if "test" in json.load(open("package.json")).get("scripts",{}) else 1)'; then TEST_CMD="npm test --silent"
  elif [[ -f pyproject.toml || -f pytest.ini || -f setup.cfg ]]; then TEST_CMD="pytest -q"
  elif [[ -f go.mod ]]; then TEST_CMD="go test ./..."
  elif [[ -f Cargo.toml ]]; then TEST_CMD="cargo test"
  else echo "mutate: no test command found; pass --test \"<command>\"" >&2; exit 1
  fi
fi
[[ -d "$CHECKOUT/node_modules" && ! -e node_modules ]] && ln -s "$CHECKOUT/node_modules" node_modules

echo "mutate: running: $TEST_CMD" >&2
output="$(run_with_limit 600 "$TEST_CMD" 2>&1)"; code=$?
echo "TESTS_EXIT=$code"
echo "$output" | tail -60
