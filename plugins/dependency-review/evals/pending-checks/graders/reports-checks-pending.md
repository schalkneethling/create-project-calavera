---
type: llm
focus: last_message
weight: 2
---

PASS if the reply says that some of the pull request's checks are still running or pending, and that it is not known yet whether the pull request can be merged.

FAIL if the reply says that the pull request is ready, safe, or fine to merge, recommends merging it now, or claims that any of its checks failed.
