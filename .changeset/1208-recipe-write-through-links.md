---
"create-project-calavera": patch
---

Apply no longer writes the recipe through a link that leads outside the project or to a file that does not exist. When apply would write `calavera.config.json`, or the recipe path given with `--config` or `config`, it first stops, in the dry run as well and before anything is written, when the recipe path is a link that does not reach an existing file, a link to a file outside the project, or a path that a folder link leads outside the project. The message names the link, its target, and the remedy. A recipe path in a folder that does not exist, or cannot be opened, now stops with a Calavera error that names the path instead of a raw `ENOENT` (#1208).
