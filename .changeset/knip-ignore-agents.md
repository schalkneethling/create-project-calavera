---
"create-project-calavera": patch
---

The `knip.json` that the Knip integration generates now ignores `.agents/**`, so `knip` and `quality` stay green once agent skills are installed: the scripts under `.agents/skills/` are not imported by any code, which Knip otherwise reports as unused files. An unedited `knip.json` from an earlier version gains the `ignore` entry on the next apply, and an edited one is still refused rather than overwritten.
