#!/usr/bin/env bash
# Three pull requests: #1457 as recorded, whose checks failed, and two synthetic
# ones in data/: #1458, an axe-core bump whose checks all passed, and #1459, an
# @types/node bump whose checks are still running. They have their own run,
# job, and deploy IDs.
set -euo pipefail
case_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec bash "$case_dir/../fixtures/scaffold.sh" "$case_dir/data"
