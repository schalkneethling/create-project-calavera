---
"create-project-calavera": patch
---

When `--new` fails under the Yarn runner, the `yarn --version` and `yarn node` reads behind the Yarn failure hint now run with `COREPACK_ENABLE_AUTO_PIN=0`, so these reads no longer let Corepack add a `packageManager` field to a `package.json` above the working directory while Calavera is only reporting the error. Corepack 0.32.0 and earlier pin by default, and Corepack 0.33.0 and later pin when `COREPACK_ENABLE_AUTO_PIN=1` is set; `0` turns auto-pin off in both. The `yarn dlx` run itself is unchanged, so Corepack can still pin during that run (#999).
