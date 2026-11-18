---
"create-project-calavera": patch
---

`init` without `--yes` now refuses, exiting 1, when it would show a prompt but cannot: without a terminal, the profile prompt ended as soon as standard input closed, so the run exited 0 and wrote no `calavera.config.json`, and with `--json` the prompt was printed into the JSON output. The error names `--yes` and the flag that answers the prompt, such as `--profile`, as `--new` already does (#998).
