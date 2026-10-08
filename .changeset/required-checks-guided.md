---
"create-project-calavera": minor
---

The `github-repository-controls` integration has a new option, `requireCodeqlResults` (default `true`). It controls whether the generated policy requires CodeQL results through the ruleset code scanning rule. CodeQL is not a status check name, so `requiredChecks` stays `[]` by default and lists only other checks. Set `requireCodeqlResults` to `false` to leave scanning rules unmanaged; the generated `docs/repository-controls.md` then says so and explains how to require status checks after the first CI run. Re-apply the recipe to update the generated documentation.
