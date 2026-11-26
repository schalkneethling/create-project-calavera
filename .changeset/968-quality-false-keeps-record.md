---
"create-project-calavera": patch
---

When a recipe sets `scripts.quality` to `false`, apply still leaves the `quality` script alone, and now also keeps the `qualityScript` record in `.calavera/state.json` when that record holds the project's current value. Before, apply overwrote the record with `null`, so no later apply could remove a `quality` value that Calavera wrote. Now, when the recipe turns `quality` back on and the plan omits it, apply removes that value (#968).
