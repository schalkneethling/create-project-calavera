---
"create-project-calavera": patch
---

When `apply-at-ancestor` stops because a recipe file already exists at the recipe path, or at the ancestor's `calavera.config.json`, and that file is outside the ancestor's directory once every link is resolved, the message now names it as an existing file outside that directory instead of calling it the ancestor's own recipe. A path that is a link names both the link and the file it points to. Apply still stops in every case where it stopped before, so the file is never replaced, and the state-file message is unchanged (#1142).
