---
"create-project-calavera": minor
---

When the recipe no longer selects an artifact that wired the project, such as `skill-protected-branch-guard`, apply now removes the blocks it wrote in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and its hook groups in `.claude/settings.json` (ADR-0015, amended 2026-11-05). The dry run lists each removal with the text it removes, and your own lines and settings stay as they were. Apply removes only text that still matches what it recorded writing: an edited block or group stops apply with a conflict that names the file, and nothing is written. The state record drops the artifact's wiring with it, and selecting the artifact again writes the wiring again.

`doctor` now reports recorded wiring that is missing or edited, and a hook block whose script no longer exists, for example after `.agents/skills/protected-branch-guard/` was deleted by hand, which makes Git refuse every commit or push. Each finding names the file and the remedy. `doctor` also no longer stops with "references missing skill source" on a recipe that selects a packaged artifact, because a packaged artifact's payload comes from the artifact lock, not from a source directory in the project.
