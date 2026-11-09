# Issue #733 and ADR-0016: integrations declare their .gitignore and .htmlvalidateignore lines.
# These scenarios are the manual QA guide. The automated part lives in
# packages/cli/scripts/ignore-lines.test.mjs, which adds a test integration named
# "ignore-fixture" that declares ".fixture-tmp/" and "reports/fixture/" for .gitignore and
# "reports/fixture/" for .htmlvalidateignore. No catalog entry declares .gitignore lines before
# the Stryker entry (#734), so manual QA of the .gitignore scenarios waits for #734.

Feature: An integration adds ignore lines without overwriting the person's own lines

  Scenario: The person's .gitignore lines are kept, in order, after apply
    Given a project whose .gitignore holds "node_modules/", a comment, a blank line, and "!.env.example"
    When apply runs a recipe that selects an integration with .gitignore lines
    Then .gitignore starts with exactly the person's original text
    And the integration's lines follow between "# calavera:<id>:start" and "# calavera:<id>:end"
    And .calavera/state.json records the lines under gitignoreBlocks

  Scenario: The dry run shows the lines before anything is written
    Given the same project before apply
    When the person runs "apply --dry-run" or the agent calls dry_run_apply
    Then the output lists each line the integration adds to .gitignore and .htmlvalidateignore
    And .gitignore is unchanged on disk

  Scenario: A second dry run after apply reports no drift
    Given a project where the recipe was applied
    When the person runs "apply --dry-run" again
    Then .gitignore and .htmlvalidateignore are reported as unchanged

  Scenario: Removing the integration removes only its unedited block
    Given a project where the integration's block was applied and not edited
    When the recipe no longer selects the integration and apply runs
    Then the block, markers included, is gone
    And .gitignore is byte for byte what it was before the block was added

  Scenario: An edited block is a conflict, not a silent overwrite
    Given a project where the person changed a line inside the integration's block
    When the dry run or apply runs, with or without the integration selected
    Then Calavera stops before writing anything
    And the message names .gitignore and shows what Calavera wrote, what the file holds, and what Calavera would write

  Scenario: lint:html does not lint the paths an integration lists
    Given a project with html-validate and an integration that lists "reports/fixture/" for .htmlvalidateignore
    And an invalid HTML file at reports/fixture/report.html
    When the person runs the managed lint:html script on "**/*.html"
    Then the script passes, because html-validate skips the listed path

  Scenario: Varlock keeps its existing behavior
    Given a recipe that selects Varlock
    When apply runs
    Then Varlock merges its lines into .gitignore under "# Varlock", without markers, as before
