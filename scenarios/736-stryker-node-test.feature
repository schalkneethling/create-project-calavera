# Issue #736 and the owner's decision of 2026-11-10: the Stryker integration for projects that
# Vite+ manages and that test with node:test, through Stryker's tap runner. These scenarios are the
# manual QA guide. The automated part lives in packages/cli/scripts/stryker-node-test.test.mjs,
# which applies recipes to copies of the committed vp create fixtures and runs Stryker there.

Feature: Stryker mutation testing for a project that tests with node:test

  Scenario: The dry run names the tap runner and its config before anything is written
    Given a vp create library project with a node:test test file at "tests/index.test.ts"
    When the person runs "apply --dry-run" with a recipe that selects "stryker" and sets integrationOptions.stryker.testRunner to "node:test"
    Then the dry run installs "@stryker-mutator/core" and "@stryker-mutator/tap-runner" with "vp add -D"
    And it plans stryker.config.json as a Calavera-managed file
    And an info finding says that stryker.config.json sets testRunner to "tap", and names tap.testFiles and tap.nodeArgs
    And the same finding states the tap runner's child-process coverage limit
    And nothing in the project changes on disk

  Scenario: Apply writes the tap runner config, and Stryker runs it
    Given the same project
    When apply runs the recipe and the person installs the dependencies
    Then stryker.config.json sets testRunner to "tap", lists "@stryker-mutator/tap-runner" in plugins, and has a tap block whose nodeArgs start with "--test-reporter=tap"
    And "vp exec stryker run --dryRunOnly" reports that the initial test run succeeded
    And "vp run test:mutation" kills both mutants in src/index.ts

  Scenario: The dry run warns when no file matches the test files
    Given a vp create library project without node:test test files
    When the dry run runs the same recipe
    Then it warns that no file matches the files node --test runs by default, and names integrationOptions.stryker.testFiles as the place to record other paths
    And it does not stop

  Scenario: Recorded test files replace the defaults
    Given a recipe that also sets integrationOptions.stryker.testFiles to ["checks/*.check.mjs"]
    When apply runs the recipe
    Then stryker.config.json sets tap.testFiles to ["checks/*.check.mjs"]

  Scenario: A project that Vite+ does not manage still stops
    Given a project whose package.json does not depend on vite-plus and whose test script runs "node --test"
    When the dry run or apply runs the recipe
    Then Calavera stops before writing anything
    And the message says that Calavera provides no JavaScript or TypeScript tooling to a project that has not adopted Vite+, and points to "vp create" or "vp migrate"

  Scenario: An invalid option is rejected with the values Calavera accepts
    When a recipe sets integrationOptions.stryker.testRunner to "jest"
    Then recipe validation fails and lists "vitest" and "node:test"
