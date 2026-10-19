#!/usr/bin/env bash
# The same pull request with every check passed. The data in data/ is derived
# from the recording: each failed check, run, job, and step is marked as passed,
# and the failed-step logs are removed.
set -euo pipefail
case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$case_dir/../fixtures/scaffold.sh" "$case_dir/data"
