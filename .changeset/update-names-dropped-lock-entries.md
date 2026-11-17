---
"create-project-calavera": minor
---

`artifacts install` and `artifacts update` still remove the lock entry of an artifact the recipe no longer selects, but they now name each such entry, as "Removed the lock entry for <id> <version> (<tag>)", or "Would remove" in a dry run, and say that its installed files stay in place. Before, they removed it without a word. `artifacts status` and `artifacts doctor` mark such an artifact as not selected and say that the next install or update removes its lock entry. `--json` adds `selected` to each status artifact and `removedLockEntries` to the install and update result (#992).
