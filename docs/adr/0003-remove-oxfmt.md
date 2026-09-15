# ADR-0003: Remove Oxfmt

- **Status:** Proposed
- **Date:** 2026-09-15
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/453
- **Decides:** removal of the Oxfmt integration under C1, applying the `remove` classification recorded for the "Modern profile: Oxfmt" row of `docs/catalog-audit.md`.

## Context

Oxfmt has been the JavaScript and TypeScript formatter in Calavera's Modern profile since before this evolution brief existed. The catalog entry `oxfmt` installs the `oxfmt` package and adds two scripts to `package.json`: `format`, running `oxfmt --write .`, and `format:check`, running `oxfmt --check .`. It writes no managed configuration file of its own; there is no `.oxfmtrc.json` template for Calavera to own, so its only footprint outside `package.json` is the dependency itself. Oxfmt is a Modern profile default, so a project scaffolded with that profile receives it whether or not the recipe author asked for it by name.

One piece of cross-cutting logic sits around the entry: `assertNoFormatterConflict` in `packages/cli/src/recipe.js` rejects any recipe that resolves both `oxfmt` and `prettier`, on the grounds that Calavera should not install two formatters competing for the same scripts and configuration ownership. That rule exists only because both entries can appear together today; it has no purpose once one side of the pair is gone.

Decision C2 holds that in a `vp`-managed project, Calavera scaffolds no JavaScript or TypeScript formatter and writes no script duplicating a `vp` command. Decision C7 holds that an integration is metadata over `vp` primitives, deleted rather than defended once Vite+ absorbs what it does. CQ1, resolved by Increment 1, resolves the remaining gap for the formatter specifically: Calavera provides no JavaScript or TypeScript formatter to any project, `vp`-managed or not, and a project without `vp` runs `vp create` or `vp migrate` first. That policy takes full effect only once CAL-016 removes Prettier; this ADR removes Oxfmt alone, and Prettier remains the Classic profile's own formatter until CAL-016's own ADR retires it. TypeScript configuration is removed separately under CAL-014 and is likewise out of scope here. Under C1, C2, C7, and CQ1 together, an Oxfmt entry that exists to write two scripts duplicating `vp fmt` has no project left to serve, whether or not Prettier has yet been removed from Classic.

## Evidence

A non-interactive `vp check` run against a `vp create`-scaffolded project reports `pass: All 7 files are correctly formatted`; Vite+ formats the project itself and needs no project-level `format` or `format:check` script to do it. Vite+'s own documentation confirms the same tool sits underneath both paths: `docs/guide/fmt.md:7` in the vite-plus package states that `vp fmt` is built on Oxfmt and is a drop-in replacement for Prettier. The two scripts Calavera's `oxfmt` entry writes add no capability `vp fmt` lacks; they invoke the same underlying formatter through a second entry point `vp` does not read.

The migration path reinforces this. `migrate-rules.md:280-286` rewrites an existing `prettier` script to `vp fmt`, and `migrate-rules.md:407-410` skips formatting outright while a project still depends on Prettier. The destination of that rewrite is `vp fmt`, not a standalone `oxfmt` script; a project-level Oxfmt invocation is what Calavera's entry produced and what the migration replaces. The generated project carries no `.oxfmtrc.json`; the formatting configuration that exists lives in the `fmt: {}` block of `vite.config.ts`, confirming that Vite+, not a project-level Oxfmt configuration file, is the configuration surface Calavera would need to manage if it kept the entry.

## Decision

Remove the `oxfmt` catalog entry, its `format` and `format:check` script contributions, the `assertNoFormatterConflict` rejection rule that treats Oxfmt and Prettier as a conflicting pair, the Composer option and label text for the entry, and the schema enum value that accepts the `oxfmt` id. Tests, documentation, and MCP listings for all of the above are removed with the code they cover, not left in place as dead references.

No compatibility flag, deprecated path, or legacy profile survives this removal. A recipe that names `oxfmt` is rejected the same way any other unknown id is rejected; there is no fallback that silently accepts the old name or produces a Modern profile response identical to before.

This removal has a direct profile consequence, stated here rather than left implicit. After this ADR, the Modern profile's defaults are EditorConfig, TypeScript configuration, and Stylelint, none of which is unique to Modern. Modern and Classic still differ in their formatter: Classic continues to scaffold Prettier's `format` and `format:check` scripts until CAL-016 removes it, while Modern scaffolds none now that Oxfmt is gone. Beyond the formatter, they differ only in the ESLint flat config that Classic carries and Modern does not; once CAL-016 removes Prettier, the profiles will differ solely in that ESLint block. The profile availability map makes the same point from the other side: after this removal it holds no Modern-only entry at all, every remaining entry is Classic-only except React Doctor, which both profiles share, so the map now exists only to fence off the ESLint and Prettier tooling from Modern. This ADR does not act on that consequence. Whether the two profiles still warrant separate identity, or should collapse into one, is the question CAL-011 decides, reading `vitePlus.status` per ADR-0001. This ADR removes the entry Oxfmt referenced and leaves profile shape to that later work.

## Consequences

A `calavera.config.json` that names `oxfmt` fails validation with the same unknown-id error any other unrecognized integration produces. The changelog entry for this release tells a project owner on a Vite+ project to remove the id from their recipe and rely on `vp fmt` and `vp check` for the formatting that entry used to provide; a project that has not adopted Vite+ runs `vp create` or `vp migrate` first, since Calavera no longer provides a formatter to any project. Neither path offers a migration that keeps the entry reachable in spirit if not in name.

Calavera's own repository keeps `oxfmt` as its own devDependency and `format` script for formatting Calavera's source. That dependency and script are unrelated to the catalog entry this ADR removes; they format the tool, not a project the tool scaffolds, and nothing here changes them.

Until CAL-016 removes Prettier under its own ADR, the `format` and `format:check` scripts Calavera writes for a project are produced by Prettier alone. The `assertNoFormatterConflict` rejection has no successor rule to replace it: with only one formatter left in the catalog, there is no pair left to conflict.

## Alternatives considered

**Keep Oxfmt as a delegate.** Rejected under CQ1, which already resolved this for every JavaScript and TypeScript toolchain component: Calavera offers none of them, `vp`-managed or not, and points a project at `vp create` or `vp migrate` instead. An exception for Oxfmt alone would reopen a settled decision.

**Keep Oxfmt as the formatter for projects that have not adopted `vp`.** Rejected because CQ1 states plainly that Calavera provides no toolchain component, formatter included, to a non-`vp` project; a non-`vp`-only Oxfmt entry is still a toolchain component CQ1 forecloses, regardless of whether `vp` is present.

**A deprecation period that accepts the `oxfmt` id with a warning before removing it.** Rejected because `AGENTS.md` states removals are complete: no deprecated path, flag, or legacy mode. A warning-then-remove sequence is a deprecated path by another name.

## Open questions

None beyond the CAL-011 profile-collapse decision this ADR explicitly defers. That decision is tracked separately and is out of scope here.
