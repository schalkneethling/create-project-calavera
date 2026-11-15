---
"create-project-calavera": patch
---

In a project Vite+ does not manage, apply no longer generates a `quality` script that would only run one generated script, such as `"quality": "npm run knip"`, because it adds a script without adding a check. The dry run names the omission and the one script that `quality` would have run. Apply removes a `quality` whose value is exactly the alias an earlier release wrote for the recipe, including `npm run lint` from before the Stylelint scripts were renamed, only when `.calavera/state.json` shows that Calavera wrote it. Apply now records the `quality` value it wrote, or `null`, in the state file as `qualityScript`, so a `quality` it kept as the project's own is never removed by a later apply. It keeps any other `quality` value and says in the dry run that it is not a value Calavera wrote for this recipe. A recipe that runs two or more scripts, and every project Vite+ manages, still gets `quality` (#230).
