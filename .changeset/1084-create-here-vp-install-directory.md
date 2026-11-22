---
"create-project-calavera": patch
---

Under `--manifest-choice create-here`, when the manifest above the directory is managed by Vite+ but `vite-plus` is not installed, the error that Calavera cannot format the files it writes now says to run `vp install` in that manifest's directory. Before, it said only to run `vp install`, which pointed at the directory being inspected. The error appears in `apply --dry-run`, `apply --no-install`, and `init --apply` (#1084).
