---
"create-project-calavera": patch
---

`apply --dry-run` and `apply` now print their summary under the headings Project, Integrations, Files, Scripts, Artifacts, and Notes, with blank lines between them, and name each fact once. Each integration is one line, with the packages it installs in parentheses only where their names differ from the integration's; the full dependency list stays in `--json`. Each artifact is one line with its version and destination, with its inputs and wiring under it, and the lines an integration adds to an ignore file sit under that file. The package manager and the Vite+ status are no longer repeated as inspection findings. `apply` now lists the files, scripts, and artifacts it changed, as the dry run does.

The dry run now says when the project already lists every package of the install command in `devDependencies`, and that apply still runs the command, and when an artifact apply locks already has matching files in the project. In `installNotes`, the note on how apply runs the install command now names the Node.js and `vp` it uses instead of repeating the packages, and the note on the artifact cache in `pointers` no longer names `.gitignore` (#617).
