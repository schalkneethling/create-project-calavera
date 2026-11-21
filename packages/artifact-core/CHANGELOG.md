# @schalkneethling/calavera-artifact-core

## 0.7.0

### Minor Changes

- 22cf9a6: The CLI now tells you when it is older than the version the npm `latest` dist-tag names, which happens when a package manager runs a copy it cached earlier (#675). After the command's own output, and after an error too, it prints a notice on standard error that names both versions and repeats your command pinned to `latest`; when Calavera is a project dependency, the notice also gives the command that updates it. The check asks the registry your npm configuration names, waits at most 1.5 seconds, writes no file, and prints nothing when it fails. It is skipped for `--json`, `--help`, `artifacts status` and `artifacts doctor` without `--check-updates`, and the MCP server. Set `CALAVERA_NO_VERSION_CHECK` to `1` or `true` to turn it off. Artifact-core adds `resolvePackageDistTag`, which resolves a dist-tag with the same registry settings as the artifact commands.
- 32d7e02: `artifacts status` and `artifacts doctor` now print each artifact with its locked version and channel instead of a single completion line. With `--check-updates`, each available update shows the installed and latest versions, a link to the release notes in the package's `CHANGELOG.md` on GitHub, and the command that applies it through the recipe's package manager, with `--tag next` for a `next`-channel artifact and `--config` for a recipe at another path. When an update is available and the recipe selects more than one artifact, with every locked one on one channel, status also prints the `--all` command. When every artifact is current, it says so. `--json` adds `releaseNotesUrl`, `updateCommand`, and `installCommand` to each artifact, and `updateAllCommand` and `checkUpdatesCommand` to the result. The link comes from the `repository` metadata of the published package, which `resolveArtifactPackage` in `@schalkneethling/calavera-artifact-core` now returns; without GitHub repository metadata, status still reports the update and its command (#398).
- 1e2dba1: The catalogs now carry the display labels that the Composer shows. `@schalkneethling/calavera-artifact-core` exports `ARTIFACT_TARGET_LABELS`, which maps each artifact target ID to the tool's own name, such as `claude-code` to "Claude Code". In `create-project-calavera`, each integration from `list_integrations` and `describe_integration` has a `statusLabel`, such as "Recommended" or "Framework-specific", which the MCP output schema declares, and each artifact from `list_ai_artifacts`, and from the `aiArtifacts` of `explain_recipe`, has `targets`, a list of `{ id, label }` objects that is empty for skills. The `compose_recipe` input description now says that an artifact's `target` is one of those IDs, not a directory. Recipe output does not change (#580).

### Patch Changes

- 1c0e622: `artifacts status --check-updates` and `artifacts doctor --check-updates` no longer fail for every artifact when one artifact's registry lookup fails, such as an artifact locked on `next` when npm has no `next` tag for its package. Status reports that artifact as "update check failed" with the cause, the npm configuration Calavera ignored that may explain it, and a remedy where one applies, and reports the others as usual. `--json` adds `updateCheckFailure` to each artifact and `updateAllBlockedBy` to the result, because status withholds the all-artifacts update command while a selected artifact's check failed. Because a failed check is not a problem with the installed files, `artifacts doctor --check-updates` now exits 0 when a registry lookup fails and the installed files are healthy, where it exited 1 before; its closing lines name the artifacts whose check failed. Errors that Calavera raises itself, such as an invalid `.npmrc` registry or a package identity mismatch, and local file system errors, such as a cache folder Calavera cannot write, still stop the command. Artifact-core's registry errors now carry the npm configuration notes as `npmDiagnostics` and `unsetVariables`, keep minipass-fetch's `type` when they wrap a failure, and use the code `EBADPACKUMENT`, with the original error as `cause`, when the registry returns a package document that cannot be read.

## 0.6.0

### Minor Changes

- 23b1b46: The input default kind `current-branch` is replaced by `repository-default-branch` in the artifact schema, in the artifact catalog's `ArtifactInput` type, and in the protected branch guard's `calavera-artifact.json` (#846). The new name says what Calavera suggests: the repository's default branch, which is not read from the current branch. A manifest that declares `current-branch` no longer validates against the artifact schema. The schema version stays 1. A Calavera release that predates this change reads the guard's input from its own bundled catalog, not from the installed manifest, so it keeps working with this artifact.

## 0.5.0

### Minor Changes

- 6c1d4b8: Skill artifacts can now declare inputs and wiring in `calavera-artifact.json` (ADR-0015, Decisions 4 and 6), and the artifact catalog carries them. An input such as `protectedBranch` has a prompt, an optional default, and a check. A recipe can record an answer on the artifact's entry, as in `{ "id": "skill-protected-branch-guard", "inputs": { "protectedBranch": "main" } }`, and `compose_recipe` accepts `inputs` on each AI artifact. Recipe validation refuses a value for an input the artifact does not declare. No artifact declares inputs or wiring yet, and apply does not read them yet; `skill-protected-branch-guard` will be the first artifact to use them.
- 873e517: Add `skill-protected-branch-guard`, which refuses a commit, a push, or a Claude Code file edit on the branch you protect (ADR-0015). Apply installs the skill and wires it into the project: a marked block in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and hook groups in the committed `.claude/settings.json`. The dry run shows every line and group first, and apply stops with a conflict, writing nothing, when you have edited its part.

  Calavera asks for the protected branch, with the current branch as the default, and records it in the recipe. `compose_recipe` reports the input and its default, `dry_run_apply` returns the recipe with the value filled in, and `apply_recipe` refuses a recipe that does not record it, so the branch cannot change between approval and apply. When Git would not run the hooks, because the Vite+ hook dispatcher is not installed or hooks are turned off in the clone, apply warns and names the command that fixes it.

  A rewritten `.claude/settings.json` is formatted before the dry run with the project's own `vp fmt`, so it already passes `vp check` with the project's formatter settings.

## 0.4.2

### Patch Changes

- 1d5a412: Artifact resolution and extraction now honor the npm registry configuration. The registry, the registry of the artifact scope (`@scope:registry`), and registry credentials are read from the user `.npmrc`, the project `.npmrc` in the current directory, and `npm_config_*` environment variables, so private and mirrored registries work. `${VAR}` is expanded only in the user `.npmrc` and the environment; a project `.npmrc` entry that contains it is ignored with a warning, including when npm exports the expanded value to Calavera. A registry URL with a username or password is rejected, a project `.npmrc` must use an `https` registry, and `certfile` and `keyfile` are read only from the user `.npmrc`. The dry run of `apply`, `artifacts install`, and `artifacts update`, and the `dry_run_apply` MCP tool, now report the registry (`artifactRegistries`, such as `https://registry.npmjs.org`) and configuration warnings (`artifactWarnings`). Proxy, CA, and `strict-ssl` settings from an `.npmrc` are not read; `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS` apply. Credentials never appear in error messages.

## 0.4.1

### Patch Changes

- fba4a61: Drop the upper bound from the Calavera compatibility range so the artifact installs on create-project-calavera 3.0.0 and later. Every artifact declared `<3`, and the 3.0.0 CLI rejected all of them at install time while the hosted Composer hid them as waiting for a newer CLI. The lower bound stays: it is what keeps Composer from offering an artifact before a CLI that can install it is published. A change to the manifest contract itself is signaled by `schemaVersion`, not by a CLI major. The artifact catalog in `@schalkneethling/calavera-artifact-core` carries the same ranges and changes with them.

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
