---
"create-project-calavera": patch
"@schalkneethling/calavera-artifact-core": patch
---

`artifacts status --check-updates`, `artifacts doctor --check-updates`, and the MCP `artifact_status` tool with `checkUpdates` no longer wait indefinitely for a registry that accepts the connection and never answers. Each artifact's registry lookup now has a deadline of 15 seconds. When a lookup misses it, Calavera ends the request and reports that artifact as "update check failed" with the code `ELOOKUPTIMEOUT`, the reason "the registry did not answer the lookup for <package> within 15000 ms", and a remedy that names the command to run again, and then checks the next artifact. Before, npm's own five-minute timeout applied to each attempt, with retries. Artifact-core's `resolveArtifactPackage` accepts a `signal` that ends the lookup when it is aborted (#1138).
