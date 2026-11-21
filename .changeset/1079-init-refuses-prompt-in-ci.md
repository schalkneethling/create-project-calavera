---
"create-project-calavera": patch
---

`init` now follows the rule `--new` already follows for when Calavera cannot ask a question: a set `CI` environment variable counts, as a missing terminal does. In a CI job with a pseudo-terminal, `init` without `--yes` used to show its prompts and wait on them forever. It now refuses with the message from #998, which names `CI is set`, `--yes`, and the flag that answers the prompt. With every recipe prompt answered by a flag, `init` asks no further questions in CI, such as which test runner Stryker drives, and keeps the defaults (#1079).
