---
"create-project-calavera": patch
---

When `artifacts install` or `artifacts update` cannot remove its staging folder after the install has committed, the command now finishes instead of stopping with a bare `Could not remove <folder>` error. The installed artifacts and the lock stay as written. The command prints a warning for each folder left behind, with the error code and a request to remove it, and the `--json` result carries the folders in `temporaryFolderLeftovers`, in the same shape as apply's. The dry runs report the same failure the same way. A failure that stops the command before the install commits still exits non-zero, with its own cause first and the folder it could not remove after it (#1136).
