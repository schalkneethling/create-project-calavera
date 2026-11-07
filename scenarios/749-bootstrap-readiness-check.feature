# Issue #749: bootstrap readiness check on a scratch `vp create vite:monorepo`.
# These scenarios are the manual QA guide for the readiness record in
# docs/bootstrap-readiness-record.md. They are not run by a test runner.

Feature: Calavera's agent-first flow on a fresh Vite+ monorepo

  Background:
    Given a scratch project created with "pnpm dlx create-project-calavera@6.1.0 --package-manager pnpm --mcp-harness claude-code --yes --new vite:monorepo --directory h0 --no-interactive --git --package-manager pnpm"
    And the scaffold is committed on the branch Git created
    And work continues on a feature branch

  Scenario: The record is complete
    Given the readiness record
    When a reviewer reads it
    Then every command has its exit code and version context
    And the dry-run and apply results are attached
    And both second dry runs show no "write" and no "update"

  Scenario: Apply keeps the Vite+ hook dispatcher and package.json free of artifacts
    Given the scaffolded project before and after apply
    When "git config --local --get core.hooksPath" runs
    Then it prints ".vite-hooks/_" both times
    And package.json holds no Calavera artifact entry

  Scenario: Committing through the Vite+ pre-commit hook causes no drift
    Given the applied project committed through the Vite+ pre-commit hook
    When the payload hashes in ".calavera/state.json" are compared with the files and a second dry run runs
    Then the hashes are unchanged
    And the dry run reports no change

  Scenario: The guard protects the branch the scaffold created
    Given a scaffold whose initial branch is "master"
    And the recipe records "protectedBranch" as "master"
    When the guard's commit mode runs on "master"
    Then the commit is refused
    And the record states that the guard used "master"

  Scenario Outline: The guard refuses work on the protected branch and allows it on a feature branch
    Given the wired guard
    When "<command>" runs on "master"
    Then it is refused
    And the same command succeeds on a feature branch

    Examples:
      | command                             |
      | git commit --allow-empty -m x       |
      | git commit --allow-empty --no-verify -m x |
      | git push origin master              |

  Scenario: The guard does not run in a linked worktree
    Given a linked worktree of the scratch project with "master" checked out
    When a commit is attempted on "master" there
    Then the record states whether the guard ran
    And the record links #752, which tracks the gap

  Scenario: Every quality and Knip failure is tracked
    Given "pnpm quality" and "pnpm knip" on the applied project
    When they fail
    Then each failing file or finding is in the record with the issue that tracks it
    And the findings a fresh "vite:monorepo" already has are listed separately

  Scenario: Apply writes what the dry run showed
    Given the dry-run result and the apply result
    When a reviewer reads them
    Then both list ".vite-hooks/pre-commit", ".vite-hooks/prepare-commit-msg", ".vite-hooks/pre-push", and ".claude/settings.json"
    And the files apply wrote match what the dry run showed

  Scenario: Skipped steps are explained
    Given any step that was not run
    When the record is read
    Then it says the step was skipped and why

  Scenario: Friction is tracked
    Given a friction item named in the record
    Then it has an issue labeled "dogfood" that the record links
