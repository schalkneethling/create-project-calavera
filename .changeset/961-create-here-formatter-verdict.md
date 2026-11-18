---
"create-project-calavera": patch
---

With `--manifest-choice create-here`, the formatter now follows the parent's Vite+ verdict, as the install command and the `quality` script already do. When the manifest above the directory is managed by Vite+, `apply` formats the files it generates with `vp fmt`, and `init --apply` formats the recipe it writes the same way. When the parent is not managed by Vite+, Calavera writes them unformatted, as before. The `package.json` that the package manager's `init` command creates is not formatted (#961).
