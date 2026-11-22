---
"create-project-calavera": patch
---

`doctor --json` now prints a JSON result when it cannot read, parse, or resolve the recipe, instead of only an error on standard error. The failure is an issue with the level `error`, after any issue doctor found before it, and doctor exits 1, so a CI step that parses the output has a result to parse. The text output reports the same error, and a recipe that is not valid JSON is still named with its line and column, without quoting its text (#1141).
