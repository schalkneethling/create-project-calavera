---
"create-project-calavera": patch
---

`prettier` is now a development dependency, so installing `create-project-calavera` no longer installs Prettier. Calavera's runtime never used it; only one of its tests does.
