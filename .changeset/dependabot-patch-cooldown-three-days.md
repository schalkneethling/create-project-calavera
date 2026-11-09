---
"@schalkneethling/calavera-skill-more-secure-dependabot-config": patch
---

The "More secure Dependabot config" skill now sets `semver-patch-days` to 3. The old value of 2 was shorter than GitHub's own 3-day default for version updates, so the skill waited less time before proposing a patch release than a project with no Dependabot config. Security updates skip the cooldown either way, so the change does not delay a security fix. The skill also now states that Dependabot reads an image's publish date only from Docker Hub, so an image on another registry gets no cooldown.
