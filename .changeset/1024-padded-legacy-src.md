---
"create-project-calavera": patch
---

A legacy artifact entry whose `src` has surrounding white space, such as `{ "type": "skill", "src": " skills/project-goal " }`, now selects the same artifact as the trimmed path. Recipe validation already trimmed the `src`, but apply, `artifacts install`, `artifacts update`, and `artifacts migrate` did not, so apply stopped with "Unknown artifact selection." without naming the entry (#1024).
