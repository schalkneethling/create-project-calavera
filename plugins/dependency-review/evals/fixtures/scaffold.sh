#!/usr/bin/env bash
# Shared workspace setup for the cases in this folder: the reviewed project as
# it is on main, committed to git, and the stand-in gh in .eval-bin/ with the
# recording in data/. A case can pass a folder of data files that replace the
# recorded ones. Run the cases with .eval-bin first on PATH, as
# plugins/dependency-review/README.md shows, so the agent's gh commands reach
# the stand-in.
set -euo pipefail

fixtures="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
overrides="${1:-}"

cp "$fixtures/project/package.json.fixture" package.json
mkdir -p scripts
cp "$fixtures/project/generate-standard-site-records.ts.fixture" scripts/generate-standard-site-records.ts
printf '.eval-bin/\n' > .gitignore

mkdir -p .eval-bin
cp "$fixtures/gh" .eval-bin/gh
chmod +x .eval-bin/gh
cp -R "$fixtures/data" .eval-bin/data
if [ -n "$overrides" ]; then
  # A file containing only "delete" removes the recorded file of that name.
  for file in "$overrides"/*; do
    name="$(basename "$file")"
    if [ "$(cat "$file")" = "delete" ]; then
      rm -f ".eval-bin/data/$name"
    else
      cp "$file" ".eval-bin/data/$name"
    fi
  done
fi

git init --quiet
git add --all
git -c user.name=eval -c user.email=eval@example.invalid commit --quiet -m "The project on main"
