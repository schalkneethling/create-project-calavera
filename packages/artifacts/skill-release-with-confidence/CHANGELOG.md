# @schalkneethling/calavera-skill-release-with-confidence

## 0.2.2

### Patch Changes

- fba4a61: Drop the upper bound from the Calavera compatibility range so the artifact installs on create-project-calavera 3.0.0 and later. Every artifact declared `<3`, and the 3.0.0 CLI rejected all of them at install time while the hosted Composer hid them as waiting for a newer CLI. The lower bound stays: it is what keeps Composer from offering an artifact before a CLI that can install it is published. A change to the manifest contract itself is signaled by `schemaVersion`, not by a CLI major. The artifact catalog in `@schalkneethling/calavera-artifact-core` carries the same ranges and changes with them.

## 0.2.1

### Patch Changes

- 7f0eb16: Update the release-gates reference to describe `pnpm release:prepare` failing before the gates and printing the Fledgling command for a new package name, instead of an automated `--bootstrap` transition.

## 0.2.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- 398c6bb: Document and adopt the automated, restartable release workflow, including deterministic Changesets formatting, direct npm trust verification, and SemVer-aware release decisions.

## 0.2.0-next.1

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- 398c6bb: Document and adopt the automated, restartable release workflow, including deterministic Changesets formatting, direct npm trust verification, and SemVer-aware release decisions.

## 0.2.0-next.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.
