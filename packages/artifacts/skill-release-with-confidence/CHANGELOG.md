# @schalkneethling/calavera-skill-release-with-confidence

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
