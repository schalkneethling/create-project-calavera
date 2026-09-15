# ADR-0006: Remove Prettier

- **Status:** Proposed
- **Date:** 2026-09-15
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/456
- **Decides:** removal of the Prettier integration and the entries that include it (`prettier-tailwind`, `prettier-svelte`, `prettier-astro`) under C1, applying the `remove` classification recorded for the "Classic profile: Prettier" row of `docs/catalog-audit.md`. `eslint-config-prettier` is removed separately, by CAL-015.

## Context

Prettier has been the JavaScript and TypeScript formatter in Calavera's Classic profile since before this evolution brief existed. The catalog entry `prettier` writes `.prettierrc.json` and `.prettierignore` through `createPrettierConfig`, installs the `prettier` package, and adds two scripts to `package.json`: `format`, running `prettier --write .`, and `format:check`, running `prettier --check .`. Three plugin entries, `prettier-tailwind`, `prettier-svelte`, and `prettier-astro`, each install a plugin package and append to the `plugins` array `createPrettierConfig` writes. Prettier is a Classic profile default, so a project scaffolded with that profile receives it whether or not the recipe author asked for it by name.

Until CAL-013 removed Oxfmt, the two formatters could not appear together: `assertNoFormatterConflict` in `packages/cli/src/recipe.js` rejected any recipe naming both `oxfmt` and `prettier`, and the audit recorded Prettier as the fallback used when Oxfmt was absent. That framing no longer holds; with Oxfmt gone, Prettier is the only formatter left in the catalog and the only producer of the `format` and `format:check` scripts.

Decision C2 holds that in a `vp`-managed project, Calavera scaffolds no JavaScript or TypeScript formatter and writes no script duplicating a `vp` command. Decision C7 holds that an integration is metadata over `vp` primitives, deleted rather than defended once Vite+ absorbs what it does. CQ1, resolved by Increment 1, closes the remaining gap for the formatter specifically: Calavera provides no formatter to any project, `vp`-managed or not, and a project without `vp` runs `vp create` or `vp migrate` first. This ADR scopes CQ1 to the formatter only, saying nothing about the ESLint flat config CAL-015 covers or the TypeScript configuration CAL-014 covers. Under C1, C2, C7, and CQ1 together, a Prettier entry writing two scripts and a configuration pair that duplicate `vp fmt` has no project left to serve.

## Evidence

Vite+'s own documentation states the replacement directly: `docs/guide/fmt.md:7` in the vite-plus package calls Oxfmt a drop-in Prettier replacement. The migration path treats the two formatters as successive, not coexisting: `migrate-rules.md:280-286` rewrites an existing `prettier` script to `vp fmt`, and `migrate-rules.md:407-410` skips formatting outright while a project still depends on Prettier, evidence the two are not meant to coexist rather than merely that one is preferred. No `vp create` project contains a `.prettierrc.json` or `.prettierignore`; formatting configuration lives instead in the `fmt: {}` block of `vite.config.ts`, the surface CAL-013 identified as the host Calavera would otherwise manage.

## Decision

Remove the `prettier` catalog entry, the three plugin entries `prettier-tailwind`, `prettier-svelte`, and `prettier-astro`, `createPrettierConfig`, both managed files it writes (`.prettierrc.json`, `.prettierignore`), the `format` and `format:check` script contributions, the Classic profile default selecting `prettier`, the `prettier` entry in the `existing-config` inspection file list (`packages/cli/src/project-inspection.js`), the Composer options and label text for the entry and its three plugins, and the schema enum values accepting any of these four ids. After this removal Calavera writes no `format` script for any project, of any profile, and the recipe's `scripts.format` and `scripts.format:check` options are removed from the configuration schema because no integration can satisfy them; a recipe that still sets them validates, since the schema accepts any boolean script flag, but produces no script, as with `scripts.typecheck` in ADR-0004. Tests, documentation, and MCP listings for all of the above are removed with the code they cover, not left as dead references.

`eslint-config-prettier` is not in scope here; it is included by the ESLint flat config CAL-015 removes, and its removal is recorded against that entry, not this one. No compatibility flag, deprecated path, or legacy profile survives this removal: a recipe naming `prettier`, `prettier-tailwind`, `prettier-svelte`, or `prettier-astro` is rejected the same way any other unknown id is rejected, with no fallback that silently accepts the old name or produces a Classic profile response identical to before.

Calavera's own repository keeps `prettier` as its own devDependency and `.prettierrc.json` for formatting Calavera's source. That dependency and file are not a catalog entry; they format the tool, not a project the tool scaffolds, and this ADR does not remove them. If they become unused for another reason, that is a separate audit.

This removal has a direct profile consequence, stated here rather than left implicit. CAL-013 already observed that after removing Oxfmt, Modern held no Modern-only entry: every remaining entry was Classic-only except React Doctor, shared by both. Removing Prettier closes the other side of that gap: Modern and Classic now have identical defaults and no profile-specific integrations of their own; React Doctor remains the only entry in the availability map, and it is shared by both profiles rather than specific to either, so the profile distinction carries no information. This ADR leaves the profiles in place; whether they still warrant separate identity, or should collapse into one, is the question CAL-011 decides, reading `vitePlus.status` per ADR-0001.

## Consequences

A `calavera.config.json` naming `prettier`, `prettier-tailwind`, `prettier-svelte`, or `prettier-astro` fails validation with the same unknown-id error any other unrecognized integration produces. The changelog tells a project owner to remove the id from their recipe and rely on `vp fmt` for the formatting these entries used to provide, rather than offering a migration path that keeps them reachable in spirit if not in name. A project owner who wants a `format` script gets it from `vp`, not from Calavera. `assertNoFormatterConflict` in `packages/cli/src/recipe.js`, already left without a successor rule when CAL-013 removed Oxfmt, has no formatters left to compare once Prettier is gone too, and is removed as dead code rather than kept as an inert guard.

## Alternatives considered

**Keep Prettier as a delegate, or as the formatter, for non-`vp` projects.** Rejected: CQ1 already resolved this for every JavaScript and TypeScript toolchain component, formatter included, `vp`-managed or not; an exception for Prettier alone would reopen a settled decision.

**A deprecation period that accepts the Prettier ids with a warning before removing them.** Rejected: `AGENTS.md` states removals are complete, no deprecated path, flag, or legacy mode, and a warning-then-remove sequence is a deprecated path by another name.

## Open questions

None beyond the CAL-011 profile-collapse decision this ADR explicitly defers. That decision is tracked separately and is out of scope here.
