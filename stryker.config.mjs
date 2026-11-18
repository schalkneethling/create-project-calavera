// @ts-check
// Run Stryker on the lines a change touched, and only the test files that cover them:
//
//   pnpm test:mutation --mutate packages/cli/src/<file>.js:<start>-<end> \
//     --testFiles packages/cli/scripts/<file>.test.mjs
//
// Without --testFiles, Stryker's first run of every CLI test file takes longer than its 5-minute
// dryRunTimeoutMinutes limit, so the run fails before it tests any mutant (#985).
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  // pnpm's strict node_modules layout hides sibling plugins from Stryker's default lookup.
  plugins: ["@stryker-mutator/tap-runner"],
  testRunner: "tap",
  tap: {
    testFiles: ["packages/cli/scripts/*.test.mjs"],
    // Many tests call process.chdir(). With forceBail, the runner kills a test process at its
    // first failure, and the process writes Stryker's result file into its current directory, a
    // temporary project, where the runner cannot find it. The mutant is then reported as a runtime
    // error instead of killed.
    forceBail: false,
    // Instrumented code runs several times slower, so the redaction timing budget
    // cannot hold under Stryker. The normal test suite still enforces it.
    nodeArgs: [
      "--test-reporter=tap",
      "--test-skip-pattern=redactSecrets takes linear time",
      "-r",
      "{{hookFile}}",
      "{{testFile}}",
    ],
  },
  // The tap runner tracks coverage per test file, and only inside that file's own
  // process. Code that tests reach only through a child process shows as not covered,
  // and a survivor there may be killed by a file that was not run, so check those by hand.
  coverageAnalysis: "perTest",
  // Only .js files: src/templates/*.mjs are read as text and written into projects,
  // so instrumenting them would put Stryker code into what the CLI writes.
  mutate: ["packages/cli/src/**/*.js"],
  // WORKAROUND(@stryker-mutator/core): tsconfig preprocessing calls the TypeScript JS API, which TypeScript 7 removed; a missing file skips it, and the root tsconfig has no extends or references to rewrite | upstream: https://github.com/stryker-mutator/stryker-js/issues/6111
  tsconfigFile: "stryker-skips-tsconfig-preprocessing.json",
  reporters: ["html", "clear-text", "progress"],
};

export default config;
