---
"create-project-calavera": patch
"@schalkneethling/calavera-artifact-core": patch
---

`artifacts status --check-updates`, `artifacts doctor --check-updates`, and the MCP `artifact_status` tool with `checkUpdates` no longer wait indefinitely for a registry that accepts the connection and never answers. Each artifact's registry lookup now has a deadline of 15 seconds. When a lookup misses it, Calavera ends the request and reports that artifact as "update check failed" with the code `ELOOKUPTIMEOUT`, the reason "the registry did not answer the lookup for <package> within 15000 ms", and a remedy that names the command to run again, and then checks the next artifact. Before, the lookup waited for npm's own timeout of five minutes. A lookup that misses the deadline still names the npm configuration Calavera ignored that may explain it, when the lookup reports it in time. Artifact-core's `resolveArtifactPackage` accepts a `signal` that ends the lookup when it is aborted (#1138).
