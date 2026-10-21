#!/usr/bin/env bash
# The recording as it is: every build check fails at pnpm install.
set -euo pipefail
exec bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/../fixtures/scaffold.sh"
