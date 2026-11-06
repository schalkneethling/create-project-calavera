#!/usr/bin/env bash
# Builds ./refund-service with a docs-only branch docs/readme-setup on top of main.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
base="$here/../finds-planted-refund-bug/files/base"
rm -rf refund-service && mkdir refund-service && cd refund-service
git init -q -b main
git config user.email eval@example.com && git config user.name eval
cp -R "$base/." . && git add -A && git commit -qm "refund service"
git checkout -qb docs/readme-setup
cat >> README.md <<'MD'

## Setup

1. Set `GATEWAY_URL` to the payment gateway base URL.
2. Run `npm test`.
MD
git add -A && git commit -qm "README: setup section"
git checkout -q main
