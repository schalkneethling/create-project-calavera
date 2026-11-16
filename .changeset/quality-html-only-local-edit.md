---
"create-project-calavera": patch
---

When the recipe leaves `lint:html` out of `quality` and no other script is left for `quality` to run, apply no longer removes an existing `"quality": "npm run lint:html"` just because an earlier release wrote that value. It removes `quality` only when the `qualityScript` record in `.calavera/state.json` holds exactly the same value, so a first apply keeps the project's own `quality` and the dry run says so. When `.calavera/state.json` exists but has no `qualityScript` record, as a release before #230 wrote it, the dry run also says that the value matches one an earlier release wrote, so you can remove it yourself (#937).
