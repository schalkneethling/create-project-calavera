#!/usr/bin/env bash
# The same pull request with no checks reported at all, so gh pr checks answers
# "no checks reported on the '<branch>' branch", as gh does.
set -euo pipefail
case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$case_dir/../fixtures/scaffold.sh" "$case_dir/data"
