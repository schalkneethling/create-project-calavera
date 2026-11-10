#!/usr/bin/env bash
# Builds ./refund-service: main holds files/base, branch feature/partial-refunds holds files/change.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
rm -rf refund-service && mkdir refund-service && cd refund-service
git init -q -b main
git config user.email eval@example.com && git config user.name eval
cp -R "$here/../finds-planted-refund-bug/files/base/." . && git add -A && git commit -qm "refund service"
git checkout -qb feature/partial-refunds
rm -rf src README.md && cp -R "$here/../finds-planted-refund-bug/files/change/." . && git add -A
git commit -qm "Partial refunds with gateway retries

A refund can now be for part of the order total, and a failed
gateway call is retried when the caller asks for it."
git checkout -q main
