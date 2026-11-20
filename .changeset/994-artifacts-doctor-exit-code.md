---
"create-project-calavera": patch
---

`artifacts doctor` now exits with status 1 when an artifact's files are missing, including a selected artifact that is not installed yet, are not managed by Calavera, or carry a local edit, in both text and `--json` output, so a script or an agent can tell a healthy project from a broken one. Text output ends with a verdict line: "Calavera artifacts doctor found no problems." on a healthy project, or a line that names each artifact with a problem. A healthy project still exits 0, and `artifacts status` still exits 0 whatever it reports (#994).
