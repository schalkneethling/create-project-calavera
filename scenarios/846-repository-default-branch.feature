# Issues #846 and #844: the guard's protectedBranch and github-repository-controls.defaultBranch
# get their suggested value from one rule, the repository's default branch, and never from the
# current branch (owner decisions of 2026-11-08, ADR-0015 Decisions 6 and 16).
# Every scratch repository is built with GIT_CONFIG_GLOBAL pointed at a test file and
# GIT_CONFIG_NOSYSTEM=1, so the machine's Git configuration does not change the result.
# The automated part lives in packages/cli/scripts/default-branch.test.mjs,
# packages/cli/scripts/artifact-inputs.test.mjs, packages/cli/scripts/repository-controls-inputs.test.mjs,
# and packages/cli/scripts/check-artifact-contracts.test.mjs.

Feature: Calavera suggests the repository's default branch, never the current branch

  Background:
    Given Git has no global or system configuration except what a scenario sets

  Rule: The resolver proposes the first source that answers

    Scenario: A fresh vp create --git repository with no commits
      Given a repository created with git init on master, with no commits and no remote
      When Calavera resolves the repository's default branch
      Then the default is "master"
      And the source is "git-default-branch"

    Scenario: The documented flow, a scaffold committed on master and a feature branch checked out
      Given a repository with one commit on master
      And the branch "chore/calavera-setup" created from it and checked out
      When compose_recipe reports the input protectedBranch of skill-protected-branch-guard
      Then the default is "master"
      And the default is never "chore/calavera-setup"

    Scenario: A clone of a remote whose default branch is main, on a machine whose default is master
      Given a clone of a remote whose HEAD is main
      And a feature branch checked out
      When Calavera resolves the repository's default branch
      Then the default is "main"
      And the source is "remote-default"

    Scenario: A detached HEAD after one commit on master
      Given a repository with one commit on master and HEAD detached
      When Calavera resolves the repository's default branch
      Then the default is "master"

    Scenario: The only local branch, when the machine names another branch
      Given a repository whose only local branch is "trunk" and a machine whose default is "master"
      When Calavera resolves the repository's default branch
      Then the default is "trunk"
      And the source is "only-local-branch"

    Scenario: No source answers
      Given a repository with no commits that switched to "chore/calavera-setup" before its first commit
      When compose_recipe reports the input protectedBranch
      Then it has no default, and defaultUnavailable says why
      And a non-interactive dry run stops and names ai[1].inputs.protectedBranch
      And an interactive run asks with nothing suggested

    Scenario: A Git failure is not the same as having no default
      Given a repository whose refs/remotes/origin/HEAD is corrupt
      When Calavera resolves the repository's default branch
      Then the reason includes Git's own error output
      And the reason does not say that no source names a default branch

  Rule: github-repository-controls.defaultBranch uses the same rule (#844)

    Scenario: A repository whose only branch is master, and a recipe without defaultBranch
      Given a repository whose only branch is master
      And a recipe that selects github-repository-controls without defaultBranch
      When compose_recipe composes it
      Then integrationInputs reports defaultBranch with the default "master" and its source
      And the dry run's result.recipe records defaultBranch "master"
      And the dry run reports the value as the default with its source

    Scenario: A recipe that records defaultBranch keeps it
      Given a recipe that records defaultBranch "release"
      When the dry run and apply run
      Then defaultBranch stays "release"

    Scenario: apply_recipe refuses a recipe that omits defaultBranch
      Given a recipe that selects github-repository-controls without defaultBranch
      When apply_recipe runs
      Then it stops before writing anything
      And it names integrationOptions.github-repository-controls.defaultBranch

    Scenario: No default for defaultBranch
      Given a directory where no source names a default branch
      When a non-interactive dry run runs a recipe without defaultBranch
      Then it stops and names integrationOptions.github-repository-controls.defaultBranch

    Scenario: The literal main fallback is gone
      Given a recipe without defaultBranch
      When the recipe is validated or composed
      Then the recipe does not gain defaultBranch "main"

  Rule: The dry run warns when the two branches differ

    Scenario: protectedBranch and defaultBranch differ
      Given a recipe that records protectedBranch "master" and defaultBranch "main"
      When the dry run runs
      Then inputWarnings names both values
      And apply is not stopped by the warning

  Rule: The default kind has an accurate name

    Scenario: The artifact schema replaces current-branch
      Given the artifact schema, the artifact-core catalog, and the guard's calavera-artifact.json
      When a manifest declares the default "repository-default-branch"
      Then the schema accepts it
      And a manifest that declares "current-branch" is invalid
