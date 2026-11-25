---
"create-project-calavera": patch
---

The `knip.json` that the Knip integration generates now ignores `.calavera/**` as well as `.agents/**`, so `knip` no longer reports Calavera's own files in a project that installs an artifact with scripts, such as `skill-protected-branch-guard`. Apply keeps each artifact's extracted package under `.calavera/packages/`, and nothing imports its scripts, so Knip reported them as unused files.

A `knip.json` from an earlier release gains the entry on the next apply, including one that `vp fmt` reformatted after a release from 5.0.1 to 6.0.0 wrote it: apply accepts a recorded `knip.json` whose JSON equals a value an earlier release wrote. A `knip.json` with any other contents is still refused rather than overwritten.
