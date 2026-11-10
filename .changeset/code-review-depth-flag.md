---
"@schalkneethling/calavera-skill-code-review": minor
---

Add `--depth quick|standard|deep` to the `code-review` skill. `quick` reads the diff and checks its claims with no caller sweep or mutation, `standard` keeps the size-based choice and stays the default, and `deep` runs the full process on every file with a targeted mutation for every P0 and P1 hypothesis. A risky change asked for `quick` is still reviewed at `standard`, and the report says so.
