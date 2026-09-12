# @schalkneethling/calavera-artifact-core

## 0.4.0

### Minor Changes

- 9386307: Isolate independently versioned skills, hooks, and agents from the CLI runtime dependency graph while preserving explicit locked artifact installation and updates.

## 0.3.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [d65cb63]
- Updated dependencies [5d620bc]
- Updated dependencies [398c6bb]
  - @schalkneethling/calavera-skill-release-with-confidence@0.2.0

## 0.3.0-next.1

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [5d620bc]
- Updated dependencies [398c6bb]
  - @schalkneethling/calavera-skill-release-with-confidence@0.2.0-next.1

## 0.3.0-next.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- Updated dependencies [d65cb63]
  - @schalkneethling/calavera-skill-release-with-confidence@0.2.0-next.0

## 0.2.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- Updated dependencies [76d85ef]
- Updated dependencies [e3e46a7]
- Updated dependencies [71d46d1]
- Updated dependencies [dd70f1e]
  - @schalkneethling/calavera-skill-calavera@0.2.0
  - @schalkneethling/calavera-skill-code-review@0.2.0
  - @schalkneethling/calavera-skill-css-tokens@0.2.0
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0
  - @schalkneethling/calavera-skill-frontend-security@0.2.0
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0
  - @schalkneethling/calavera-skill-project-goal@0.2.0
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0

## 0.2.0-next.3

### Patch Changes

- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- Updated dependencies [e3e46a7]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.3
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.3
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.3
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.3
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.3
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.3
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.3
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.3
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.3
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.3
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.3
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.3
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.3
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.3
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.3

## 0.2.0-next.2

### Patch Changes

- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- Updated dependencies [71d46d1]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.2
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.2
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.2
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.2
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.2
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.2
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.2
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.2
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.2
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.2
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.2
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.2
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.2
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.2
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.2

## 0.2.0-next.1

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- Updated dependencies [76d85ef]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.1
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.1
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.1
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.1
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.1
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.1
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.1
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.1
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.1
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.1
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.1
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.1
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.1
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.1
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.1

## 0.2.0-next.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- Updated dependencies [dd70f1e]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.0
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.0
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.0
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.0
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.0
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.0
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.0
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.0
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.0
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.0
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.0
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.0
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.0
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.0
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.0
