#!/usr/bin/env bash
# Shared workspace setup for the cases in this folder: the reviewed project as
# it is on main, committed to git, and the stand-in gh in .eval-bin/ with the
# recording in data/. A case can pass a folder of data files that replace the
# recorded ones. Run the cases with .eval-bin first on PATH, as
# plugins/dependency-review/README.md shows, so the agent's gh commands reach
# the stand-in.
set -euo pipefail

# claude plugin eval runs this in a new, empty workspace. Refuse to run in a
# directory that has anything in it, so running it by hand cannot overwrite a
# real project's files. (The workspace itself sits inside a git repository that
# the eval creates for the run's home folder, so that cannot be the test.)
if [ -n "$(ls -A)" ]; then
  echo "scaffold.sh: run this only through claude plugin eval, in an empty directory" >&2
  exit 1
fi

# The script runs as the user, outside the eval sandbox. Ignore the user's git
# configuration, so the throwaway commit below is never signed with their key,
# and no hooks path or template from it applies.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1

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
git -c user.name=eval -c user.email=eval@example.invalid -c commit.gpgsign=false \
  commit --quiet -m "The project on main"
