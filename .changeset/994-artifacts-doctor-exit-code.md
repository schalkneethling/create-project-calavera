---
"create-project-calavera": patch
---

`artifacts doctor` now exits with status 1 when an installed artifact's files are missing, are not managed by Calavera, or carry a local edit, in both text and `--json` output, so a script or an agent can tell a healthy project from a broken one. Text output ends with a verdict line: "Calavera artifacts doctor found no problems." on a healthy project, or a line that names each artifact with a problem. A selected artifact that is not installed yet, the normal state between `init` and `apply`, does not fail doctor: text output names it in a note with the command that installs it, and `ok` in `--json` output stays `true` for it, in `artifacts status` as well. A healthy project still exits 0, and `artifacts status` still exits 0 when it reports these problems (#994).
