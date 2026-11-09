---
"create-project-calavera": minor
---

`clean` no longer leaves a project whose every commit fails. When the recipe no longer selects an artifact that wired the project, such as `skill-protected-branch-guard`, and you run `clean` before `apply`, `clean` now removes that artifact's blocks in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and its hook groups in `.claude/settings.json`, before it deletes the skill directory (ADR-0015, amended 2026-11-07). Before, it deleted `.agents/skills/protected-branch-guard/` and kept the blocks that run its script, so Git refused every commit and push until you ran `apply`. `clean` follows the same rules as `apply`: `clean --dry-run` lists each block and group it would remove, with the text, and the JSON output has a new `wiringChanges` list; only text that matches what Calavera recorded writing is removed; and an edited block or group stops `clean` with a conflict that names the file, with nothing written or deleted.

An `apply` that deselects an artifact now keeps the record of the skill directory it installed, so a later `clean` removes that directory when it is unedited, and keeps and reports it when you edited it. Before, the record was dropped, and `clean` never removed the directory.

`clean` also keeps an unedited skill directory, and says why, when a hook script in `.vite-hooks` or `.claude/settings.json` still mentions it, for example a block you kept as your own by deleting its markers. An item `clean` keeps because of local edits now keeps its record in `.calavera/state.json`, so the next `clean` reports it again instead of forgetting it.
