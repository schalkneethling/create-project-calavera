---
"create-project-calavera": patch
---

`doctor` now accepts a legacy artifact entry, such as `{ "type": "skill", "src": "skills/project-goal" }`, that apply installed. Previously, `doctor` looked for the legacy source path in the project, which no project holds because apply installs the artifact's package, and stopped with "AI item at index 0 references missing skill source: skills/project-goal.", so it exited 1 on a project that apply had set up correctly. `doctor` also treats the wiring that apply recorded for an artifact selected by a legacy entry as selected, instead of reporting that the recipe no longer selects it. An entry whose source no catalog artifact provides still makes `doctor` exit 1 (#1101).
