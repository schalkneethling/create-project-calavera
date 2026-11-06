#!/usr/bin/env bash
# Builds ./refund-service: main holds the base service, branch feature/validate-amount holds files/change.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
base="$here/../finds-planted-refund-bug/files/base"
rm -rf refund-service && mkdir refund-service && cd refund-service
git init -q -b main
git config user.email eval@example.com && git config user.name eval
cp -R "$base/." . && git add -A && git commit -qm "refund service"
git checkout -qb feature/validate-amount
rm -rf src && cp -R "$here/files/change/." . && git add -A
git commit -qm "Validate the refund amount

Reject a refund of zero or more than the order total, with a test."
git checkout -q main
