---
"create-project-calavera": patch
---

`--init` and `eject` now treat a `calavera` MCP entry as Calavera's only when it pins a version Calavera released. An entry pinned to any other version, such as a local build's `create-project-calavera@7.0.0-local.1` or an unpublished prerelease, is a local edit: `--init` leaves it unchanged and lists it as skipped with a remedy, and `eject` keeps it and reports it as edited. Before, `--init` rewrote such an entry and `eject` removed it (#1219).
