---
"create-project-calavera": patch
---

Under `--manifest-choice create-here` below a project or workspace that Vite+ manages, `apply` now formats the `package.json` it creates with the parent's `vp fmt`: as soon as the package manager's `init` command writes it, after adding its scripts, and after the development dependency install, which adds `devDependencies` as the last key. Before, the parent's `vp check` failed on the new file, because `init` and the install write keys in an order that `vp fmt` sorts.

Any `apply` that creates `package.json` now records `createdPackageJSON` in `.calavera/state.json`, with the hash of the text Calavera or its install last wrote to the file, until an `apply` finishes the install, or at once when the recipe has no development dependencies to install. So an `apply` that stops after `init`, whose format or install fails, or that runs with `--no-install` leaves a file the next `apply` formats, as long as the file still has that text. When an install fails, the error now says to run `apply` again, which installs and formats `package.json`, before it gives the install command. A `package.json` that existed before, that you changed or put in its place, or that a finished `apply` created, keeps its key order (#1085).

The dry run reports such a `package.json` as unchanged only when the formatted text is the file's bytes. When the format changes more than the scripts, the dry run says so under the `package.json` line, such as "Would format it with vp fmt from vite-plus 1.7.0, which reorders its keys; Calavera or its install wrote its current text", and `--json` reports the sentence as the `formatting` field of the `package.json` change.

When the install of an unlocked artifact fails, the message now says that this step did not change the artifact lock, artifact outputs, or Calavera state, because `apply` may already have recorded the new `package.json` there.
