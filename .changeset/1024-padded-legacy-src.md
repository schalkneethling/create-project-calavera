---
"create-project-calavera": patch
---

A legacy artifact entry whose `type` or `src` has surrounding white space, such as `{ "type": "skill", "src": " skills/project-goal " }`, now selects the same artifact as the trimmed entry. Recipe validation already trimmed both fields, but the artifact selections that apply, `artifacts install`, `artifacts update`, `artifacts status`, and the apply summary build did not trim the `src`, and neither did `artifacts migrate` or the `aiArtifacts` list of the MCP `explain_recipe` tool. As a result, apply stopped with "Unknown artifact selection." without naming the entry (#1024).
