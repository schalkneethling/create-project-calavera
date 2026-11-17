---
"@schalkneethling/calavera-skill-calavera": patch
"create-project-calavera": patch
---

The Calavera skill now tells the agent when to use the four Baseline tools: when the recipe selects `stylelint-baseline`, ask the user for a Baseline target, show the choices from `list_baseline_targets` and `describe_baseline_target`, turn the CSS features the user needs into a target with `search_baseline_features` and `recommend_baseline_target`, and record the chosen target in `integrationOptions.stylelint-baseline.available`. The copy that `--init` installs changes the same way, and a test fails when either copy stops naming a Baseline tool outside the tool list (#965).
