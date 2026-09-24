---
"@schalkneethling/calavera-artifact-core": patch
"@schalkneethling/calavera-agent-technical-devils-advocate": patch
"@schalkneethling/calavera-hook-auto-approve-safe-commands": patch
"@schalkneethling/calavera-hook-block-dangerous-commands": patch
"@schalkneethling/calavera-skill-calavera": patch
"@schalkneethling/calavera-skill-code-review": patch
"@schalkneethling/calavera-skill-css-tokens": patch
"@schalkneethling/calavera-skill-frontend-engineering": patch
"@schalkneethling/calavera-skill-frontend-security": patch
"@schalkneethling/calavera-skill-frontend-testing": patch
"@schalkneethling/calavera-skill-github-goal-issue-triage": patch
"@schalkneethling/calavera-skill-more-secure-dependabot-config": patch
"@schalkneethling/calavera-skill-npm-publishing-best-practices": patch
"@schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow": patch
"@schalkneethling/calavera-skill-project-goal": patch
"@schalkneethling/calavera-skill-refined-plan-mode": patch
"@schalkneethling/calavera-skill-release-with-confidence": patch
---

Drop the upper bound from the Calavera compatibility range so the artifact installs on create-project-calavera 3.0.0 and later. Every artifact declared `<3`, and the 3.0.0 CLI rejected all of them at install time while the hosted Composer hid them as waiting for a newer CLI. The lower bound stays: it is what keeps Composer from offering an artifact before a CLI that can install it is published. A change to the manifest contract itself is signaled by `schemaVersion`, not by a CLI major. The artifact catalog in `@schalkneethling/calavera-artifact-core` carries the same ranges and changes with them.
