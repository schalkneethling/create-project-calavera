# Calavera monorepo boundaries

Calavera remains one Git repository and one pnpm workspace. Independent packages and applications have separate build and release boundaries; they do not use nested repositories or Git submodules.

## Target layout

```text
apps/
  composer/           Existing browser recipe composer
  baseline-explorer/  Static Baseline target and feature explorer
  menu-bar/           Optional Tauri macOS companion
packages/
  cli/                create-project-calavera CLI and MCP server
  baseline-core/      Baseline dataset and pure recommendation APIs
  artifact-core/      Artifact catalog, resolver, verifier, adapters, and installer
  artifacts/          Independently published skill, hook, and agent packages
```

The migration to this layout must be behavior-preserving. The public `create-project-calavera` npm name, both executable names, CLI commands, MCP contracts, Composer URL, and recipe schema URL remain stable.

## Dependency direction

- Applications may depend on shared packages; shared packages must not import application code.
- `packages/cli` may depend on `baseline-core` and `artifact-core`.
- The Composer and Baseline Explorer may depend on `baseline-core` browser-safe exports.
- The menu-bar app reads public recipe, lockfile, and state contracts. It does not import CLI internals or write project files.
- `artifact-core` reads artifact manifests and payloads but individual artifact packages do not depend on the CLI.
- Artifact packages contain data and target-neutral source content. Target adaptation belongs in `artifact-core`.

## Release and deployment boundaries

- Public npm packages use independent semver versions, Changesets, npm trusted publishing, and provenance.
- The Composer and Baseline Explorer are independently buildable static applications. Deploying either application must not publish an npm package.
- The menu-bar app has an independent application version and GitHub release stream.
- A change releases only the affected packages or applications.
- Test, build, and publish jobs remain separated so OIDC publish permission is unavailable to build-time dependencies.

## Project-state ownership

- `calavera.config.json` records user intent.
- `.calavera/artifacts.lock.json` records exact artifact package resolutions.
- `.calavera/state.json` records installed managed output and hashes used for local-edit protection.
- Companion applications may read these files but cannot silently update them.

These boundaries are contracts for the workspace migration. Moving code must not combine product changes with the structural change.
