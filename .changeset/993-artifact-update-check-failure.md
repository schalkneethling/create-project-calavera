---
"create-project-calavera": patch
---

`artifacts status --check-updates` and `artifacts doctor --check-updates` no longer fail for every artifact when one artifact's registry lookup fails, such as an artifact locked on `next` when npm has no `next` tag for its package. Status reports that artifact as "update check failed", with the cause and what to do, and reports the others as usual. `--json` adds `updateCheckFailure` to each artifact.
