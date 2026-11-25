---
"create-project-calavera": patch
---

In the package's `src/index.js` module export, `doctor` is added. It runs the same checks as the `doctor` command on the project in the current directory and returns the result, without printing it or setting the exit code. The command's behavior and output do not change.
