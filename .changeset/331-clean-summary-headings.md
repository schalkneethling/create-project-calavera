---
"create-project-calavera": patch
---

`clean --dry-run` and `clean` now group what they report under the headings "Wiring", "Files", and "Artifacts", and name each file and artifact once. Each wiring file is one line, with the hook blocks and settings groups clean removes from it listed under that line. A skipped item is named on its own line with its reason, so the summary no longer repeats it in a separate "Kept …" sentence. The `--json` result and its `message` field do not change (#331).
