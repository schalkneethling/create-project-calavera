# ADR-0011: Collapse Profiles to Minimal and Default

- **Status:** Accepted (2026-09-29, merged in #535)
- **Date:** 2026-09-27
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/529
- **Decides:** removal of the `modern` and `classic` profile ids under C1, their replacement by one profile with the id `default` beside `minimal`, and the reporting of the ADR-0001 Vite+ detection result in `explain_recipe`, `compose_recipe`, and `dry_run_apply`. This is CAL-011, the collapse that ADR-0002 through ADR-0006 each deferred.

## Context

Calavera shipped three profiles before this evolution brief existed: Modern (Oxlint, Oxfmt, Stylelint, TypeScript configuration), Classic (ESLint flat config, Prettier, Stylelint, TypeScript configuration), and Minimal (EditorConfig only). The Modern and Classic profiles existed to choose between two JavaScript and TypeScript toolchains. Their CSS lane was identical from the start: the "Classic profile: Stylelint" row of `docs/catalog-audit.md` records that it "selects the same `stylelint` catalog entries as the Modern Stylelint row; the profile prefix is the only difference."

The removal sequence took the toolchains away one entry at a time. ADR-0002 removed Oxlint, ADR-0003 removed Oxfmt, ADR-0004 removed the TypeScript configuration, ADR-0005 removed the ESLint flat config, and ADR-0006 removed Prettier. Each ADR recorded the profile consequence and deferred the collapse to CAL-011. ADR-0006 closed the gap: after it, `profileDefaults` in `packages/cli/src/recipe.js` held the same four ids for both profiles (`editorconfig`, `stylelint`, `stylelint-standard`, `stylelint-baseline`), both profile descriptions were the same sentence, and the only profile-specific entry left, React Doctor, was offered to both. The profile distinction carried no information.

The brief's target shape (Section 5) is "Minimal and a `vp`-aware default; Modern and Classic exist only if the audit and CQ1 keep them." The audit kept neither profile as a distinct entry; it folded the two Stylelint rows into one CSS lane entry. CQ1, resolved by Increment 1, holds that Calavera provides no JavaScript or TypeScript toolchain to any project and that a project without Vite+ runs `vp create` or `vp migrate` first. No toolchain remains for a second profile to select.

Detection exists but nothing downstream reads it. ADR-0001 decided the signal and CAL-010 implemented `detectVitePlus`, which `inspect_project` reports as findings. `compose_recipe`, `explain_recipe`, and `dry_run_apply` never consult it, so an agent composing a recipe for a `vp` project sees no statement of what Calavera leaves to Vite+, which is the question CAL-011 in the brief (Section 6, Phase 1) asks those tools to answer.

## Evidence

Before this change, `profileDefaults.modern` and `profileDefaults.classic` were equal arrays, `profileCatalog` gave both profiles the description "CSS linting defaults; Calavera does not configure JavaScript or TypeScript checks, which come from Vite+.", and `profileSpecificIntegrations` offered `react-doctor` to `["modern", "classic"]`, which is every profile except Minimal. A recipe composed with either id produced the same integrations, the same managed files, the same scripts, and the same dependencies; only the `profile` string in `calavera.config.json` and `.calavera/state.json` differed.

The ADR-0001 detection result has three statuses, `managed`, `unmanaged`, and `unknown`, and one diagnostic finding, `vite-plus-signal-conflict`, raised when the verdict is `unmanaged` and a corroborating signal is present. `inspectProject` already calls `detectVitePlus(process.cwd())`, and `applyRecipeObject`, which backs `dry_run_apply`, already runs `inspectProject`, so the detection result was computed during every dry run and discarded apart from its findings.

## Decision

Remove the `modern` and `classic` profile ids and add one profile with the id `default`. Its defaults are the four ids the two removed profiles shared, and React Doctor is offered to it and not to Minimal, as before. `minimal` is unchanged. `list_profiles`, `list_integrations`, the CLI `--profile` flag, the MCP input schemas, the Composer profile choices, and the configuration schema enum carry exactly `default` and `minimal`.

The id is `default`. It reads as what it is in both places a person meets it: in `list_profiles`, where it is the profile to pick without a reason to pick the other one, and in a checked-in `calavera.config.json`, where `"profile": "default"` says the project took the standard set. `vp` was rejected because the profile is also what an unmanaged project gets: CQ1 sends that project to `vp create` or `vp migrate`, but Calavera does not refuse it the CSS lane in the meantime, and a profile named `vp` would state something false about that project in its own configuration. `standard` was rejected because the default set already contains `stylelint-standard`, and a second, unrelated "standard" in the same recipe invites the reading that one implies the other.

A recipe, a CLI flag, or an MCP call naming `modern` or `classic` fails validation as an invalid profile, with a message naming the replacement, for example `Invalid profile: modern. Allowed values: default, minimal. The modern profile was removed; use default instead.` No alias, migration shim, or deprecated path accepts the old ids. The table that maps each removed id to its replacement exists only to write that message; nothing reads it to accept a value.

Report the detection result where recipes are composed, explained, and previewed. `compose_recipe` and `explain_recipe` in the standard MCP server, and `dry_run_apply` together with the CLI `apply --dry-run` output, carry a `vitePlus` report with the detection `status`, a `signalConflict` flag, and human-readable `lines`:

- `managed`: `Vite+ detection: managed. This project is vp-managed (vite-plus-dependency signal at package.json).` followed by `JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera.`
- `unmanaged`: `Vite+ detection: unmanaged. No vite-plus dependency was found in this manifest or any ancestor manifest.` followed by `Calavera provides no JavaScript or TypeScript toolchain; run vp create or vp migrate to adopt Vite+.` When a corroborating signal is present, a conflict line naming the signals sits between the two.
- `unknown`: `Vite+ detection: unknown. package.json could not be read, so Vite+ management could not be determined.`, naming the nearest ancestor manifest and its verdict when one exists.

The report changes nothing about what is composed or applied. The default profile is the same for a managed and an unmanaged project, since after CQ1 neither receives a JavaScript or TypeScript toolchain; `vp`-awareness here means naming what Vite+ provides, not selecting different content. The WebMCP tools in Composer run in the browser without a project directory, so their `compose_recipe` and `explain_recipe` responses carry no detection report.

## Consequences

A `calavera.config.json` naming `modern` or `classic` fails validation with the message above. The changelog tells a project owner to change the value to `default`; the recipe produces the same files, scripts, and dependencies as before. A `.calavera/state.json` that recorded `modern` or `classic` is not rejected, because the state file stores the last applied profile as a record, not as an input, and the next apply overwrites it.

An agent following the Calavera skill already presents `dry_run_apply` output to the user, so a `vp`-managed project now sees, at the approval boundary, that Calavera is not providing its JavaScript and TypeScript tooling and that Vite+ is. On the CHECKPOINT 1 managed fixture, `compose_recipe` offers no JavaScript or TypeScript toolchain integration, since the catalog holds none, and `dry_run_apply` reports the project as `vp`-managed. The C8 properties are untouched: `dry_run_apply` remains the approval boundary, and only its report gains lines.

The CSS lane entry the audit folded the two Stylelint rows into is now the default profile's Stylelint set. Its re-audit trigger is unchanged: when the Oxlint CSS language plugin ships and css-evolve delivers H8, C3 releases the CSS lint scaffolding to C1, and the default profile's defaults shrink with it.

Removal tests from ADR-0002 through ADR-0006 that used `modern` or `classic` as a profile literal now use `default`; their assertions are unchanged.

The hosted Composer gate named as an open question below now exists: `profileCatalog` carries a `minimumCliVersion` per profile (`4.0.0` for `default`, `2.2.0` for `minimal`), and `apps/composer/cli-compatibility.js` filters profiles and refuses to download a recipe naming an unsupported one the same way it already does for integrations and artifacts, so `default` stays hidden and unselectable in the hosted Composer until npm's published CLI reaches `4.0.0`.

## Alternatives considered

**Keep `modern` as the surviving id and remove only `classic`.** Rejected: "modern" named a toolchain choice, Oxlint and Oxfmt, that no longer exists in Calavera, and keeping the id would advertise a distinction the profile does not make. It would also leave Classic users with a rename while Modern users kept theirs, for two profiles that were already identical.

**Accept `modern` and `classic` as aliases of `default`, or accept them with a deprecation warning.** Rejected: `AGENTS.md` and C1 state that removals are complete, with no deprecated path, flag, or legacy mode. The error message naming the replacement gives the same guidance an alias would, without keeping the old ids reachable.

**Select different defaults for a managed and an unmanaged project.** Rejected: CQ1 already decided that neither receives a JavaScript or TypeScript toolchain, and the issue scopes behavior on an unmanaged project to reporting. Varying the profile by detection verdict would make a checked-in recipe mean different things in different directories.

**Report detection only through `inspect_project`.** Rejected: that is where it was, and nothing downstream read it. The brief places the statement in `explain_recipe` and `dry_run_apply` because those are the outputs an agent shows the user before approval.
