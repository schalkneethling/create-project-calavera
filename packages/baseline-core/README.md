# Baseline core

Browser-safe Baseline data and recommendation APIs shared by Calavera's Explorer, Composer, CLI, MCP, and WebMCP surfaces.

The build script consumes pinned `web-features` and `baseline-browser-mapping` versions and generates a compact CSS-focused dataset. `pnpm test` checks that the generated data is current before running target, feature, and Stylelint output tests.

## Refreshing data

After the pinned `web-features` or `baseline-browser-mapping` version changes, run `pnpm build:data`. When the browser mapping contains a release later than the snapshot cutoff in `scripts/snapshot.mjs`, the generator asks for a new non-future cutoff (default: today, UTC), rewrites `scripts/snapshot.mjs`, regenerates `data/baseline.json`, and offers to write `.changeset/baseline-data-refresh.md`. Pass `--cutoff YYYY-MM-DD` and `--changeset` to run without prompts. `pnpm test` fails with a message that names the stale cutoff, the latest release, and the source version until the refresh is complete.

Stylelint detection coverage remains separate from the broader WebDX feature catalog: the package recommends compatibility targets, while `stylelint-plugin-use-baseline` determines which authored CSS declarations it can lint.
