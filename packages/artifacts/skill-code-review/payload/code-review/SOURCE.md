# Source

This skill is copied from [`TFG-Labs/bash-claude-marketplace@db580f6`](https://github.com/TFG-Labs/bash-claude-marketplace/tree/db580f6/plugins/pr-review/skills/review), folder `plugins/pr-review/skills/review/`, by its author. The eval cases beside this payload come from the same folder.

| Marketplace file | Calavera file | Change |
| --- | --- | --- |
| `SKILL.md` | `SKILL.md` | Named `code-review`; scripts addressed as `.agents/skills/code-review/scripts/` instead of `${CLAUDE_SKILL_DIR}`; the Bash etiquette opt-ins step removed from section 6; American spelling. |
| `scripts/*.sh` | `scripts/*.sh` | Unchanged. |
| `references/*.md` | `references/*.md` | American spelling; one table row that named the Bash etiquette skill reworded. |
| `evals/` | `../../evals/` | The pull request URL case points at a public Calavera pull request; the slash command is `/code-review`. |
