# Issue #734, ADR-0014, and the owner's decision of 2026-11-09 on #734: the Stryker integration
# for projects that Vite+ manages. These scenarios are the manual QA guide. The automated part
# lives in packages/cli/scripts/stryker-integration.test.mjs, which applies recipes to copies of
# the committed vp create fixtures.

Feature: Stryker mutation testing for a project that Vite+ manages

  Scenario: The dry run shows the Stryker setup before anything is written
    Given a vp create library project
    When the person runs "apply --dry-run" with a recipe that selects "stryker"
    Then the dry run plans stryker.config.json as a Calavera-managed file
    And it plans the package.json script "test:mutation" with the value "stryker run"
    And it installs "@stryker-mutator/core" and "@stryker-mutator/vitest-runner" with "vp add -D"
    And it adds ".stryker-tmp/" and "reports/mutation/" to .gitignore in a "# calavera:stryker:start" block
    And nothing in the project changes on disk

  Scenario: Apply writes the setup and leaves quality alone
    Given the same project
    When apply runs the recipe
    Then stryker.config.json names the vitest test runner, lists "@stryker-mutator/vitest-runner" in plugins, and points tsconfigFile at a file that does not exist
    And .calavera/state.json records the hash of stryker.config.json
    And package.json has "test:mutation": "stryker run"
    And the quality script does not run test:mutation or stryker
    And a second dry run reports every change as unchanged

  Scenario: A project that Vite+ does not manage stops and writes nothing
    Given a project whose package.json does not depend on vite-plus
    When the dry run or apply runs a recipe that selects "stryker"
    Then Calavera stops before writing anything
    And the message says that stryker needs a project that Vite+ manages and points to "vp create" or "vp migrate"

  Scenario: A workspace root stops and writes nothing
    Given the root of a vp create monorepo
    When the dry run or apply runs a recipe that selects "stryker"
    Then Calavera stops before writing anything
    And the message tells the person to apply stryker in each workspace member that has tests

  Scenario: A workspace member gets the setup
    Given the packages/utils member of a vp create monorepo
    When apply runs a recipe that selects "stryker"
    Then the member gets stryker.config.json and the test:mutation script
    And the install runs "vp add -D" without "-w"

  Scenario: The dry run warns when no file matches Vitest's default test pattern
    Given a vp create project without a file that matches "**/*.{test,spec}.?(c|m)[jt]s?(x)"
    When the dry run runs a recipe that selects "stryker"
    Then the inspection findings include a warning that Stryker will find no tests
    And the dry run does not stop
    When the person adds "tests/index.test.ts" and runs the dry run again
    Then the warning is gone

  Scenario: A local edit to stryker.config.json is a managed-file conflict
    Given a project where the recipe with "stryker" was applied
    And the person changed stryker.config.json
    When apply runs again
    Then Calavera refuses to overwrite stryker.config.json and reports a managed-file conflict

  Scenario: The mutation run works in a real project
    Given a vp create library with its shipped test, after apply and an install
    When the person runs "vp run test:mutation"
    Then Stryker reports a mutation score
    And vp check passes, because .gitignore lists the report folder and the temporary folder
