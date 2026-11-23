---
"create-project-calavera": patch
---

Apply no longer writes the recipe through a symbolic link or junction that leads outside the project or to a file that does not exist. When apply would write `calavera.config.json`, or the recipe path given with `--config` or `config`, it first stops, in the dry run as well and before anything is written, when the recipe path is a link that does not reach an existing file, a link to a file outside the project, or a path that a folder link leads outside the project. A recipe path given outside the project, by its own name and its folder's real path, is still written as given. The message names the link, its target, and the remedy. A recipe path in a folder that does not exist or cannot be opened, or a recipe path that is or leads to a folder, now stops with a Calavera error that names the path instead of a raw `ENOENT` or `EISDIR` (#1208).
