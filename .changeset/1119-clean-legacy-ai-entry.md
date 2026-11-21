---
"create-project-calavera": patch
---

`clean` now keeps the wiring of an artifact that a legacy recipe entry, such as `{ "type": "skill", "src": "skills/protected-branch-guard" }`, still selects. Previously, `clean` compared the legacy path with the catalog ID under which apply records wiring, so it treated the artifact as no longer selected: it planned to remove the artifact's blocks from `.vite-hooks` and its groups from `.claude/settings.json`, and dropped its `aiWiring` record from `.calavera/state.json`. `clean` still removes the wiring of an artifact the recipe no longer selects (#1119).
