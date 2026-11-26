---
"create-project-calavera": patch
---

`--init` and `eject` now treat a `calavera` MCP entry as Calavera's only when it pins a version of `create-project-calavera` published on npm. An entry pinned to any other version, such as a local build's `create-project-calavera@6.2.1-local.1`, an unpublished prerelease, or the next release before it is published, is a local edit: `--init` leaves it unchanged and lists it as skipped with a remedy, and `eject` keeps it and reports it as edited, saying that the entry pins a version this release of Calavera does not know as published. Neither command contacts npm: each knows the versions published up to its own release. Before, `--init` rewrote such an entry and `eject` removed it (#1219).
