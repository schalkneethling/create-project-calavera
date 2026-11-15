---
"create-project-calavera": patch
---

In a project Vite+ does not manage, apply no longer generates a `quality` script that would only run one generated script, such as `"quality": "npm run knip"`, because it adds a script without adding a check. The dry run names the omission and the one script that `quality` would have run. Apply removes such an alias that an earlier release wrote, including `npm run lint` from before the Stylelint scripts were renamed, and keeps any other `quality` value as the project's own. A recipe that runs two or more scripts, and every project Vite+ manages, still gets `quality` (#230).
