---
"@schalkneethling/calavera-skill-code-review": minor
---

Replace the `code-review` skill with a review that reports verified findings only. It reviews a GitHub pull request URL or a local folder and branch, writes a verdict line, a risk level and findings sorted P0 to Nit with `path:line`, why it matters and the fix, reruns the branch's tests against the base code to catch a new test that tests nothing, and with `--post` builds one GitHub review with inline comments that it posts only after an explicit yes. The artifact id, skill name and install path are unchanged.
