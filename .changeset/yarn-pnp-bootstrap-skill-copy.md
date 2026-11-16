---
"create-project-calavera": patch
---

`yarn dlx create-project-calavera --new` and `--init` now complete under Yarn 2 and later. Yarn serves Calavera from a zip archive in its cache, and installing a skill used Node's directory copy, which Yarn's Plug'n'Play file system patch does not cover, so the bootstrap failed with `ENOTDIR`. Calavera now copies a skill's files one at a time (#939).
