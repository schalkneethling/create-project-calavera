# ADR-0002: Remove Oxlint

- **Status:** Accepted (2026-09-14, merged in #459)
- **Date:** 2026-09-14
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/452
- **Decides:** removal of the Oxlint integration and its fourteen plugin pack entries under C1, applying the `remove` classification recorded for the "Modern profile: Oxlint" row and the five rule pack rows of `docs/catalog-audit.md`.

## Context

Oxlint has been the JavaScript and TypeScript linter in Calavera's Modern profile since before this evolution brief existed. The catalog entry `oxlint` generates `oxlint.json` through `createOxlintConfig`, which assembles the file from whichever plugin entries a recipe selects plus one seeded `curly` rule Calavera has always written regardless of selection. Selecting `oxlint` also adds `lint` and `lint:fix` scripts to `package.json`, and the Modern profile includes it by default, so a project scaffolded with that profile receives Oxlint whether or not the recipe author asked for it by name.

Around the integration sit fourteen plugin pack entries: `oxlint-eslint`, `oxlint-typescript`, `oxlint-unicorn`, `oxlint-oxc`, `oxlint-import`, `oxlint-react`, `oxlint-jsx-a11y`, `oxlint-node`, `oxlint-promise`, `oxlint-vitest`, `oxlint-jest`, `oxlint-nextjs`, `oxlint-vue`, and `oxlint-jsdoc`. Each one is a plugin toggle: an `id`, a `label`, a `platform`, and a `plugin` name that `createOxlintConfig` appends to the `plugins` array of the same generated `oxlint.json`. None of the fourteen contribute a rule, a script, a managed file of their own, or a diagnostic; the only rule Calavera writes is the shared `curly` rule, and the packs exist to shape the one file the parent entry already writes.

Decision C2 of the evolution brief holds that in a `vp`-managed project, Calavera scaffolds no JavaScript or TypeScript linter and writes no script that duplicates a `vp` command. Decision C7 holds that an integration is metadata over `vp` primitives, and that when Vite+ absorbs what an integration does, the integration is deleted rather than defended. CQ1, resolved by Increment 1, closes the remaining gap: Calavera provides no JavaScript or TypeScript toolchain component to any project, `vp`-managed or not, and a project without `vp` runs `vp create` or `vp migrate` first rather than receiving a Calavera-scaffolded alternative. This ADR applies that resolution to one component, the JavaScript and TypeScript linter; the TypeScript configuration and Oxfmt components stay in place until CAL-014 and CAL-013 remove them under their own ADRs. Under those three decisions together, an Oxlint entry that exists to write `oxlint.json` has no project left to serve.

## Evidence

A non-interactive `vp check` run against a `vp create`-scaffolded project lints through the bundled Oxlint with no `oxlint.json` present in the tree; Vite+ supplies the linter and its configuration itself and does not read a project-level Oxlint configuration file to do so. Vite+'s own documentation goes further than silence on the point. `docs/guide/lint.md` in the vite-plus 0.3.1 package says: "Put lint configuration directly in the `lint` block in `vite.config.ts` so all your configuration stays in one place. We do not recommend using `oxlint.config.ts` or `.oxlintrc.json` with Vite+."

That disagreement is reproducible, not hypothetical. In the CAL-001 probe (transcripts in `docs/catalog-audit.md`), `promise/catch-or-return` seeded into the `lint` block of `vite.config.ts` fired during `vp lint`, while the same rule written into a project-level `.oxlintrc.json`, the file Oxlint discovers on its own, was ignored outright. The probe did not seed Calavera's managed `oxlint.json` by name, but the conclusion holds for it equally: `vp` reads its lint configuration from the Vite+ config file and from nothing else, so any project-level Oxlint configuration file Calavera writes next to it is dead weight at best and a source of false confidence at worst. A developer editing the file Calavera generated would reasonably expect it to govern what `vp lint` reports, and it does not.

The fourteen plugin pack entries do not survive this evidence either. Each one is a plugin toggle that `vp lint --help` exposes as a flag (for example `--react-plugin`, `--import-plugin`, `--promise-plugin`) and that the `lint` block accepts under `plugins`, as `vp lint --print-config` confirmed in the probe. Calavera's packs restate a choice `vp lint` already exposes, in a file `vp` does not consult.

## Decision

Remove the `oxlint` catalog entry, all fourteen plugin pack entries listed under Context, `createOxlintConfig`, the `oxlint.json` managed file it produces, the `lint` and `lint:fix` script contributions the entry adds, both `equivalent-tooling` inspection findings that involve Oxlint (an existing `eslint.config.js` while Oxlint is selected, and an existing `oxlint.json` while ESLint is selected), the `oxlint.json` entry in the inspection file list, the Composer options for the entry and its packs, and the schema enum values that accept any of these fifteen ids. Tests, documentation, and MCP listings for all of the above are removed with the code they cover, not left in place as dead references.

No compatibility flag, deprecated path, or legacy profile survives this removal. A recipe that names `oxlint` or any of the fourteen pack ids is rejected the same way any other unknown id is rejected; there is no fallback that silently accepts the old name or produces a Modern profile response identical to before.

The Modern profile keeps its remaining defaults, Oxfmt, Stylelint, and TypeScript configuration, unchanged by this ADR. Collapsing profile identity now that a Modern project no longer differs from a `vp`-managed one in its JavaScript and TypeScript tooling is the concern of CAL-011, which reads `vitePlus.status` per ADR-0001 to decide what a project receives; this ADR removes the entry Oxlint referenced and leaves profile shape to that later work.

## Consequences

A `calavera.config.json` that names `oxlint` or any of the fourteen removed plugin pack ids fails validation with the same unknown-id error any other unrecognized integration produces. This is intentional, not an oversight to soften later: the changelog entry for this release tells a project owner to remove the id from their recipe and rely on `vp lint` for the coverage that entry used to provide, rather than offering a migration path that would keep the entry reachable in spirit if not in name.

Calavera's own repository keeps `oxlint` as a devDependency for linting Calavera's own source. That dependency is unrelated to the catalog entry this ADR removes; it lints the tool, not a project the tool scaffolds, and nothing here changes it.

`react-doctor` is unaffected. It is a separate catalog entry under the same "React best practices" group as the removed `oxlint-react` pack, but it does not depend on Oxlint or write to `oxlint.json`, so it stays exactly as it is.

Reintroduction of any of the curated rule packs happens only as a metadata edit to the Vite+ `lint` block that `vp` itself reads, tracked under #451, and never again as a Calavera-generated `oxlint.json` or any other project-level Oxlint configuration file. CAL-013 through CAL-016 continue the same removal pattern for the remaining Modern and Classic profile components this ADR does not cover: Oxfmt, the JavaScript ESLint flat config, Prettier, and TypeScript configuration scaffolding.

## Alternatives considered

**Keep Oxlint as a delegate for non-`vp` projects.** Rejected because CQ1 already resolved this question for every JavaScript and TypeScript toolchain component: Calavera offers none of them to a non-`vp` project, and instead points that project at `vp create` or `vp migrate`. Carving out an exception for Oxlint alone would reopen a settled decision rather than apply it.

**Keep the fourteen plugin entries as metadata for the `vite.config.ts` lint block, dropping only the parent entry and `oxlint.json`.** This is the shape #451 proposes, and it is rejected here because no rule-level content for a `vp` lint block exists yet to migrate the packs onto; writing that mapping without a settled interface would guess at a schema #451 has not defined. The packs are removed now, in full, and reintroduced later as a decision that names its own evidence.

**A deprecation period that accepts the old ids with a warning before removing them.** Rejected because `AGENTS.md` states removals are complete: no deprecated path, flag, or legacy mode. A warning-then-remove sequence is a deprecated path by another name.

## Open questions

None. The reintroduction of curated rule packs as Vite+ `lint` block metadata is tracked as a follow-up under #451 and is out of scope here.
