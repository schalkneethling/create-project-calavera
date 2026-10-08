---
"create-project-calavera": minor
---

The `github-repository-controls` integration has a new option, `requireCodeqlResults` (default `true`). It controls whether the generated policy requires CodeQL results through the ruleset code scanning rule. CodeQL is not a status check name, so `requiredChecks` stays `[]` by default and lists only other checks. A built recipe omits the option while it is `true`. Set it to `false` so that Calavera does not manage the code scanning rule; a rule that already exists stays until you delete it in the repository settings. The generated `docs/repository-controls.md` now explains this and explains how to require more checks: add the name to `requiredChecks` in the recipe and re-apply it, or use a separate ruleset that Calavera does not manage, because a check added by hand to the managed ruleset is removed on the next apply. Re-apply the recipe to update the generated documentation.
