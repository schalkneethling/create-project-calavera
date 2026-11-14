---
"create-project-calavera": patch
---

When `--new` fails through the Yarn runner, Calavera now runs `yarn --version` in the same directory after the failure, with stdin closed and a 5-second limit. Under Yarn 0 or 1, which have no `yarn dlx`, the error names that Yarn version as the cause and suggests Yarn 2 or later or another `--package-manager`. Under Yarn 2 or later, it no longer suggests a Yarn version problem. When the version cannot be read, the earlier hint stays and names why, and the read failure is kept as the error's cause (#911).
