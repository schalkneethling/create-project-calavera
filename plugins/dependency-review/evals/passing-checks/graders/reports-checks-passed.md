---
type: llm
focus: last_message
weight: 2
---

PASS if the reply says that all of the pull request's checks passed and does not claim that any check failed or is pending.

FAIL if the reply says that a check failed, that the pull request cannot be merged because of its checks, or that the checks could not be read.
