---
"create-project-calavera": patch
---

`doctor` now reports an error when a legacy AI entry, such as `{ "type": "skill", "src": "skills/protected-branch-guard" }`, selects an artifact that needs wiring or inputs. `apply` refuses such an entry since #1125, so `doctor` names the same entries and the same remedy: run `artifacts migrate`, which rewrites each legacy entry as an ID entry, then apply the recipe again. Before, `doctor` only suggested running `apply`, which then stopped (#1140).
