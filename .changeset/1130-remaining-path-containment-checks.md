---
"create-project-calavera": patch
---

The remaining checks that ask whether a path lies inside a folder now use the one rule from #1026: a path is outside only when it is `..`, starts with `../` (or `..\` on Windows), or is absolute. Three checks also counted a name that only starts with `..` as outside, so they change for such names; none of them guards a write into the project. A `.editorconfig` in a project subfolder whose name starts with `..`, such as `..docs`, is now ignored when Calavera compares formatter settings, as Oxfmt ignores it, so apply no longer stops on that file's settings. A copy of Calavera in a folder inside `node_modules` whose name starts with `..`, such as `node_modules/..store`, now counts as the project's dependency, so the version notice adds the update command. A temporary folder left behind in the project under a name that starts with `..` is now reported as inside the project (#1130).
