# Vite+ 1.0.0 `vp create` fixtures

Real `vp create` output, trimmed to the files Vite+ detection (ADR-0001) and the agent-first apply flow read. `scripts/vite-plus-fixture-drift.test.mjs` compares the ADR-0001 signals here with the hand-written fixtures in `scripts/vite-plus-fixtures.mjs`, and `scripts/vp-project-flow.test.mjs` runs the MCP flow against a temporary copy of each directory. Never apply to these files in place.

## How they were generated

- vite-plus: 1.0.0
- Date: 2026-09-28
- Environment: Node.js 24.21.0, pnpm 12.6.0 (the version `vp create` wrote to `devEngines.packageManager`), macOS

Every flag below was checked against `pnpm dlx --package vite-plus@1.0.0 vp create --help`; all of them exist on 1.0.0.

```sh
pnpm dlx --package vite-plus@1.0.0 vp create vite:library --no-interactive --package-manager pnpm --no-git --no-agent --no-hooks --no-editor --directory library
pnpm dlx --package vite-plus@1.0.0 vp create vite:monorepo --no-interactive --package-manager pnpm --no-git --no-agent --no-hooks --no-editor --directory monorepo
```

Both commands ran their dependency install. The output was then copied here without the files listed below.

## Files dropped

- `node_modules/` in every directory.
- `library/pnpm-lock.yaml` (73,372 bytes) and `monorepo/pnpm-lock.yaml` (74,062 bytes).
- `library/tests/index.test.ts` and `monorepo/packages/utils/tests/index.test.ts` (148 bytes each): neither detection nor apply reads them, and they import `vite-plus/test`, which is not installed here.
- `monorepo/apps/website/public/` (`favicon.svg`, `icons.svg`) and `monorepo/apps/website/src/` (`main.ts`, `counter.ts`, `style.css`, `assets/hero.png`, `assets/vite.svg`, `assets/typescript.svg`), about 45 KB: application content that detection and apply do not read. `apps/website/index.html` is kept, so its `/src/main.ts` reference is dangling.

The repository excludes this directory from `tsc` (root `tsconfig.json`) and from Knip (root `knip.json`), because the configuration files import `vite-plus`, which is not installed. The CLI package publishes only the paths in its `files` allowlist, which does not include `fixtures/`.

## Differences from the synthetic fixtures

`detectVitePlus` reports `managed` through the `vite-plus-dependency` signal for the library, the monorepo root, and both workspace members, so no difference below changes detection.

- The hand-written library and monorepo manifests are npm-shaped: the `vite` pin sits in `overrides.vite` and the monorepo globs in `workspaces`. With `--package-manager pnpm`, 1.0.0 writes `vite-plus: "catalog:"`, puts the pin in `pnpm-workspace.yaml` under `catalog.vite` with `overrides: { "vite@*": "catalog:" }`, and lists the monorepo globs under `packages` in `pnpm-workspace.yaml`. The globs are the same three (`apps/*`, `packages/*`, `tools/*`), and the catalog shape matches the synthetic `pnpmWorkspaceCatalog`, apart from the version.
- `pnpm-workspace.yaml` also carries `minimumReleaseAgeExclude` and `peerDependencyRules` entries for the Vite+ packages; detection does not read them.
- Both workspace members declare `vite-plus` locally (`catalog:`), so the real monorepo does not exercise the ancestor rule; the synthetic "member without a local declaration" test in `scripts/vite-plus-detection.test.mjs` remains its only coverage. `packages/utils` has its own `vite.config.ts`; `apps/website` has none and now also declares `vite: "catalog:"`.
- The library builds with `vp pack` rather than `vp build`, and the scripts are `build`, `dev`, `test`, `check`, and `prepublishOnly`, all through `vp`.
- With `--no-hooks`, the monorepo root has no `prepare: "vp config"` script, which the 0.3.1 evidence in ADR-0001 recorded.
