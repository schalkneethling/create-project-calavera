# ADR-0007: Remove ESLint from the Repository's Own Tooling

- **Status:** Accepted (2026-09-16, Schalk Neethling)
- **Date:** 2026-09-16
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/483
- **Decides:** removal of ESLint from the Calavera repository's own linting, applying the AGENTS.md litmus test to repository tooling rather than to a catalog entry. ADR-0005 decided the catalog side; this decision does not touch a catalog entry, a managed file, or anything Calavera writes into a project.

## Context

The Calavera repository lints itself with two linters, and until this decision neither one could fail a build.

Oxlint is the linter Vite+ ships, and it is the linter this repository has run from `pnpm lint` since the Oxlint entry existed in the catalog. The configuration it ran against did not exist. Oxlint auto-discovers `.oxlintrc.json`; the repository carried `oxlint.json`, a name oxlint reads only when it is passed explicitly with `-c`. The result was silent: `pnpm exec oxlint .` printed nothing and exited 0, while `pnpm exec oxlint -c oxlint.json .` printed 129 jsdoc warnings, because the unread file enabled a `jsdoc` plugin that had therefore never run against this source tree.

Severity compounded the problem. Every oxlint rule, correctness rules included, reports at warning severity by default, and warnings exit 0. The root `lint` script passed neither `--deny-warnings` nor `-D correctness`, so no rule violation of any kind could fail `pnpm quality`, and none could fail the `Check` workflow that runs `pnpm check` on every pull request.

ESLint held the rules that actually described this repository's house style, and nothing ran it. It was wired only as the root script `lint:js` (`eslint .`), which no other script calls: not `lint`, not `quality`, not `check`, not a workflow. `eslint.config.js` was `@eslint/js` recommended plus browser and Node builtin globals plus one project rule, `no-console` with `clear` and `info` allowed. The dependencies `eslint`, `@eslint/js`, and `globals` served that file and nothing else. Two files in the tree carry `eslint-disable` directives written against rules that had not been enforced since the script stopped being called.

Run by hand, ESLint reported seven findings across the tracked sources: `no-console` at `packages/cli/src/utils/logger.js:8` and `:11`, and `no-regex-spaces` at `packages/cli/scripts/check-config-schema.test.mjs:371`, `:372`, `:373`, `:390`, and `scripts/check-release-contracts.mjs:19`. Every one of the seven is reproducible under oxlint, exactly and with no remainder.

## Evidence

An oxlint configuration enabling `no-console` with `allow: ["clear", "info"]` and `no-regex-spaces` at error severity reports those same seven findings and no others. The rule names, the option shape, and the option semantics are the same: oxlint's diagnostic reads `Unexpected console statement. help: Supported methods are: clear, info.`, and `console.info` and `console.clear` calls elsewhere in the tree are not reported.

Oxlint honors the ESLint disable directives already in the tree. A probe against oxlint 1.76.0 confirmed all three forms in use or needed here: a file-level `/* eslint-disable no-console */` block, an `// eslint-disable-next-line no-console -- description` line with the `--` description suffix, and a block directive carrying the same `--` suffix. The two existing directives, at `packages/baseline-core/scripts/build-data.mjs:146` and `packages/cli/src/templates/repository-controls.mjs:2`, therefore keep working unchanged, and the directive vocabulary the repository already uses stays valid.

`--deny-warnings` supplies the missing gate. Run against a file whose only findings are default-severity correctness warnings, `pnpm exec oxlint` exits 0 and `pnpm exec oxlint --deny-warnings` exits 1. The flag also composes with `--fix`: `oxlint --fix --deny-warnings` applies the fixes it can and exits non-zero on what remains.

The jsdoc evidence points the other way, and is recorded here rather than acted on. The plugin has never run against this tree, and turning it on now reports 129 sites with no descriptions. Enabling it would mean either 129 filler descriptions or a permanently muted rule, and neither is a side effect a lint-plumbing change should decide.

## Decision

Rename `oxlint.json` to `.oxlintrc.json` so that oxlint reads the configuration it discovers, drop the `jsdoc` plugin from it, and add the two rules ESLint held: `no-console` with `clear` and `info` allowed, and `no-regex-spaces`, both at error severity. Add `--deny-warnings` to the root `lint` and `lint:fix` scripts so that a correctness finding, which oxlint reports at warning severity, fails `pnpm quality` and the `Check` workflow with it.

Remove ESLint from the repository's own tooling: the `lint:js` script, `eslint.config.js`, and the `eslint`, `@eslint/js`, and `globals` devDependencies. No compatibility script, alias, or opt-in path survives the removal.

Fix the seven findings rather than suppress them, with one exception. Both `no-regex-spaces` sites take the `{2}` quantifier the rule recommends, which preserves each pattern exactly. `packages/cli/src/utils/logger.js` gains a rule-scoped `/* eslint-disable no-console -- ... */` directive, following the precedent in `packages/cli/src/templates/repository-controls.mjs`, because that module exists to wrap `console` for the rest of the CLI; suppressing the rule where the wrapper lives is what makes enforcing it everywhere else possible.

No standing test guards the arrangement. The evidence above was gathered by hand at decision time: `pnpm exec oxlint .` against the misnamed file printed nothing, `pnpm exec oxlint -c oxlint.json .` printed 129 warnings, and `--deny-warnings` turned a correctness-only run from exit 0 into exit 1. That verification belongs to the change, not to the test suite. A test that re-proved it on every run would assert that oxlint behaves as documented given the configuration in the tree, which is the same trust the repository extends to `tsc`, stylelint, and knip without a test, and it would pin configuration text in a second place. The configuration file name and the two script flags are visible in any diff that touches them.

The `jsdoc` plugin stays off. Reactivating jsdoc rules is a separate decision, made on its own evidence, with the cost of 129 sites priced into it. This ADR does not decide it either way, and dropping the plugin here removes only a setting that had no effect.

## Consequences

`pnpm quality` can now fail on a JavaScript or TypeScript lint finding, which it could not do before. The 113 rules oxlint enables by default become enforced for the first time in this repository. The tree is clean under them today, so the gate arrives green, but a rule that was previously invisible can now stop a pull request.

The seven findings are gone from the sources rather than from the report. The regex changes are exact: `/^  [a-zA-Z0-9_-]+:$/` becomes `/^ {2}[a-zA-Z0-9_-]+:$/` and the three `/^  <key>: "([^"\n]+)"$/m` patterns take the same substitution, matching the same input as before. The affected tests pass unchanged.

`eslint-disable` directives remain the repository's suppression vocabulary, because oxlint reads them. No directive in the tree needed editing, and a future suppression is written the same way it has always been written.

Nothing in the catalog changes. ADR-0005 removed the ESLint integration from the generated-project catalog, and `packages/cli/scripts/eslint-removal.test.mjs` guards that removal; it still passes. `@eslint/css`, the CSS lint host css-evolve needs under C5, is a separate integration and is untouched here, as it was untouched by ADR-0005. Nothing in this decision authorizes or forbids a later ESLint dependency arriving for CSS verification.

Stylelint is unaffected. It is a CSS linter, it already fails the build on a violation, and the `watch` classification recorded for it in `docs/catalog-audit.md` is unrelated to this decision.

## Alternatives considered

**Keep both linters and wire `lint:js` into `lint`.** Rejected because it answers the symptom and keeps the cause. Two linters means two configurations, two dependency trees, and two places a rule can be defined, for a repository whose litmus test is that Calavera steps aside wherever Vite+ does the job well. Vite+ ships oxlint, ADR-0002 already removed the Calavera-generated Oxlint configuration from scaffolded projects on that evidence, and 100 percent of ESLint's findings here port to oxlint. There is nothing left for the second linter to contribute.

**Remove ESLint but leave the lint gate as it is.** Rejected because it would delete the only linter in the repository that could report an error, and leave behind one that cannot. The removal is safe precisely because `--deny-warnings` replaces the enforcement ESLint provided in principle, even though nothing invoked it.

**Suppress the seven findings with directives instead of fixing them.** Rejected for six of the seven. A suppression is a claim that the rule is wrong at that site, and `no-regex-spaces` is right at all five of its sites; the quantifier is the fix the rule exists to prompt. The logger is the one place where the claim holds, and it is the one place a directive is used.

**Enable the `jsdoc` plugin the old configuration named, and add the 129 missing descriptions.** Rejected as out of scope. The plugin has never run, so nothing regresses by leaving it off, and adding 129 descriptions inside a lint-plumbing change would bury the change this pull request exists to review. Reactivation is a decision with its own evidence and its own review.

## Open questions

None. Whether jsdoc rules are reactivated is deliberately left open and is not decided here.
