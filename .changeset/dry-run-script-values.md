---
"create-project-calavera": minor
---

The dry run now shows the command each `package.json` script will run. `apply --dry-run` prints one line for each script it would add, such as `Would add script knip: "knip"`, and for each script it would change, with the current value and the new one, such as `Would change script quality from "npm test" to "pnpm lint:styles && pnpm knip"`. Scripts that already have the value apply writes are listed under `Scripts already set`, and the `Would add scripts` line is gone. `dry_run_apply`, `apply_recipe`, and `apply --json` carry the same detail in a new top-level `scriptChanges` field, as `{ script, value }` for an added script and `{ script, value, previous }` for a changed one. The `scripts` field of the `package.json` change is unchanged.
