# Issue #890 and the owner's decision of 2026-11-10: the Stryker test runner choice in the Composer,
# the interactive CLI, and the Calavera skill. These scenarios are the manual QA guide. The
# automated part lives in packages/cli/scripts/stryker-runner-choice.test.mjs (the questions and
# the recorded answers, with the prompts injected) and apps/composer/test (the Composer control).
# The prompts themselves need a terminal, so run the interactive scenarios by hand.

Feature: Choosing the Stryker test runner without editing calavera.config.json

  Scenario: An interactive apply keeps Vitest when the person presses Enter
    Given a vp create library project and a recipe that selects "stryker" and records no test runner
    When the person runs "apply --dry-run" in a terminal and presses Enter at the test runner question
    Then the question lists the runners of the catalog, with Vitest marked as the default and selected
    And the dry run installs "@stryker-mutator/vitest-runner" and records no integrationOptions.stryker

  Scenario: An interactive apply records node:test and asks for the test files
    Given the same project
    When the person chooses "node:test" at the test runner question
    Then Calavera asks which paths the project's test script passes to "node --test", and shows the files "node --test" runs by default
    And an empty answer keeps those files and records no testFiles
    And a path that leaves the project, such as "../x/*.test.js", is refused with a message that names the path, and Calavera asks again
    And a valid answer, such as "scripts/*.test.mjs tests/**/*.spec.ts", is recorded as integrationOptions.stryker.testFiles
    And the dry run installs "@stryker-mutator/tap-runner", names the node:test runner, and plans calavera.config.json

  Scenario: The init wizard asks the same questions
    Given a vp create library project
    When the person runs "init" in a terminal and selects "stryker"
    Then the wizard asks for the test runner, and for the test files after "node:test", and records the answers in calavera.config.json

  Scenario: A recipe that records a runner is never asked
    Given a recipe that sets integrationOptions.stryker.testRunner to "vitest" or "node:test"
    When the person runs "apply --dry-run" in a terminal
    Then Calavera does not ask for the test runner

  Scenario: A project that already has stryker applied is not asked again
    Given a project where Calavera manages stryker.config.json, and a recipe that selects "stryker" and records no test runner
    When the person runs "apply --dry-run" in a terminal
    Then Calavera does not ask for the test runner, and the dry run uses the runner the recipe selects, Vitest when it records none

  Scenario: A run that cannot prompt keeps Vitest
    Given a recipe that selects "stryker" and records no test runner
    When the person runs "apply --dry-run --yes", or with "--json", or without a terminal
    Then Calavera does not ask and the dry run installs "@stryker-mutator/vitest-runner"

  Scenario: The Composer offers the runner when stryker is selected
    Given the Composer, with a published CLI of 6.2.0 or later
    When the person selects "Stryker mutation testing"
    Then a "Test runner" group appears with one option for each runner of the catalog, and Vitest is selected
    And the recipe records no integrationOptions.stryker while Vitest is selected
    And choosing "node:test" records integrationOptions.stryker.testRunner as "node:test"
    And clearing "Stryker mutation testing" hides the group and drops the choice from the recipe

  Scenario: The Calavera skill confirms the runner with the user
    Given an agent that uses the Calavera skill and a user who asks for Stryker
    When the agent composes the recipe
    Then the agent asks the user which test runner the project uses before the dry run, and records a runner other than Vitest in integrationOptions.stryker.testRunner
