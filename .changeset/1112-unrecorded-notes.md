---
"create-project-calavera": minor
---

`artifacts status`, `artifacts doctor`, `doctor`, and the `artifact_status` MCP tool now print a note for each file of a selected artifact without a lock entry that already exists without a state record, which `apply` stops on unless the file matches the package. The note says whether the file matches the version in the project's artifact cache, compared offline against a temporary copy of the cache, and how to keep the file. Each artifact in the `--json` results gains `unrecordedFiles`, a list of `{ path, comparedVersion, matches, reason }`, which is empty when no file needs the note. The doctors still contact no registry and write nothing into the project, and a note never changes `ok` or the exit status.
