# Source

These scripts are copied from [`schalkneethling/determinant@9382bbc`](https://github.com/schalkneethling/determinant/tree/9382bbc/protected-branch-guard), folder `protected-branch-guard/`, under the MIT license. Calavera does not depend on Determinant. ADR-0015 in the Calavera repository records why the scripts are copied and what changed.

| Determinant file            | Calavera file                                                              |
| --------------------------- | -------------------------------------------------------------------------- |
| `guard.mjs`                 | `scripts/guard.mjs`                                                        |
| `lib.mjs`                   | `scripts/lib.mjs`                                                          |
| `start-work.mjs`            | `scripts/start-work.mjs`                                                   |
| `hooks.codex.json`          | `hooks/hooks.codex.json`                                                   |
| None                        | `hooks/claude-code.settings.json`                                          |
| `install.mjs`, `git-hooks/` | Not copied. Calavera's apply installs the skill and writes the hook lines. |
| `start-work/SKILL.md`       | Replaced by this skill's `SKILL.md`.                                       |
| `guard.test.mjs`            | Not copied. Calavera tests the scripts in its own repository.              |

## Changed behavior

1. `guard.mjs` takes the protected branch as a required last argument in every mode, and protects that branch instead of the literal `main`. The argument must pass `git check-ref-format --branch` unchanged, and may contain only letters, digits, `.`, `_`, `-`, and `/`, because it is written into hook commands that a shell runs. A missing, extra, or invalid argument is an error that names the file holding the line to fix and shows the line's correct form.
2. While a rebase runs, the `commit` and `check` modes judge the branch named in `rebase-merge/head-name` instead of refusing the detached HEAD. Any other detached HEAD is still refused.
3. A new `claude-pre-tool-use` mode reads Claude Code's `PreToolUse` input for `Write`, `Edit`, and `MultiEdit` (`tool_input.file_path`) and `NotebookEdit` (`tool_input.notebook_path`). It judges the branch of the repository that holds the target path, and allows a path outside every Git working tree. It denies with `permissionDecision: "deny"` and exit code 2.
4. The `pre-tool-use` mode, which reads Codex `apply_patch` input, is renamed `codex-pre-tool-use`.
5. The `session-start` notice names the command `node .agents/skills/protected-branch-guard/scripts/start-work.mjs <slug> --base <branch>` instead of the Codex `$start-work` syntax.
6. `start-work.mjs` no longer adds the `codex/` prefix, so the slug is the branch name. It takes the base branch as a required `--base <branch>` option instead of the literal `main`.
7. `hooks/hooks.codex.json` runs the scripts from `.agents/skills/protected-branch-guard/scripts/` and passes `{{protectedBranch}}`, which the person replaces with the protected branch when they merge the fragment.
8. Usage strings name `.agents/skills/protected-branch-guard/scripts/` instead of `protected-branch-guard/`, and the files are formatted with Oxfmt.
