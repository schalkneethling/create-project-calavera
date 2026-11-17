---
"create-project-calavera": patch
---

The summary that `--new` and `--init` print now lists `.calavera/state.json` once under "Changes" when the bootstrap writes or updates it, and leaves it out when it is already up to date. The `changes` field of `--init --json` carries the same entry (#957).
