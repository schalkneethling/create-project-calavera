# ADR-0014: Stryker Mutation Testing as an Optional Integration for Vite+-Managed Projects

- **Status:** Accepted (2026-10-22, Schalk Neethling). Decision 2's open point and the Yarn and Bun question resolved on 2026-11-09, and the grouped-updates question and support for `node:test` on 2026-11-10 (see Resolutions).
- **Date:** 2026-10-22
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/732
- **Decides:** whether Calavera may offer Stryker mutation testing as an optional integration, and on what terms. It decides that mutation testing is not a "test runner" under ADR-0009, that version 1 supports only projects that Calavera delegates to Vite+, and that Stryker runs only through a `test:mutation` script, outside `quality` and outside CI. Where the work sits relative to Increment 1 is left to the project owner. None of the C8 safety properties (brief Section 3) changes.

## Context

Stryker is a mutation testing tool. It makes small changes to the source code, called mutants, runs the project's existing tests against each one, and reports which mutants the tests failed to detect. A surviving mutant points to code whose behavior no test checks. Stryker does not run tests by itself: a test runner plugin, such as `@stryker-mutator/vitest-runner` or `@stryker-mutator/tap-runner`, drives the test runner the project already uses.

The feasibility study of 2026-10-22 (https://claude.ai/artifact/QTjbSSrwnSRDxtXvWaEDH2) found that a Stryker integration works today for a project that Vite+ manages, with three conditions: a scope decision, because ADR-0009 says Calavera scaffolds no test runner; a fix for installs at the root of a pnpm workspace (#731); and a workaround for TypeScript 7 (stryker-mutator/stryker-js#6111). The implementation issues #733 (ignore entries), #734 (catalog entry), and #735 (Composer and MCP) wait on this decision, and #736 (support for `node:test`) depends on it.

The scope question comes from one sentence in ADR-0009's Decision: "Calavera scaffolds no JavaScript or TypeScript linter, formatter, TypeScript configuration, or test runner for any project, whether or not that project has adopted Vite+." Brief C2 says the same for a project that `vp` manages: Calavera "does not scaffold linters, formatters, TypeScript configuration, or test runners for JavaScript and TypeScript" (`docs/evolution-brief.md` Section 3). The litmus test in `AGENTS.md` and brief C1 says why: anywhere Calavera fights with or reimplements something Vite or Vite+ does well, Calavera steps aside. Whether Stryker falls under that sentence decides whether the integration can exist at all.

This work is outside Increment 1, the current planning increment (Decision 4 explains what that is). Section 0 of [`docs/cross-repo/sequencing-map.md`](../cross-repo/sequencing-map.md) names the current increment's issues, and Stryker is not among them. The project owner asked for the decision to be drafted. This ADR does not change the sequencing map.

## Evidence

The evidence comes from the feasibility study's scratch projects, from the installed packages, and from pull request #725 (issue #723), read on 2026-10-22. Pull request #725 sets up Stryker for this repository's CLI package. It is open and not merged, so `main` has no Stryker configuration yet, and its `stryker.config.mjs` is cited from that pull request's branch. #725 uses the tap runner on `node:test` files, not the Vitest runner, so its measurements describe this repository rather than a Vitest project.

**Vite+ and Vitest provide no mutation testing.** In a local pnpm project's `node_modules/.pnpm`, vite-plus 1.3.0 depends on `"vitest": "5.0.5"`. A search of vite-plus's `dist` and `docs` and of vitest 5.0.5's `dist` for `stryker` and `mutant` found nothing. A search for `mutation` matched four files in vite-plus and three in vitest, and every match was about something else: the DOM names `MutationObserver` and `MutationRecord`, and comments about mutating objects, such as "the caller can skip the mutation step". Neither project's roadmap was checked.

**The Stryker Vitest runner calls Vitest directly.** `@stryker-mutator/vitest-runner` 10.0.0 imports `createVitest` from `vitest/node` (`dist/src/vitest-wrapper.js`) and passes it `config: this.options.vitest?.configFile` (`dist/src/vitest-test-runner.js:74-75`). It therefore runs the Vitest package that is installed, through Vitest's programmatic API. It does not run `vp test`. Its manifest declares the peer dependencies `"@stryker-mutator/core": "10.0.0"` and `"vitest": ">=2.0.0"`, so core and runner must use the same exact version.

**Under npm and pnpm, the runner finds the Vitest that Vite+ installs.** In the feasibility study's scratch `vp create vite:library` project installed with npm, the project declares no `vitest` dependency, and `npm ls vitest` shows one `vitest@5.0.5`, installed for `@stryker-mutator/vitest-runner@10.0.0` and deduplicated for the `@vitest` packages that `vite-plus@1.3.0` depends on. Issue #734 records the same result for pnpm. That there is one copy follows from how npm and pnpm resolve peer dependencies. Yarn and Bun were not tested. Stryker killed both mutants in the scratch library.

**pnpm needs the runner listed in `plugins`.** Under pnpm, a config without `plugins` loads no test runner (#734). The config in #725 states the cause: "pnpm's strict node_modules layout hides sibling plugins from Stryker's default lookup".

**TypeScript 7 crashes Stryker 10.0.0.** `@stryker-mutator/core` 10.0.0 calls `parseConfigFileTextToJson` in `dist/src/sandbox/ts-config-preprocessor.js`, and TypeScript 7 removed that JavaScript API. stryker-mutator/stryker-js#6111, "Remove reliance of TypeScript 6's API for tsconfig file preprocessing", is open. The committed `vp create` fixtures declare `"typescript": "^7.0.2"` in the library (`packages/cli/fixtures/vite-plus/1.0.0/library/package.json:36`) and in both monorepo members, so every such project meets the crash. Pointing `tsconfigFile` at a file that does not exist skips the preprocessing. The config in #725 does that, with a `WORKAROUND(@stryker-mutator/core)` marker, and the same setting worked in the scratch library. #737 tracks its removal.

**Runs are slow, and the score is not pass or fail.** In #725, Stryker's dry run found 7,460 mutants in this repository's CLI package, and a sample of 72 mutants took 47 seconds with the tap runner. No Vitest project was timed, so these numbers show the scale, not what a Vitest project costs. In Stryker 10.0.0's schema, `thresholds.break` defaults to `null` (`@stryker-mutator/core/schema/stryker-schema.json`, `mutationScoreThresholds`), and the feasibility study recorded that Stryker exits non-zero only when `thresholds.break` is set.

**Stryker's default runner can report a meaningless score.** In #725, Stryker's default command runner gave every one of the 72 sampled mutants a timeout, because ten concurrent runs of the full 13-second suite exceeded every time limit. Stryker counts timeouts as detected, so it reported 100%. That was this repository's suite, but it shows why a config should name a runner plugin rather than rely on the default.

**#725 runs Stryker only on demand.** It adds `"test:mutation": "stryker run"` and leaves this repository's `quality` script unchanged.

**Knip already recognizes a Stryker config.** Knip 6.41.0's Stryker plugin is enabled by `@stryker-mutator/core`, reads `?(.)stryker.{conf,config}.{js,mjs,cjs,json}`, and maps `testRunner` to `@stryker-mutator/<testRunner>-runner` (`knip/dist/plugins/stryker/index.js`). A config with `"testRunner": "vitest"` therefore names a package that exists, so a project with both integrations does not see the runner reported as unused.

**The brief already plans a test tool that composes with `vp test`.** Brief C6 makes Playwright a Calavera integration, for end-to-end, visual regression, and accessibility testing, "expressed as an integration that composes with `vp test` rather than replacing it" (`docs/evolution-brief.md` Section 3). The brief's target catalog includes it (Section 5), and ADR-0013 Decision 7 keeps "Playwright and other test suites" out of `quality`. Playwright Test is itself a test runner, and the Playwright integration is still "explicitly not now" in Section 0 of the sequencing map. No document has yet read ADR-0009 against it.

## Decision

### 1. Mutation testing is not a test runner under ADR-0009

Two readings of ADR-0009 are possible. This ADR calls them the "test runner" reading and the "uses the runner" reading, and adopts the second.

**The "test runner" reading: Stryker counts as a test runner, so ADR-0009 excludes it.** Stryker starts the tests, has a `testRunner` option, and needs a runner plugin before it can do anything. ADR-0009 says "for any project", without exceptions, and brief C2 names test runners by type. The strongest point is how Stryker reaches the tests. Its Vitest runner plugin does not go through `vp test`: it calls Vitest's own API, and its configuration (`testRunner`, `plugins`, and `vitest.configFile`) is a second place, next to Vite+'s, that decides how the project's tests are run. If Vite+ changed how `vp test` runs tests, that second place would not follow. On this reading, a Stryker integration starts a second test toolchain beside Vite+'s, and offering it would need ADR-0009 to be amended first.

**The "uses the runner" reading: Stryker uses the project's test runner and does not replace it.** ADR-0009 lists the parts of a JavaScript and TypeScript toolchain that Vite+ provides: the linter, the formatter, the TypeScript configuration, and the test runner. The litmus test explains why each is excluded: Calavera would be competing with Vite+. Stryker does not compete with any of them. The project's tests stay Vitest tests, run by the Vitest that vite-plus installs under npm and pnpm, and Stryker adds a measurement, the mutation score, that neither vite-plus 1.3.0 nor vitest 5.0.5 provides. Brief C6 already accepts this shape for Playwright, a test tool that "composes with `vp test` rather than replacing it". Read literally, the "test runner" reading would also exclude the planned Playwright integration, which the brief does not intend. Knip is a looser comparison: it is not a test tool, but it is kept, as ADR-0009 puts it, "for reasons independent of the JavaScript or TypeScript toolchain", because it adds a check rather than standing in for one.

This ADR adopts the "uses the runner" reading. The sentence in ADR-0009 is about what Vite+ already does, and mutation testing is not something Vite+ does. The concern behind the "test runner" reading is real, and Decisions 2 and 3 limit it: version 1 adds no test runner, does not replace or edit the project's Vitest or Vite+ test configuration, adds only Stryker's own configuration, adds no direct `vitest` dependency to `package.json`, and is offered only where Vite+ already owns the runner. The second-place concern remains, and the Consequences section says where it would show. If Vite+ or Vitest later ships mutation testing, the litmus test applies and the integration is removed, with an ADR, as C1 requires.

This is an interpretation of ADR-0009, not an amendment. If the project owner prefers the "test runner" reading, the decision is to reject the integration or to amend ADR-0009 explicitly, and this ADR is withdrawn.

### 2. Version 1 supports only projects that Calavera delegates to Vite+

The integration is offered only when apply delegates to Vite+, the condition that makes `apply` install with `vp add -D` (ADR-0012, Decision 1) and makes `quality` run the Vite+ checks (ADR-0013, Decision 2). That is when ADR-0001 detection reports `managed`, or reports `unknown` for a directory without its own `package.json` whose nearest ancestor is `managed`, as in a new workspace member. `delegatesToVitePlus` in `packages/cli/src/index.js` makes that choice today. A recipe that names Stryker on any other project stops with a finding and writes nothing (#734), and the project is pointed to `vp create` or `vp migrate` first, as ADR-0009 already does for every project without Vite+.

`delegatesToVitePlus` answers whether Vite+ manages the project. It does not detect whether the project tests with Vitest. Version 1 assumes that a project Vite+ manages tests with Vitest, because `vp test` runs Vitest, but that is an assumption, not a detection: such a project's `test` script may run something else, or the project may have no tests. #734 must decide what the integration does for a managed project without Vitest tests, and it must make that check before apply writes any file, so that such a project either gets a working setup or stops with a finding and writes nothing, as an unmanaged project does. The config details, such as which runner the config names and how it lists plugins, also belong to #734.

Support for `node:test` through the tap runner is outside version 1. This ADR does not decide whether it should be added later; #736 decides that.

### 3. Stryker runs only through `test:mutation`, outside `quality` and CI

The integration adds a `test:mutation` script that runs `stryker run`, as #725 does for this repository. It does not add Stryker to `quality`, and it does not add a CI job. It writes no `thresholds.break`, so Stryker keeps its default of `null`.

Two reasons support this. A mutation run is slow: the 72-mutant sample in #725 took 47 seconds, and a real project has thousands of mutants. `quality` is the gate a developer or an agent runs after every change, so a step that takes minutes would make that gate unusable. A mutation score is also not pass or fail. Without `thresholds.break`, Stryker exits zero whatever the score, so a step in `quality` would gate nothing. Choosing a `break` value would be Calavera choosing a test-quality bar for the project, which is the project's own decision. This follows ADR-0013 Decision 7, which keeps Playwright and other test suites out of `quality`.

A scheduled CI workflow, for example one using Stryker's `--incremental` mode, is not part of version 1. It would be a separate decision.

### 4. Placement relative to Increment 1 is the owner's decision

Calavera's work is planned in increments, recorded in the sequencing map, [`docs/cross-repo/sequencing-map.md`](../cross-repo/sequencing-map.md). Section 0 of that file holds the current increment, Increment 1, "Calavera becomes `vp`-aware and lean", which started on 13 September 2026 (`docs/cross-repo/sequencing-map.md:12`). Its issues make Calavera detect Vite+, remove the JavaScript and TypeScript toolchain integrations that Vite+ already provides, and add the first Determinant gates, checks such as `protected-branch-guard` that Calavera catalogs as artifacts. Section 0 lists those issues and says to work only the current increment, so anything else noticed becomes an issue for later. The Stryker issues are not in that list.

Increment 1 ends at its exit condition, handoff H0. H0 is defined in the handoff table in Section 1 of the same file (`docs/cross-repo/sequencing-map.md:41`): a `vp`-aware, lean Calavera with the first Determinant gates, verified on a scratch `vp create` project. Its status is pending.

This ADR does not decide when the Stryker issues, #733 to #736, are scheduled relative to Increment 1: whether they wait until Increment 1 ends with H0, or run alongside it. The project owner decides that, and this ADR does not change Section 0. #731 affects Knip and Varlock today, whatever happens to Stryker, so its placement can be decided on its own.

Issue #732's acceptance criteria also ask for `docs/vite-plus.md` and the sequencing map to reflect the outcome. Those changes are not part of this ADR, so #732 stays open until they are made.

## Consequences

With this ADR accepted, #733, #734, and #735 are unblocked on scope. #734 still depends on #731 and #733, and possibly on the CQ3 decision about whether scripts can be expressed as metadata. #736 is decided separately.

The catalog gains its first integration that depends on Vite+ detection to be offered at all: none of the fourteen entries in `packages/cli/src/catalog.js` is limited to projects that Vite+ manages today. The Composer and the MCP descriptions have to say so (#735).

The integration's future is tied to Vite+ and Vitest in two ways. If either ships mutation testing, the litmus test removes the integration. If Stryker's Vitest runner stops working with the Vitest version that vite-plus installs, or if `vp test` changes how it runs tests in a way the runner does not follow, the integration breaks in every project at once, because Calavera does not choose that version. The `vp create` fixture tests in #734 are where such a break would show.

`@stryker-mutator/core` and `@stryker-mutator/vitest-runner` must stay on the same exact version, so a project with the integration needs their updates to arrive together.

The C8 safety properties are unchanged. This ADR changes no code. #734 must pass the managed-file conflict, dry-run parity, catalog, schema, and `vp-project-flow` tests unchanged.

## Alternatives considered

**The "test runner" reading: reject the integration under ADR-0009.** Not chosen, for the reasons in Decision 1. It remains a valid choice for the project owner: it keeps the catalog free of anything that drives the project's tests, at the cost of not offering a measurement that Vite+ does not provide.

**Amend ADR-0009 instead of interpreting it.** Not chosen, because the sentence already makes sense under the "uses the runner" reading. If the owner prefers the wording to be explicit, a one-sentence amendment to ADR-0009 that names mutation testing, and tools like Playwright that compose with `vp test`, as outside its scope would record the same outcome.

**Support `node:test` through the tap runner in version 1.** Not part of version 1, and left to #736. #736 records what it would need: Calavera cannot detect a `node:test` project reliably today, and the tap runner records coverage per test file and only inside that file's own process (#725).

**Add Stryker to `quality`, with a `thresholds.break` value.** Not chosen. It would make `quality` slow, and it would make Calavera pick a mutation score bar for the project.

**Add a CI job by default.** Not chosen for version 1. A scheduled or incremental workflow could follow as its own decision, once the integration has users.

## Resolutions

These were recorded on 2026-11-09, when #734 implemented the integration. The evidence comes from scratch `vp create vite:library` and `vp create vite:monorepo` projects with Stryker 10.1.1, vite-plus 1.2.0 and 1.5.1, and TypeScript 7.0.2.

### A managed project without Vitest tests

Decision 2 left this to #734. The project owner chose on 2026-11-09 (https://github.com/schalkneethling/create-project-calavera/issues/734#issuecomment-6748973632):

- **At a workspace root, the dry run and apply stop before writing anything**, with a finding that tells the person to apply Stryker in each workspace member. At the root of a `vp create vite:monorepo` project, Stryker exits with code 1 and "No tests were executed", because the root has no tests of its own, while the `packages/utils` member scores 2 of 2 mutants killed. A workspace root is a directory whose `pnpm-workspace.yaml` or whose `package.json` `workspaces` field lists member patterns, read with `workspacePackagePatterns` in `packages/cli/src/index.js` for pnpm and for npm, Yarn, and Bun. Both files are read whatever package manager apply resolves, so a `packageManager` override cannot skip the stop.
- **Every other project that Vite+ manages gets the setup.** The dry run warns, and does not stop, when no file matches Vitest's default test pattern, `**/*.{test,spec}.?(c|m)[jt]s?(x)` (vitest 5.1.0, `dist/config.cjs`), because a `test.include` in the Vite config can name other files, so a stop based on file names alone would be unreliable. A library with its `tests/` folder removed shows what the warning is about: Stryker exits with code 1 and "No tests were executed".

The catalog expresses both: `runsVitestTests: true` for the stop where apply does not delegate to Vite+ and for the warning, and `appliesAt: "package"` for the stop at a workspace root.

### Yarn and Bun

The first open question below is answered: all four package managers are supported. In a `vp create vite:library` project made with each of them, `vp add -D @stryker-mutator/core @stryker-mutator/vitest-runner` (for Yarn 4.18.1, `yarn add -D`), followed by `stryker run` with the managed config, killed both mutants. Each project held a single copy of `vitest`, the one vite-plus installs.

| Package manager                                                  | vite-plus    | vitest copies | Result        |
| ---------------------------------------------------------------- | ------------ | ------------- | ------------- |
| pnpm 12.18.0                                                     | 1.2.0, 1.5.1 | 1             | 2 of 2 killed |
| npm                                                              | 1.5.1        | 1             | 2 of 2 killed |
| Yarn 4.18.1, `nodeLinker: node-modules` as `vp create` writes it | 1.2.0        | 1             | 2 of 2 killed |
| Bun                                                              | 1.5.1        | 1             | 2 of 2 killed |

The same run confirmed the other conditions in Evidence for Stryker 10.1.1: stryker-mutator/stryker-js#6111 is still open, and without the `tsconfigFile` workaround the run still crashes with `ts.parseConfigFileTextToJson is not a function`. Under pnpm, a config without `plugins` still fails with "Cannot find TestRunner plugin "vitest"". The runner 10.1.1 still declares `"@stryker-mutator/core": "10.1.1"` as an exact peer dependency.

### Grouped updates

The third open question below is answered. The project owner decided on 2026-11-10 (https://github.com/schalkneethling/create-project-calavera/issues/880#issuecomment-6769128502) that Calavera groups the packages. When a recipe selects both `stryker` and `github-repository-controls`, the managed `.github/dependabot.yml` gets this group in its `npm` entry, so core and the runner plugin, `@stryker-mutator/vitest-runner` or, for `node:test`, `@stryker-mutator/tap-runner`, update in one pull request:

```yaml
groups:
  stryker:
    patterns:
      - "@stryker-mutator/*"
```

The reason is the exact peer dependency the Evidence section records: each runner plugin declares `"@stryker-mutator/core": "10.1.1"`, so a pull request that bumps one package without the other cannot install. The keys come from GitHub's Dependabot options reference for `groups`: GitHub configures groups per package ecosystem, `patterns` takes names with `*` as a wildcard, and a group name starts and ends with a letter.

- **The catalog declares the group.** The `stryker` entry carries `dependabotGroups: { npm: { stryker: { patterns: ["@stryker-mutator/*"] } } }`, keyed by package ecosystem because a group applies to one ecosystem. `createDependabotConfig` merges the groups of every selected integration into the matching `updates` entry and never names an integration. Two integrations that declare the same group name for one ecosystem stop the plan with an error that names both, because the merge would otherwise keep the later definition and silently drop the earlier one.
- **A recipe without `stryker` is unchanged.** Its `.github/dependabot.yml` holds the same bytes as before, which a test compares against the text the earlier release wrote.
- **The change to the managed file follows the existing rule for changed managed content.** Calavera compares the file on disk with the hash it recorded in `.calavera/state.json`. A project whose file still matches the recorded hash gets the new text on its next apply, and a project whose file Calavera never wrote, or one that was edited, stops with the managed-file conflict. `--reown-managed-file .github/dependabot.yml` lets apply replace an edited file with Calavera's text, so the person copies any edit worth keeping out of the file first. No migration step is needed, because the state record already tracks the file.
- **The group covers version updates only.** It sets no `applies-to`, and GitHub's default is `version-updates`. A Dependabot security update for one Stryker package still arrives as its own pull request.
- **A monorepo does not get the group.** `stryker` applies in a workspace member and `github-repository-controls` applies at the repository root, so one recipe never selects both in a workspace, and the root `.github/dependabot.yml` has no Stryker group even when the members use Stryker. #889 tracks that gap.
- **Only `npm` gets the group.** The `github-actions` entry has no Stryker packages. A recipe whose `dependabotEcosystems` leaves out `npm` writes no group, because there is no `npm` entry to hold it.

### `node:test` through the tap runner

Decision 2 left support for `node:test` to #736. The project owner decided on 2026-11-10 to build it (https://github.com/schalkneethling/create-project-calavera/issues/736#issuecomment-6769129037): the integration also serves a project that Vite+ manages and that tests with `node:test`, through `@stryker-mutator/tap-runner`. Decision 1's reading holds, because Stryker still uses the project's own runner and replaces nothing. Decision 2's limit also holds: the integration is offered only where apply delegates to Vite+, whichever runner the recipe names, because ADR-0009 gives no JavaScript or TypeScript tooling to a project that has not adopted Vite+. Supporting `node:test` must not become a way to scaffold a toolchain for such a project.

The person chooses the runner; Calavera does not detect it. Project inspection reads no test-runner signal, and a `test` script that runs `node --test` is not a reliable one: a project can run `node --test` from another script, or run Vitest and `node:test` side by side. The recipe records the choice as `integrationOptions.stryker.testRunner`, `"vitest"` by default or `"node:test"`, and records nothing for the default, so a recipe that keeps Vitest stays valid for a CLI release that predates the option. With `"node:test"`, the recipe may also record `testFiles`, the globs the project's `test` script passes to `node --test`. The dry run names the runner and the settings it writes into `stryker.config.json`, as an `info` finding of kind `test-runner`.

For `node:test`, apply installs `@stryker-mutator/core` and `@stryker-mutator/tap-runner` and writes `testRunner: "tap"`, the plugin in `plugins`, and a `tap` block. `tap.testFiles` defaults to the files `node --test` runs when it is given no paths, in Node.js 24 and 26, including the TypeScript patterns, because both strip types by default (https://nodejs.org/docs/latest-v24.x/api/test.html#running-tests-from-the-command-line). `tap.nodeArgs` is `--test-reporter=tap`, `-r {{hookFile}}`, and `{{testFile}}`, the defaults of the tap runner 10.1.1 (`dist/schema/tap-runner-options.json`), stated so that the dry run shows them. The tap runner 10.1.1 declares `"@stryker-mutator/core": "10.1.1"` as an exact peer dependency, as the Vitest runner does, and the `plugins` entry and the `tsconfigFile` workaround apply to it for the same reasons. When no file matches `tap.testFiles`, the dry run warns, and does not stop, as it does for Vitest. Recorded `testFiles` must stay inside the project, so a glob that starts with `/` or a drive letter or contains a `..` segment fails recipe validation, and the dry run warns when a test-file glob, recorded or default, matches a folder, because the tap runner runs `node` on every match.

The catalog expresses the choice as metadata: the `stryker` entry lists `testRunners`, each with its Stryker plugin as `dependencies`, its value of Stryker's `testRunner` option, and its default `testFiles`. The flag `runsVitestTests` became `runsProjectTests`, because the stop and the warning now apply to whichever runner the recipe selects.

In a copy of the `vp create` library fixture with a `tests/index.test.ts` that imports `../src/index.ts` with `node:test`, Stryker 10.1.1's dry run passed with the managed config, and a mutation run killed both mutants. `packages/cli/scripts/stryker-node-test.test.mjs` repeats that on every test run.

**The coverage limit.** The tap runner runs each test file in a process of its own and measures coverage only inside that process. Code that a test reaches only through a child process does not count as covered by that test file. In the same fixture, with a test that ran `src/cli.ts` through `execFileSync` and checked its output, Stryker reported all three mutants as "no coverage", a score of 0, and `--coverageAnalysis off` did not change that result. Stryker runs only the test files that cover a mutant, so a mutant in code that only such tests reach is not tested at all, and a mutant that another test file covers can survive although the test file that reaches it through a child process might have killed it. #725 recorded the same limit for this repository's own Stryker setup. The README documents it, and the dry run repeats it whenever the recipe selects `node:test`.

### Offering the runner choice

The project owner decided on 2026-11-10 (https://github.com/schalkneethling/create-project-calavera/issues/890#issuecomment-6778868894) that the runner choice ships with the Stryker integration, and that three surfaces offer it, so a person does not edit `calavera.config.json` by hand. The Composer shows a control when `stryker` is selected. An interactive `apply` asks once, when the choice is new: the recipe selects `stryker`, records no runner (a recorded `"vitest"` counts as a runner), and Calavera does not yet manage `stryker.config.json` in the project, so re-applying an existing setup never asks again and keeps the runner the recipe selects. Vitest is preselected, so pressing Enter keeps today's behavior; choosing `node:test` also asks for the test file paths, with the files `node --test` runs by default preselected, and an empty answer records no `testFiles`. Non-interactive runs never ask and keep Vitest. The interactive `init` wizard asks the same questions, because it hands its recipe to apply without a prompt. The Calavera skill tells the agent to confirm the runner with the user. Each surface reads its choices from the catalog's `testRunners`, so a runner added there reaches all three. Detecting the runner stays out of scope, as above.

## Open questions

The first three questions are kept as they were asked on 2026-10-22, and Resolutions answers all three.

- **Yarn and Bun (resolved on 2026-11-09: all four package managers are supported).** Whether Yarn and Bun resolve the runner's `vitest` peer dependency to the copy that vite-plus installs was not tested. #734 decides whether version 1 refuses those package managers or tests them first.
- **Monorepos (resolved on 2026-11-09: the integration applies in workspace members and stops at a workspace root).** The feasibility study recommends Stryker in each workspace member, not at the root. In a scratch `vp create vite:monorepo` project, `vp add -D` worked in a member, Stryker ran there with a member-level config, and `vp run -r test:mutation` ran every member that defines the script. If #734 follows that recommendation, whether #731 still blocks Stryker depends on whether #734 offers the integration at a workspace root at all.
- **Grouped updates (resolved on 2026-11-10: Calavera groups them).** Core and runner must update together. Whether Calavera's managed Dependabot configuration (`github-repository-controls`) groups them, or the project owner does, is not decided.
- **Vitest runner coverage with child processes.** The child-process coverage gap is known for the tap runner. The Vitest runner was not checked for the same gap.
- **The TypeScript checker.** Stryker's TypeScript checker (#724) has the same TypeScript 7 problem and is not part of version 1.
