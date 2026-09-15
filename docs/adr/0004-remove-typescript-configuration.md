# ADR-0004: Remove the TypeScript Configuration Component

- **Status:** Proposed
- **Date:** 2026-09-15
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/454
- **Decides:** removal of the TypeScript configuration component under C1, applying the `remove` classification recorded for both the "Modern profile: TypeScript config" and "Classic profile: TypeScript config" rows of `docs/catalog-audit.md`, one catalog entry the ADR and its removal issue cover together.

## Context

The `typescript` entry has been a default of both the Modern and the Classic profile since before this evolution brief existed. It installs `typescript` and `@types/node`, writes `tsconfig.json` from a Calavera-owned template, and, when the composed recipe sets `scripts.typecheck`, adds a `typecheck` script that runs `tsc --noEmit`. Being a default of both profiles, a project scaffolded with either receives it whether or not the recipe author asked for it by name. The `typescript-eslint` catalog entry, part of the Classic profile's ESLint flat config, includes `typescript` as a dependency of its own; that inclusion is a separate concern, addressed below.

Decision C2 holds that in a `vp`-managed project, Calavera scaffolds no TypeScript configuration and writes no script duplicating a `vp` command. Decision C7 holds that an integration is metadata over `vp` primitives, deleted once Vite+ absorbs what it does. CQ1, resolved by Increment 1, closes the remaining gap: Calavera provides no JavaScript or TypeScript toolchain component to any project, `vp`-managed or not, and a project without `vp` runs `vp create` or `vp migrate` first. This ADR applies that resolution to the TypeScript configuration component only, the way ADR-0003 scopes CQ1 to the formatter alone; the ESLint flat config, Oxfmt, and Prettier are removed separately under CAL-015, CAL-013, and CAL-016, none in scope here. Under C1, C2, C7, and CQ1 together, a `typescript` entry that exists only to write a `tsconfig.json` template and an optional `tsc --noEmit` script has no project left to serve.

## Evidence

`vp create` writes `tsconfig.json` directly, so no project-level catalog entry need contribute a second copy. `docs/guide/check.md:7-9` in the vite-plus package states that `vp check` type-checks through tsgolint, and a seeded string-to-number assignment failed as `typescript(TS2322)` with exit 1 through `vp check`, exactly the failure mode Calavera's own `typecheck` script exists to catch, with no Calavera scaffolding needed to reach it.

The tool identity differing from `tsc` is not evidence that Vite+ does it badly, and it is the only distinguishing fact the audit found between the two paths. `tsgolint` is a different binary from `tsc --noEmit`, but the worksheet's tie-breaker rule states plainly that a row may not be classified `keep` because Calavera's implementation is preferred to Vite+'s; the same rule forecloses treating a different-but-equivalent tool identity as a reason to keep an entry Vite+ already covers.

## Decision

Remove the `typescript` catalog entry, the `tsconfig.json` template and managed-file record, the `typecheck` script, the recipe's `scripts.typecheck` option (which names that script and has no other subject once it is gone), the entry's file in project inspection, the Composer option and label, and the schema enum value and property that accept the `typescript` id and `typecheck` flag. Tests, documentation, and MCP listings for all of this are removed with the code they cover, not left as dead references.

The `typescript-eslint` entry keeps installing `typescript` on its own, independent of this removal, until CAL-015 removes `typescript-eslint` itself; it needs `typescript` to parse syntax, not to type-check it.

This removal has a direct profile consequence, stated here rather than left implicit. After this ADR, which sits above CAL-013 in the removal stack, both profiles default to EditorConfig and Stylelint, and Modern has no default of its own that Classic lacks. Whether the two profiles still warrant separate identity, or should collapse into one, remains the question CAL-011 decides, per ADR-0001; this ADR removes the entry referenced and leaves profile shape to that later work.

## Consequences

A `calavera.config.json` that names `typescript`, or that sets `scripts.typecheck`, fails validation with the same unknown-id and unknown-property errors any other unrecognized recipe content produces. The schema property removal for `scripts.typecheck` is a breaking change to the recipe schema and is recorded in the Changeset for this release, alongside the enum-value removal for the `typescript` id.

Calavera's own repository keeps its own root `tsconfig.json` and `typecheck` script as its own tooling, unrelated to the catalog entry this ADR removes; those type-check Calavera's source, not a project Calavera scaffolds.

TypeScript itself is still installed wherever an entry depends on it, `typescript-eslint` included, and a Vite+-managed project already carries `typescript` as a `vp`-managed devDependency. This ADR removes only Calavera's own template and script, not the language toolchain other entries or `vp` provide.

## Alternatives considered

**Keep the entry as a delegate.** Rejected under CQ1, already resolved for every JavaScript and TypeScript toolchain component: Calavera offers none, `vp`-managed or not, and points a project at `vp create` or `vp migrate` instead.

**Keep only the `tsconfig.json` template as a convenience.** Rejected because `vp create` already writes `tsconfig.json`; a second Calavera-owned template would drift from what `vp` generates and consults, the failure mode C1 exists to prevent.

**Keep the entry because `tsc` and tsgolint are different tools.** Rejected by the tie-breaker rule: a different tool identity underneath an equivalent outcome is not a reason to keep a row, and preference for Calavera's own implementation is not valid under Section 1.

**A deprecation period** accepting the `typescript` id and `scripts.typecheck` with a warning before removing them. Rejected: `AGENTS.md` requires complete removals, with no deprecated path, flag, or legacy mode.

## Open questions

None beyond the CAL-011 profile-collapse decision this ADR explicitly defers. That decision is tracked separately and is out of scope here.
