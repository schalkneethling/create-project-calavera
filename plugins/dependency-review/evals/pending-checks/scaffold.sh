#!/usr/bin/env bash
# The same pull request while its checks are still running. The data in data/
# is derived from the recording: each failed check, run, job, and step is
# marked as in progress or queued, and the failed-step logs are removed.
set -euo pipefail
case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$case_dir/../fixtures/scaffold.sh" "$case_dir/data"
