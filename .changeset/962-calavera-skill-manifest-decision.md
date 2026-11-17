---
"@schalkneethling/calavera-skill-calavera": patch
"create-project-calavera": patch
---

The Calavera skill now tells the agent what to do when `dry_run_apply` returns `manifestDecision`: show the user the ancestor manifest and the three choices, `create-here`, `apply-at-ancestor`, and `abandon`, never pick one, and pass the user's choice as `manifestChoice` to `dry_run_apply` and then `apply_recipe`. The copy that `--init` installs changes the same way, and a test fails when either copy stops naming the result, the input, or a choice the CLI offers (#962).
