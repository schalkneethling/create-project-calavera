---
"create-project-calavera": patch
---

`clean --dry-run` and `clean` now group what they report under the headings "Wiring", "Files", and "Artifacts", and list each file and artifact once. Each wiring file is one line, with the hook blocks and settings groups clean removes from it listed under that line. A skipped item is listed on its own line with its reason, where "this item" stands for its own path, so the summary no longer repeats it in a separate "Kept …" sentence. A reason still names any other file it refers to, such as a hook that still runs a kept skill. The `--json` result keeps its shape and its `message` text, with one addition: when clean keeps every stale item, a kept artifact's entry in `changes` now carries `category`, `aiType`, and `name`, as it already did when clean also removes something (#331).
