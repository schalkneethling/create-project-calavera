#!/usr/bin/env bash
# The failing recording, but the failed jobs' logs are gone, as after GitHub's
# log retention period, so gh run view --log-failed answers "log not found".
set -euo pipefail
case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$case_dir/../fixtures/scaffold.sh" "$case_dir/data"
