---
"create-project-calavera": patch
---

Under `--manifest-choice create-here`, when a manifest above the directory declares `vite-plus` but it is not installed, the error that Calavera cannot format the files it writes now says to run `vp install` in the directory of the manifest that declares `vite-plus`. Before, it said only to run `vp install`, which pointed at the directory being inspected. That manifest can be further up than the nearest one. The error appears in `apply --dry-run`, `apply --no-install`, and `init --apply`. The Vite+ detection that `inspect_project` reports now records that manifest as `ancestor.declaringManifestPath` when `ancestor.status` is `managed` (#1084).
