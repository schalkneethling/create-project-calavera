---
"create-project-calavera": patch
---

`init` without `--apply`, in a directory that has no `package.json` of its own below a project or workspace that Vite+ manages, now formats `calavera.config.json` with the parent's `vp fmt` before it writes it, as `init --apply --manifest-choice create-here` already did. Before, it wrote the recipe unformatted, and the parent's `vp check` failed on it. When the parent's `vite-plus` is not installed, `init` now stops before it asks anything or writes anything, and says to run `vp install` in the directory of the manifest that declares `vite-plus`. Below a parent that Vite+ does not manage, `init` still writes the recipe unformatted (#1086).
