---
"create-project-calavera": patch
---

When `apply-at-ancestor` stops because something already exists at the given recipe path, and it is outside the ancestor's directory once every link is resolved, the message now says so instead of calling it the ancestor's own recipe. A recipe path that is itself a link is named as a link to its target, and a path that reaches outside through a folder link names its real path. Apply still stops in every case where it stopped before, so nothing there is replaced. The ancestor's own `calavera.config.json`, by any path that resolves to it, and `.calavera/state.json` keep their messages (#1142).
