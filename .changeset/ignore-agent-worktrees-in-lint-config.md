---
"create-project-calavera": patch
---

The generated `.stylelintrc.json` and `.htmlvalidateignore` now ignore `.claude/worktrees/`, where agent worktrees keep full checkouts of other branches. Without the entry, a lint run that names a path there, such as `html-validate ".claude/worktrees/**/*.html"`, reports the errors of a different branch as errors of your project. Calavera treats the two files as managed. A project whose files are unedited since the last apply sees both as changed in the dry run and gains the entry on apply, and a file with local edits is kept and reported, as before.
