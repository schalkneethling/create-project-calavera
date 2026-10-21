// @ts-check
/** @type {import('@stryker-mutator/api/core').PartialStrykerOptions} */
const config = {
  packageManager: "pnpm",
  // WORKAROUND(knip): its Stryker plugin expects @stryker-mutator/command-runner, but the command runner ships inside @stryker-mutator/core, so knip.json ignores that name
  testRunner: "command",
  commandRunner: {
    // Mirrors the create-project-calavera test script. Instrumented code runs several
    // times slower, so the redaction timing budget cannot hold under Stryker; the
    // normal suite still enforces it, and a mutant that slows redaction times out.
    command:
      'pnpm --filter create-project-calavera exec node --test --test-skip-pattern="redactSecrets takes linear time" "scripts/*.test.mjs"',
  },
  // The command runner only sees an exit code, so it cannot map tests to mutants.
  coverageAnalysis: "off",
  mutate: ["packages/cli/src/**/*.js"],
  // WORKAROUND(@stryker-mutator/core): tsconfig preprocessing calls the TypeScript JS API, which TypeScript 7 removed; a missing file skips it, and the root tsconfig has no extends or references to rewrite | upstream: https://github.com/stryker-mutator/stryker-js/issues/6111
  tsconfigFile: "stryker-skips-tsconfig-preprocessing.json",
  reporters: ["html", "clear-text", "progress"],
};

export default config;
