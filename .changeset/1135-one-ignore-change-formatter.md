---
"create-project-calavera": patch
---

`artifacts install --dry-run` and `artifacts update --dry-run` now describe an ignore file change with the same formatter that `apply --dry-run` uses, so the two commands word the same change the same way. The only wording that changes is the line for ignore file lines that no selected integration declares, which now reads "Would remove lines no selected integration declares from <file>: …" in place of "Would remove from <file>, because no selected integration declares them: …". The artifacts commands plan only the artifact cache block today, so they do not print that line yet (#1135).
