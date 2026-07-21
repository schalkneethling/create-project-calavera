# Baseline core

Browser-safe Baseline data and recommendation APIs shared by Calavera's Explorer, Composer, CLI, MCP, and WebMCP surfaces.

The build script consumes pinned `web-features` and `baseline-browser-mapping` versions and generates a compact CSS-focused dataset. `pnpm test` checks that the generated data is current before running target, feature, and Stylelint output tests.

Stylelint detection coverage remains separate from the broader WebDX feature catalog: the package recommends compatibility targets, while `stylelint-plugin-use-baseline` determines which authored CSS declarations it can lint.
