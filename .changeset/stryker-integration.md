---
"create-project-calavera": minor
---

Add the optional `stryker` integration for mutation testing in projects that Vite+ manages (#734, ADR-0014). It installs `@stryker-mutator/core` and `@stryker-mutator/vitest-runner` with `vp add -D`, writes a managed `stryker.config.json` that runs the project's Vitest tests, and adds a `test:mutation` script that runs `stryker run`. `quality` does not run it. Apply adds `.stryker-tmp/` and `reports/mutation/` to `.gitignore` in a marked block, and adds `reports/mutation/` to `.htmlvalidateignore` when the recipe also selects HTML Validate.

A dry run or apply that selects `stryker` stops before writing anything in a project that Vite+ does not manage, and at the root of a workspace, where it tells you to apply Stryker in each workspace member. When no file matches Vitest's default test pattern, the dry run warns that Stryker has no tests to run, without stopping. `inspect_project` reports the same findings when given a recipe, and reports an existing Stryker config of your own. The config points `tsconfigFile` at a file that does not exist, a workaround for Stryker crashing on TypeScript 7 (stryker-mutator/stryker-js#6111); the README explains it.
