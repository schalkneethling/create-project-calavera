---
"create-project-calavera": patch
---

The `knip.json` that the Knip integration generates now ignores `.calavera/**` as well as `.agents/**`, so `knip` and `quality` stay green in a project that installs an artifact with scripts, such as `skill-protected-branch-guard`. Apply keeps each artifact's extracted package under `.calavera/packages/`, and nothing imports its scripts, so Knip reported them as unused files. An unedited `knip.json` from an earlier release gains the entry on the next apply, and an edited one is still refused rather than overwritten.
