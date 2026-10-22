# ADR-0014: Stryker Mutation Testing as an Optional Integration for Vite+-Managed Projects

- **Status:** Proposed (2026-10-22)
- **Date:** 2026-10-22
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/732
- **Decides:** whether Calavera may offer Stryker mutation testing as an optional integration, and on what terms. It proposes that mutation testing is not a "test runner" under ADR-0009, that version 1 supports only projects that Calavera delegates to Vite+, and that Stryker runs only through a `test:mutation` script, outside `quality` and outside CI. Where the work sits relative to Increment 1 is left to the project owner. None of the C8 safety properties (brief Section 3) changes.

## Context

Stryker is a mutation testing tool. It makes small changes to the source code, called mutants, runs the project's existing tests against each one, and reports which mutants the tests failed to detect. A surviving mutant points to code whose behavior no test checks. Stryker does not run tests by itself: a test runner plugin, such as `@stryker-mutator/vitest-runner` or `@stryker-mutator/tap-runner`, drives the test runner the project already uses.

The feasibility study of 2026-10-22 (https://claude.ai/artifact/QTjbSSrwnSRDxtXvWaEDH2) found that a Stryker integration works today for a project that Vite+ manages, with three conditions: a scope decision, because ADR-0009 says Calavera scaffolds no test runner; a fix for installs at the root of a pnpm workspace (#731); and a workaround for TypeScript 7 (stryker-mutator/stryker-js#6111). The implementation issues #733 (ignore entries), #734 (catalog entry), and #735 (Composer and MCP) wait on this decision, and #736 (support for `node:test`) depends on it.

The scope question comes from one sentence in ADR-0009's Decision: "Calavera scaffolds no JavaScript or TypeScript linter, formatter, TypeScript configuration, or test runner for any project, whether or not that project has adopted Vite+." Brief C2 says the same for a project that `vp` manages: Calavera "does not scaffold linters, formatters, TypeScript configuration, or test runners for JavaScript and TypeScript" (`docs/evolution-brief.md` Section 3). The litmus test in `AGENTS.md` and brief C1 says why: anywhere Calavera fights with or reimplements something Vite or Vite+ does well, Calavera steps aside. Whether Stryker falls under that sentence decides whether the integration can exist at all.

This work is outside Increment 1. Section 0 of `docs/cross-repo/sequencing-map.md` names the current increment's issues, and Stryker is not among them. The project owner asked for the decision to be drafted. This ADR does not change the sequencing map.

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

Two readings of ADR-0009 are possible. This ADR calls them the "test runner" reading and the "uses the runner" reading, and recommends the second.

**The "test runner" reading: Stryker counts as a test runner, so ADR-0009 excludes it.** Stryker starts the tests, has a `testRunner` option, and needs a runner plugin before it can do anything. ADR-0009 says "for any project", without exceptions, and brief C2 names test runners by type. The strongest point is how Stryker reaches the tests. Its Vitest runner plugin does not go through `vp test`: it calls Vitest's own API, and its configuration (`testRunner`, `plugins`, and `vitest.configFile`) is a second place, next to Vite+'s, that decides how the project's tests are run. If Vite+ changed how `vp test` runs tests, that second place would not follow. On this reading, a Stryker integration starts a second test toolchain beside Vite+'s, and offering it would need ADR-0009 to be amended first.

**The "uses the runner" reading: Stryker uses the project's test runner and does not replace it.** ADR-0009 lists the parts of a JavaScript and TypeScript toolchain that Vite+ provides: the linter, the formatter, the TypeScript configuration, and the test runner. The litmus test explains why each is excluded: Calavera would be competing with Vite+. Stryker does not compete with any of them. The project's tests stay Vitest tests, run by the Vitest that vite-plus installs under npm and pnpm, and Stryker adds a measurement, the mutation score, that neither vite-plus 1.3.0 nor vitest 5.0.5 provides. Brief C6 already accepts this shape for Playwright, a test tool that "composes with `vp test` rather than replacing it". Read literally, the "test runner" reading would also exclude the planned Playwright integration, which the brief does not intend. Knip is a looser comparison: it is not a test tool, but it is kept, as ADR-0009 puts it, "for reasons independent of the JavaScript or TypeScript toolchain", because it adds a check rather than standing in for one.

This ADR adopts the "uses the runner" reading. The sentence in ADR-0009 is about what Vite+ already does, and mutation testing is not something Vite+ does. The concern behind the "test runner" reading is real, and Decisions 2 and 3 limit it: version 1 writes no test runner and no test configuration of its own, adds no direct `vitest` dependency to `package.json`, and is offered only where Vite+ already owns the runner. The second-place concern remains, and the Consequences section says where it would show. If Vite+ or Vitest later ships mutation testing, the litmus test applies and the integration is removed, with an ADR, as C1 requires.

This is an interpretation of ADR-0009, not an amendment. If the project owner prefers the "test runner" reading, the decision is to reject the integration or to amend ADR-0009 explicitly, and this ADR is withdrawn.

### 2. Version 1 supports only projects that Calavera delegates to Vite+

The integration is offered only when apply delegates to Vite+, the condition that makes `apply` install with `vp add -D` (ADR-0012, Decision 1) and makes `quality` run the Vite+ checks (ADR-0013, Decision 2). That is when ADR-0001 detection reports `managed`, or reports `unknown` for a directory without its own `package.json` whose nearest ancestor is `managed`, as in a new workspace member. `delegatesToVitePlus` in `packages/cli/src/index.js` makes that choice today. A recipe that names Stryker on any other project stops with a finding and writes nothing (#734), and the project is pointed to `vp create` or `vp migrate` first, as ADR-0009 already does for every project without Vite+.

Version 1 assumes that a project Vite+ manages tests with Vitest, because `vp test` runs Vitest. This is an assumption, not a detection: such a project's `test` script may run something else, or the project may have no tests. #734 decides how the integration behaves in those cases, and the config details, such as which runner the config names and how it lists plugins, also belong to #734.

Support for `node:test` through the tap runner is outside version 1. This ADR does not decide whether it should be added later; #736 decides that.

### 3. Stryker runs only through `test:mutation`, outside `quality` and CI

The integration adds a `test:mutation` script that runs `stryker run`, as #725 does for this repository. It does not add Stryker to `quality`, and it does not add a CI job. It writes no `thresholds.break`, so Stryker keeps its default of `null`.

Two reasons support this. A mutation run is slow: the 72-mutant sample in #725 took 47 seconds, and a real project has thousands of mutants. `quality` is the gate a developer or an agent runs after every change, so a step that takes minutes would make that gate unusable. A mutation score is also not pass or fail. Without `thresholds.break`, Stryker exits zero whatever the score, so a step in `quality` would gate nothing. Choosing a `break` value would be Calavera choosing a test-quality bar for the project, which is the project's own decision. This follows ADR-0013 Decision 7, which keeps Playwright and other test suites out of `quality`.

A scheduled CI workflow, for example one using Stryker's `--incremental` mode, is not part of version 1. It would be a separate decision.

### 4. Placement relative to Increment 1 is the owner's decision

The work is outside Increment 1, and Section 0 of the sequencing map says to work only the current increment. This ADR does not change Section 0, and it does not propose where the Stryker issues go. The project owner decides whether they wait until after the Increment 1 exit condition (H0), or run beside it. #731 affects Knip and Varlock today, whatever happens to Stryker, so its placement can be decided on its own.

Issue #732's acceptance criteria also ask for `docs/vite-plus.md` and the sequencing map to reflect the outcome. Those changes wait until the owner decides, because their content depends on the decision.

## Consequences

If this ADR is accepted, #733, #734, and #735 are unblocked on scope. #734 still depends on #731 and #733, and possibly on the CQ3 decision about whether scripts can be expressed as metadata. #736 is decided separately.

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

## Open questions

- **Yarn and Bun.** Whether Yarn and Bun resolve the runner's `vitest` peer dependency to the copy that vite-plus installs was not tested. #734 decides whether version 1 refuses those package managers or tests them first.
- **Monorepos.** The feasibility study recommends Stryker in each workspace member, not at the root. In a scratch `vp create vite:monorepo` project, `vp add -D` worked in a member, Stryker ran there with a member-level config, and `vp run -r test:mutation` ran every member that defines the script. If #734 follows that recommendation, whether #731 still blocks Stryker depends on whether #734 offers the integration at a workspace root at all.
- **Grouped updates.** Core and runner must update together. Whether Calavera's managed Dependabot configuration (`github-repository-controls`) groups them, or the project owner does, is not decided.
- **Vitest runner coverage with child processes.** The child-process coverage gap is known for the tap runner. The Vitest runner was not checked for the same gap.
- **The TypeScript checker.** Stryker's TypeScript checker (#724) has the same TypeScript 7 problem and is not part of version 1.
