---
type: llm
focus: last_message
weight: 2
---

PASS if the reply says that no checks were reported for the pull request, and that it is therefore not known whether the pull request can be merged.

FAIL if the reply says that the checks passed, that any check failed or is pending, or that the pull request is ready, safe, or fine to merge.
