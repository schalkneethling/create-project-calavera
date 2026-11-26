---
"create-project-calavera": patch
---

`init` and `init --apply` now run the same recipe path check as apply before they write `calavera.config.json`, or the recipe path given with `--config`. A recipe path that is a link that does not reach an existing file, a link to a file outside the project, or a path that a folder link leads outside the project stops `init` before anything is written, in the dry run as well, with the message apply shows, except that its remedy ends with "then run init again" instead of "then run apply again", because `init` stopped before it wrote the recipe. The same check also stops `init` when the recipe path is outside the project, which `init` used to write, when its folder does not exist, which a dry run used to preview and a real run failed on with a raw `ENOENT`, and when it is a folder. Hard links stay out of scope, as for apply (#1220).
