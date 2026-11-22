---
"create-project-calavera": patch
---

Under `--manifest-choice create-here`, when the manifest above the directory declares `vite-plus` but it is not installed, `apply` and `init --apply` now say to run `vp install` in that manifest's directory, where it installs `vite-plus`, instead of naming no directory, which pointed at the directory being inspected (#1084).
