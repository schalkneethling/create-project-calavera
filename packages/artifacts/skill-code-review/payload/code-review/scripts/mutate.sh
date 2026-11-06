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
git -C "$CHECKOUT" worktree prune 2>/dev/null || true
git -C "$CHECKOUT" worktree add --quiet --detach "$MUTANT" "$HEAD_SHA" || { echo "mutate: cannot create worktree" >&2; exit 1; }
cleanup() { git -C "$CHECKOUT" worktree remove --force "$MUTANT" 2>/dev/null || true; git -C "$CHECKOUT" worktree prune 2>/dev/null || true; }
trap cleanup EXIT

cd "$MUTANT"
if [[ "$MODE" == "revert" ]]; then
  # The base to revert to: the merge base the collector recorded, else the base branch tip it recorded,
  # else a local base branch. This script never fetches: the worktree shares the user's repository,
  # and a fetch with --depth there would make that repository shallow.
  BASE_REF=""
  for candidate in "$(meta merge_base)" "$(meta base_sha)" "origin/$BASE" "$BASE"; do
    [[ -n "$candidate" ]] && git cat-file -e "$candidate^{commit}" 2>/dev/null && { BASE_REF="$candidate"; break; }
  done
  [[ -n "$BASE_REF" ]] || { echo "mutate: the base commit is not in this checkout; rerun the collector, which records it, or fetch $BASE in the repository first" >&2; exit 1; }
  reverted=0
  while IFS=$'\t' read -r status _ _ path; do
    [[ -n "$path" ]] || continue
    # Test files stay as the branch wrote them; that is the point.
    if [[ "$path" =~ (^|/)(test|tests|__tests__|spec|specs)(/|$) ]] || [[ "$path" =~ \.(test|spec)\.[A-Za-z0-9]+$ ]] || [[ "$path" =~ _test\.(go|py|rb|rs|ts|js)$ ]] || [[ "$path" =~ (^|/)test_[^/]+\.py$ ]]; then
      continue
    fi
    if git cat-file -e "$BASE_REF:$path" 2>/dev/null; then
      git checkout --quiet "$BASE_REF" -- "$path"
    else
      rm -f "$path"
    fi
    reverted=$((reverted + 1))
  done < "$OUT/files.txt"
  echo "mutate: reverted $reverted non-test file(s) to $BASE_REF, kept the branch's tests" >&2
elif [[ "$MODE" == "patch" ]]; then
  git apply --index "$PATCH" || { echo "mutate: patch does not apply" >&2; exit 1; }
  echo "mutate: applied $(basename "$PATCH")" >&2
else
  # The path is relative to the repository root, so the edit stays inside the throwaway worktree.
  SED_PATH="${SED_PATH#"$CHECKOUT"/}"
  case "$SED_PATH" in /*|../*|*/../*|*/..) echo "mutate: give a path relative to the repository root, not $SED_PATH" >&2; exit 1 ;; esac
  [[ -f "$SED_PATH" ]] || { echo "mutate: no such file $SED_PATH in the worktree" >&2; exit 1; }
  sed -i -e "$SED_EXPR" "$SED_PATH"
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
output="$(timeout 600 bash -c "$TEST_CMD" 2>&1)"; code=$?
echo "TESTS_EXIT=$code"
echo "$output" | tail -60
