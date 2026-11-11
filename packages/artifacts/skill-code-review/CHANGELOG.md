# @schalkneethling/calavera-skill-code-review

## 0.4.0

### Minor Changes

- cded74a: Add `--depth quick|standard|deep` to the `code-review` skill. `quick` reads the diff and checks its claims with no caller sweep or mutation, `standard` keeps the size-based choice and stays the default, and `deep` runs the full process on every file with a targeted mutation for every P0 and P1 hypothesis. A risky change asked for `quick` is still reviewed at `standard`, and the report says so.

## 0.3.0

### Minor Changes

- 28ad4a4: Replace the `code-review` skill with a review that reports verified findings only. It reviews a GitHub pull request URL or a local folder and branch, writes a verdict line, a risk level and findings sorted P0 to Nit with `path:line`, why it matters and the fix, reruns the branch's tests against the base code to catch a new test that tests nothing, and with `--post` builds one GitHub review with inline comments that it posts only after an explicit yes. The artifact id, skill name and install path are unchanged.

## 0.2.1

### Patch Changes

- fba4a61: Drop the upper bound from the Calavera compatibility range so the artifact installs on create-project-calavera 3.0.0 and later. Every artifact declared `<3`, and the 3.0.0 CLI rejected all of them at install time while the hosted Composer hid them as waiting for a newer CLI. The lower bound stays: it is what keeps Composer from offering an artifact before a CLI that can install it is published. A change to the manifest contract itself is signaled by `schemaVersion`, not by a CLI major. The artifact catalog in `@schalkneethling/calavera-artifact-core` carries the same ranges and changes with them.

## 0.2.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.

## 0.2.0-next.3

### Patch Changes

- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.

## 0.2.0-next.2

### Patch Changes

- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.

## 0.2.0-next.1

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.

## 0.2.0-next.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.
