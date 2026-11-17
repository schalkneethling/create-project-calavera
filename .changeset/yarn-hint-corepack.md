---
"create-project-calavera": patch
---

When `--new` fails through `yarn dlx` and `yarn --version` reports Yarn 1, the error no longer blames Yarn 1 if Corepack runs yarn. Corepack runs `yarn dlx` with Yarn 2 or later unless the project pins Yarn 1, so a failure with another cause, such as a network error, was reported as "Yarn 1 has no dlx command". Calavera now runs `yarn node` to read whether Corepack set `COREPACK_ROOT`. When Corepack ran yarn, the error says that the reported Yarn 1 may not be the Yarn that failed and how to fix a Yarn 1 pin. A Yarn 1 installed without Corepack still gets the existing hint, and when Calavera cannot tell, the error keeps the hint that states its own condition, names the reason, and keeps the underlying failure as its cause.
