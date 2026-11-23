---
"create-project-calavera": patch
---

`init` and `init --apply` now run the same recipe path check as apply before they write `calavera.config.json`, or the recipe path given with `--config`. A recipe path that is a link that does not reach an existing file, a link to a file outside the project, or a path that a folder link leads outside the project stops `init` before anything is written, in the dry run as well, with the message apply shows. Hard links stay out of scope, as for apply (#1220).
