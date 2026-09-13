# ADR-0001: Vite+ detection signal

- **Status:** Accepted (2026-09-13, Schalk Neethling)
- **Date:** 2026-09-13
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/428
- **Decides:** CQ2 (Vite+ detection signal) from `docs/evolution-brief.md`
- **Amends:** the "Vite+ Awareness" section of `docs/vite-plus-and-delta-mode.md`, which places Vite+ awareness in catalog metadata and `doctor` guidance only. Catalog metadata still declares the project shapes an integration suits and `doctor` stays advisory, but the authoritative result comes from one function and is reported by `inspect_project`, per the brief's Section 5 target shape.

## Context

Decision C2 of the evolution brief states that in a project where `vp` manages the toolchain, Calavera scaffolds no JavaScript or TypeScript linters, formatters, TypeScript configuration, or test runners, and writes no scripts that duplicate `vp` commands. Everything downstream of C2 depends on one question: is this directory a `vp`-managed project? The interface contract glossary defines the term as "a project where Vite+ owns the JS and TS toolchain, as detected under CQ2", so this ADR supplies the missing half of that definition.

CQ2 names four candidate signals: a `vite-plus` dependency, a `vp`-written toolchain pin, `vp` commands in `package.json` scripts, and a Vite+ configuration file. Detection must be a pure function of the project directory, with no network access, no spawning of `vp`, and no global toolchain lookup; the result must be documented in `inspect_project`; and CAL-010 must test both directions, since Section 8 of the brief names false positives as a risk whose response is that `inspect_project` prints the signal it matched.

Neither error direction is cheap. A false positive silently withholds tooling from a project with no other source of it; a false negative offers a `vp` project a second, competing toolchain. Both have to be visible in the output rather than resolved silently.

## Evidence

The evidence is a non-interactive run of vite-plus 0.3.1: `vp create vite:monorepo`, `vp create vite:library`, and `vp migrate` over a `create-vite` vanilla-ts project. Every claim below was re-read from the generated files.

`vp` already answers this question about itself. Its self-check is `hasVitePlusDependency` in `node_modules/vite-plus/dist/package-BZz2Ij68.js`:

```js
function hasVitePlusDependency(pkg) {
  return Boolean(pkg?.dependencies?.["vite-plus"] || pkg?.devDependencies?.["vite-plus"]);
}
```

It is called from `dist/version.js`, which walks upward from the working directory, swallows read and parse errors at every level, and stops at the first manifest that declares the dependency or at the filesystem root:

```js
function isVitePlusDeclaredInAncestors(cwd) {
  let currentDir = path.resolve(cwd);
  while (true) {
    const packageJsonPath = path.join(currentDir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      if (hasVitePlusDependency(pkg)) return true;
    } catch {}
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) break;
    currentDir = parentDir;
  }
  return false;
}
```

Two properties matter. It reads `dependencies` and `devDependencies` only, so a `peerDependencies` entry does not make a package `vp`-managed in `vp`'s own view. It does not stop at the first `package.json` it finds but keeps climbing, which is what resolves a workspace member with no local declaration.

Every generated project carries the dependency. The `vite:monorepo` root manifest is:

```json
{
  "name": "gen-monorepo",
  "version": "0.0.0",
  "private": true,
  "workspaces": ["packages/*", "apps/*", "tools/*"],
  "type": "module",
  "scripts": {
    "ready": "vp check && vp run -r test && vp run -r build",
    "dev": "vp run website#dev",
    "prepare": "vp config"
  },
  "devDependencies": { "vite-plus": "0.3.1" },
  "overrides": { "vite": "npm:@voidzero-dev/vite-plus-core@0.3.1" },
  "devEngines": { "packageManager": { "name": "npm", "version": "12.0.2", "onFail": "download" } },
  "engines": { "node": ">=22.18.0" }
}
```

The workspace member `apps/website` has no `vite.config.ts`, but declares the dependency locally:

```json
{
  "name": "website",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vp dev", "build": "tsc && vp build", "preview": "vp preview" },
  "devDependencies": { "typescript": "^7.0.2", "vite-plus": "0.3.1" }
}
```

The migrated project ends up with a catalog reference rather than a version range, still under `devDependencies`:

```json
{
  "scripts": {
    "dev": "vp dev",
    "build": "tsc && vp build",
    "preview": "vp preview",
    "prepare": "vp config"
  },
  "devDependencies": { "typescript": "~6.0.2", "vite": "catalog:", "vite-plus": "catalog:" },
  "devEngines": { "packageManager": { "name": "pnpm", "version": "12.4.1", "onFail": "download" } }
}
```

with the pin itself moved to `pnpm-workspace.yaml`:

```yaml
catalog:
  vite: npm:@voidzero-dev/vite-plus-core@0.3.1
  vite-plus: 0.3.1
overrides:
  vite@*: "catalog:"
```

Every generated `vite.config.ts` imports `defineConfig` from `vite-plus` rather than from `vite`, as in the library:

```ts
import { defineConfig } from "vite-plus";

export default defineConfig({
  staged: { "*": "vp check --fix" },
  pack: { deps: { resolveDepSubpath: true }, dts: { generator: "tsgo" }, exports: true },
  lint: { options: { typeAware: true, typeCheck: true } },
  fmt: {},
});
```

The candidate signal table, condensed from the findings, compares the CQ2 candidates and incidental markers across the probe projects:

| Signal                                                                             | `vite:monorepo` | `vite:library` | migrated plain-vite            | plain create-vite            | Notes                                               |
| ---------------------------------------------------------------------------------- | --------------- | -------------- | ------------------------------ | ---------------------------- | --------------------------------------------------- |
| `vite-plus` in `dependencies` or `devDependencies`                                 | Yes             | Yes            | Yes (`catalog:`)               | No                           | `vp`'s own self-check; removing it also breaks `vp` |
| `vite.config.*` importing from `"vite-plus"`                                       | Yes             | Yes            | Yes (added by migrate)         | No config file exists at all | Absent for workspace members such as `apps/website` |
| `overrides.vite` or pnpm `catalog.vite` = `npm:@voidzero-dev/vite-plus-core@<ver>` | Yes             | Yes            | Yes (in `pnpm-workspace.yaml`) | No                           | Load-bearing; removing it breaks tool resolution    |
| `vp` commands in `package.json` scripts                                            | Yes             | Yes            | Yes                            | No                           | Cosmetic; survives an uninstall                     |
| `devEngines.packageManager`                                                        | Yes (root only) | Yes            | Yes                            | No                           | Not Vite+ specific                                  |
| `.vite-hooks/pre-commit` containing `vp staged`                                    | Yes             | Yes            | Yes                            | No                           | Unprotected, and absent when hooks are disabled     |
| `AGENTS.md` with `<!--VITE PLUS START-->` markers                                  | Yes             | Yes            | Yes                            | No                           | Prose; legitimately absent with `--no-agent`        |
| `.vp`, `vp.toml`, `.node-version`, `.tool-versions`, `mise.toml`                   | Absent          | Absent         | Absent                         | Absent                       | No such file exists in 0.3.1                        |

The last row settles the second CQ2 candidate. No dedicated `vp`-written toolchain-pin file exists in 0.3.1. The pin lives in `package.json` as `devEngines.packageManager` and `engines.node`, and the `vite` package pin moves with the package manager.

`vp create --help` accepts exactly four package managers, `pnpm`, `npm`, `yarn`, and `bun`, so Deno is not a shape `vp create` produces. Running `vp create vite:library` once per manager shows where the pin lands:

| Package manager | `vite-plus` entry in `devDependencies` | `vite` pin in `package.json`                                              | Pin file outside `package.json`                       |
| --------------- | -------------------------------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- |
| npm             | `"^0.2.4"`                             | `overrides.vite`                                                          | none                                                  |
| pnpm            | `"catalog:"`                           | none                                                                      | `pnpm-workspace.yaml` under `catalog` and `overrides` |
| Yarn 4          | `"catalog:"`                           | `resolutions.vite`                                                        | `.yarnrc.yml` under `catalog`                         |
| Bun             | `"^0.2.4"`                             | `overrides.vite`, plus `devDependencies.vite` aliased to the same package | none                                                  |

The Yarn manifest and its companion file, condensed:

```json
{
  "devDependencies": {
    "@types/node": "^26.1.1",
    "bumpp": "^11.1.0",
    "typescript": "^7.0.2",
    "vite-plus": "catalog:"
  },
  "resolutions": { "vite": "npm:@voidzero-dev/vite-plus-core@0.3.1" },
  "devEngines": { "packageManager": { "name": "yarn", "version": "4.18.0", "onFail": "download" } }
}
```

```yaml
nodeLinker: node-modules
npmPreapprovedPackages:
  - vitest
  - "@vitest/*"
catalog:
  vite: npm:@voidzero-dev/vite-plus-core@0.3.1
  vite-plus: 0.3.1
```

The Bun manifest differs from npm only in the extra alias:

```json
{
  "devDependencies": {
    "@types/node": "^26.1.1",
    "bumpp": "^11.1.0",
    "typescript": "^7.0.2",
    "vite": "npm:@voidzero-dev/vite-plus-core@0.3.1",
    "vite-plus": "^0.2.4"
  },
  "overrides": { "vite": "npm:@voidzero-dev/vite-plus-core@0.3.1" },
  "devEngines": { "packageManager": { "name": "bun", "version": "1.4.2", "onFail": "download" } }
}
```

In every case the `vite-plus` key is present under `devDependencies`. Only its value and the location of the `vite` pin vary, which is why the value is ignored by the primary signal and the pin is corroboration rather than a verdict. One caveat on the evidence: the Yarn scaffold wrote its files, but its dependency install failed inside the sandbox used for this probe, so the Yarn lockfile was not observed.

On the Calavera side, `inspectProject` in `packages/cli/src/index.js` returns exactly `{ packageManager, files, findings }`, with findings typed as `{ severity: "info" | "warning" | "error", kind: string, message: string, path?: string }` and stable `kind` strings such as `"package-manager"`. No JSON Schema or `.d.ts` governs the return value and `inspect_project` is not a frozen surface, so the contract's Rule 3 on additive change applies. The function performs only local filesystem reads, the constraint CQ2 asks detection to preserve.

## Decision

### The signal set and its precedence

One signal decides the verdict. A project directory is `vp`-managed when `vite-plus` appears as a key of `dependencies` or `devDependencies` in the nearest ancestor `package.json` that declares it, searching upward from the inspected directory to the filesystem root and skipping manifests that are missing or unparseable. The value is irrelevant, so a version range, a `catalog:` reference, and a `workspace:` protocol all match. `peerDependencies` and `optionalDependencies` do not, which keeps a Vite+ plugin that merely declares compatibility from reading as a consumer project.

This is `vp`'s own definition, applied the way `vp` applies it. Any other choice lets Calavera and Vite+ disagree about whether `vp` manages a project, and Calavera is wrong by construction whenever they do.

Three corroborating signals are recorded but never decide anything. In precedence order they are the nearest `vite.config.{js,mjs,cjs,ts,mts,cts}` whose source text imports from `"vite-plus"`; a pin of `vite` to `npm:@voidzero-dev/vite-plus-core@<version>` wherever the package manager keeps it, which is `overrides.vite` or `resolutions.vite` in `package.json`, or `catalog.vite` in `pnpm-workspace.yaml` or `.yarnrc.yml`; and a `package.json` script that invokes `vp` as a bare command word. The pin check is one signal with four locations, not four signals, so a project reads the same whichever of pnpm, npm, Yarn, or Bun it uses. Their job is diagnosis, not classification: they tell a reader why a verdict looks wrong. Because they cannot change a verdict, the configuration check is a textual search for the import specifier rather than a parse, which is enough to separate `"vite-plus"` from `"vite"`.

Four things are deliberately not signals. Prose is not read at all, so a repository that discusses `vp` only in `AGENTS.md`, `CLAUDE.md`, or a README does not match. `devEngines.packageManager` is a general Node convention. Lockfiles are independent of Vite+, and `vp migrate` leaves a stale `package-lock.json` next to the `pnpm-lock.yaml` it creates. `.vite-hooks/pre-commit` is absent whenever hooks are declined.

### The pure-function contract

Detection is one function whose only input is an absolute project directory path. It reads, from the local filesystem only, the `package.json` at that directory and at each ancestor until a match or the filesystem root, the nearest `vite.config.*` file, and `pnpm-workspace.yaml` and `.yarnrc.yml` at the directory that stopped the walk. It makes no network call, spawns no process, resolves nothing through `node_modules`, and consults no global toolchain. The result is deterministic for a given tree, installed dependencies or not.

Its output is a record, not a boolean:

```js
/**
 * @typedef {{
 *   status: "managed" | "unmanaged" | "unknown",
 *   signal?: "vite-plus-dependency",
 *   manifestPath?: string,
 *   corroborating: Array<"vite-plus-config-import" | "vite-plus-core-pin" | "vp-scripts">,
 *   ancestor?: { manifestPath: string, status: "managed" | "unmanaged" }
 * }} VitePlusDetection
 */
```

`status` is `"managed"` when the primary signal matched, `"unmanaged"` when the walk completed without a match, and `"unknown"` when no `package.json` was readable at the inspected directory or an input-output error cut the walk short. The `"unknown"` case takes precedence over anything found above it: when the inspected directory itself has no readable manifest, no ancestor can turn the verdict into `"managed"` or `"unmanaged"`, because Calavera cannot apply a recipe to a directory that has no manifest of its own. The walk still runs, exactly as `vp` climbs, and what it finds is reported in `ancestor`: the nearest ancestor manifest that could be read and whether that manifest, and the walk above it, declares `vite-plus`. `ancestor` is present only when `status` is `"unknown"` and such a manifest exists. Unreadable manifests above the inspected directory are skipped exactly as `vp` skips them. `manifestPath` is the matching manifest, relative to the inspected directory when it lies inside it and absolute otherwise, so a match from an ancestor above the project is visible rather than implied. `corroborating` lists what was found, in the precedence order above, and is empty when nothing was.

The `ancestor` field exists so that a later apply flow can act on it. Calavera can already create a manifest, so a directory without one is a decision point, not a dead end. The decision recorded here, with implementation deferred, is that when `status` is `"unknown"` and `ancestor` is present, the flow offers three choices at the approval boundary and never picks one itself: create a manifest in the inspected directory and apply there, with the ancestor verdict carried into the recipe; apply at the ancestor directory instead, re-running inspection there so that the verdict is its own; or abandon. Because `dry_run_apply` is the approval boundary under C8, the choice is presented there and only the CLI acts on it. CAL-010 populates the field; the three-way prompt is a follow-up listed at the end of this document.

### What `inspect_project` reports

`ProjectInspection` gains one optional top-level field, `vitePlus`, carrying the `VitePlusDetection` record alongside the existing `packageManager`, `files`, and `findings`. It is present whenever detection ran, including for `"unmanaged"` and `"unknown"`, because a missing field is not a usable answer for CAL-011.

The verdict is also surfaced through the existing findings pattern, with stable `kind` strings:

- `vite-plus-managed`, severity `info`. The message names the matched signal and any corroboration; `path` is the matching manifest.
- `vite-plus-unmanaged`, severity `info`, so that the negative case is evidence rather than silence.
- `vite-plus-signal-conflict`, severity `warning`, when the verdict is `"unmanaged"` and at least one corroborating signal was found. The message names which ones, since this is the shape of a project whose scripts still call `vp` after the dependency was removed.
- `vite-plus-detection-unknown`, severity `warning`, naming the path that could not be read and, when `ancestor` is present, the ancestor manifest and its verdict.

The change is additive: one optional field and four finding kinds, with nothing changed or removed. Under the interface contract's Rule 3 that is a minor version, released with a Changeset. `inspect_project` has no committed output schema, so the JSDoc typedef and the tool documentation are the only places the shape is recorded.

## Consequences

CAL-010 implements the function, wires the field and the four findings into `inspectProject`, and covers the fixture table below with `node --test` cases in `packages/cli/scripts/`, following the existing inline temporary-directory pattern. The verdict is reported and not yet acted on.

CAL-011 is the first consumer. It reads `vitePlus.status === "managed"` and nothing else, which is why the primary signal has to be cheap to state and hard to get wrong. The corroborating signals and the finding kinds exist for humans, not as inputs to a policy.

The `doctor` command is unchanged: it still compares an applied recipe against the filesystem for known Calavera integrations. Having it read the same function, to warn about a recipe holding JavaScript or TypeScript toolchain integrations in a `vp`-managed project, is a follow-up with its own acceptance criteria.

When Vite+ later ships a dedicated pin file, it enters as a corroborating signal, an additive change to the `corroborating` union. Promoting it to primary would change what `"managed"` means and requires an amending ADR, because `signal` is a closed set.

There are two false-positive risks. A directory that is not itself a Vite+ project but sits beneath one reads as managed, because the walk climbs to the filesystem root exactly as `vp` does; `manifestPath` pointing outside the inspected directory makes that visible, and a narrower rule would make Calavera and `vp` disagree. A package declaring `vite-plus` in `peerDependencies` alone, the shape of a published Vite+ plugin, is not matched at all.

The false-negative risk is a `vp` project whose `vite-plus` dependency was removed by hand, which `vp` itself would also stop recognizing. Where any corroboration is present it surfaces as `vite-plus-signal-conflict` rather than as a silent negative, and the recipe offered is the non-`vp` one, which under the CQ1 outcome carries no JavaScript or TypeScript toolchain anyway.

One current behavior is worth naming because CAL-010 will meet it: `readPackageJSONIfPresent` calls `JSON.parse` without a guard, so an unparseable `package.json` makes the whole tool reject before detection would run, while the walk specified here swallows parse errors as `vp` does and yields `"unknown"`. Reconciling the two is a follow-up.

## Test cases for CAL-010

Each fixture is built in a temporary directory. The last column names the primary signal where one matched, and the corroboration recorded.

| Fixture                                               | Files                                                                                                                                                                               | Expected `status` | Expected signal and corroboration                                                                                                            |
| ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `vp create vite:library`                              | `package.json` with `devDependencies["vite-plus"]`, `overrides.vite`, `vp` scripts; `vite.config.ts` importing from `vite-plus`                                                     | `managed`         | `vite-plus-dependency` at `package.json`; corroborating `vite-plus-config-import`, `vite-plus-core-pin`, `vp-scripts`                        |
| `vp create vite:monorepo` root                        | root `package.json` with `workspaces`, `devDependencies["vite-plus"]`, `overrides.vite`, `vp` scripts; root `vite.config.ts` importing from `vite-plus`                             | `managed`         | `vite-plus-dependency` at `package.json`; all three corroborating                                                                            |
| Monorepo workspace member with a local declaration    | `apps/website/package.json` with `devDependencies["vite-plus"]` and `vp` scripts, no local `vite.config.*`; root as above                                                           | `managed`         | `vite-plus-dependency` at `package.json`; corroborating `vp-scripts` only                                                                    |
| Monorepo workspace member without a local declaration | `apps/site/package.json` with no `vite-plus` key; root `package.json` declaring it                                                                                                  | `managed`         | `vite-plus-dependency` at `../../package.json`; corroboration from the ancestor pin                                                          |
| `vp migrate` output with a stale lockfile             | `package.json` with `devDependencies["vite-plus"]: "catalog:"`, `vp` scripts; `pnpm-workspace.yaml` catalog pin; both `pnpm-lock.yaml` and a leftover `package-lock.json`           | `managed`         | `vite-plus-dependency`; corroborating `vite-plus-config-import`, `vite-plus-core-pin`, `vp-scripts`; the stale lockfile changes nothing here |
| Plain `create-vite` project                           | `package.json` with `devDependencies.vite`, `vite`-only scripts; no `vite.config.*`                                                                                                 | `unmanaged`       | no signal, no corroboration, no conflict warning                                                                                             |
| Plain Vite with a hand-written configuration          | as above plus `vite.config.ts` importing `defineConfig` from `"vite"`                                                                                                               | `unmanaged`       | no signal; the import check must not match `"vite"`                                                                                          |
| `vite-plus` as a `peerDependency` only                | `package.json` with `peerDependencies["vite-plus"]` and no `dependencies` or `devDependencies` entry                                                                                | `unmanaged`       | no signal; no conflict warning                                                                                                               |
| `vp` named only in prose                              | plain Vite `package.json`; `AGENTS.md` and `README.md` describing `vp check`                                                                                                        | `unmanaged`       | no signal; no corroboration, proving no prose file is read                                                                                   |
| Scripts call `vp`, dependency absent                  | `package.json` with `"build": "vp build"` and no `vite-plus` key anywhere                                                                                                           | `unmanaged`       | no signal; corroborating `vp-scripts`; emits `vite-plus-signal-conflict`                                                                     |
| Pin present, dependency absent                        | `package.json` with `overrides.vite` set to `npm:@voidzero-dev/vite-plus-core@0.3.1` and no `vite-plus` key                                                                         | `unmanaged`       | no signal; corroborating `vite-plus-core-pin`; emits `vite-plus-signal-conflict`                                                             |
| `vp create vite:library` with Yarn                    | `package.json` with `devDependencies["vite-plus"]: "catalog:"`, `resolutions.vite`, `vp` scripts; `.yarnrc.yml` catalog pin; `vite.config.ts` importing from `vite-plus`            | `managed`         | `vite-plus-dependency`; all three corroborating, with the pin found in `resolutions` and `.yarnrc.yml`                                       |
| `vp create vite:library` with Bun                     | `package.json` with `devDependencies["vite-plus"]`, `devDependencies.vite` aliased to `vite-plus-core`, `overrides.vite`, `vp` scripts; `vite.config.ts` importing from `vite-plus` | `managed`         | `vite-plus-dependency`; all three corroborating; the alias in `devDependencies` is not itself a signal                                       |
| No `package.json`, no ancestor manifest               | an empty directory under a temporary root with no `package.json` above it                                                                                                           | `unknown`         | emits `vite-plus-detection-unknown`; `ancestor` absent                                                                                       |
| No `package.json`, managed ancestor                   | an empty subdirectory of the `vp create vite:library` fixture                                                                                                                       | `unknown`         | emits `vite-plus-detection-unknown`; `ancestor` is `{ manifestPath: "../package.json", status: "managed" }`                                  |
| No `package.json`, unmanaged ancestor                 | an empty subdirectory of the plain `create-vite` fixture                                                                                                                            | `unknown`         | emits `vite-plus-detection-unknown`; `ancestor` is `{ manifestPath: "../package.json", status: "unmanaged" }`                                |
| Unparseable `package.json`                            | `package.json` containing `{`                                                                                                                                                       | `unknown`         | emits `vite-plus-detection-unknown` naming the path; the walk does not throw                                                                 |

The managed and unmanaged rows together satisfy the CAL-010 criterion that both directions are tested, and the Yarn and Bun rows cover every package manager `vp create` accepts. The fixtures mirror the files recorded for vite-plus 0.3.1.

## Alternatives considered

**A Vite+ configuration file as the primary signal.** A `vite.config.*` importing from `vite-plus` is unambiguous where it exists, and `vp migrate` creates one even for a project that had none. It fails on workspace members: `apps/website` has no local configuration file, so a configuration-first rule either misses such members or climbs to the root and must then explain why a root file governs a member. The dependency check answers both with one rule.

**The toolchain pin as the primary signal.** The `npm:@voidzero-dev/vite-plus-core` pin is the most load-bearing artifact in the evidence. It is rejected as primary because it already lives in four places across the four supported package managers, `overrides`, `resolutions`, the pnpm catalog, and the Yarn catalog, with more variants likely; because a monorepo member inherits it from a root several levels up; and because the string matched is an internal package name Vite+ never promised to keep. As corroboration, a rename costs nothing.

**`vp` commands in scripts as the primary signal.** Scripts are the easiest signal to read and the weakest to trust. They survive removal of the dependency, they are copied between repositories by hand, and they would classify a project whose author aspires to `vp` as one that already has it. As corroboration, that case shows up as a conflict warning, which is the useful thing to say about it.

**A dedicated `vp`-written toolchain-pin file.** Rejected because no such file exists: neither `vp create` nor `vp migrate` writes `.vp`, `vp.toml`, `.node-version`, `.tool-versions`, or `mise.toml`, and none appears in the 0.3.1 distribution. The promotion path for the day one appears is under Consequences.

**A weighted score over all signals.** A score lets weak signals outvote the absence of the dependency, the false positive the brief asks to avoid, and produces a number no consumer can act on without a threshold, so the threshold becomes the real decision while looking like a tuning parameter. One primary signal with named corroboration gives CAL-011 something to branch on and keeps the evidence a score would summarize away.

**A plain boolean.** Rejected because a missing or unparseable manifest is not a confident negative, and because Section 8 of the brief asks that the matched signal be printed.

## Open questions and follow-ups

Each of these is opened as its own issue; none is work done here.

- "inspect_project should not fail outright on an unparseable package.json" (https://github.com/schalkneethling/create-project-calavera/issues/429). Decide whether the tool degrades to a finding, and which kind.
- "Offer create-here, apply-at-ancestor, or abandon when the inspected directory has no manifest" (https://github.com/schalkneethling/create-project-calavera/issues/430). Implements the three-way choice recorded under the pure-function contract, at the `dry_run_apply` boundary, using the `ancestor` field.
- "doctor warns when a recipe carries JS or TS toolchain integrations in a vp-managed project" (https://github.com/schalkneethling/create-project-calavera/issues/431).
- "Record the vp-managed detection result in the interface contract glossary" (https://github.com/schalkneethling/create-project-calavera/issues/432). I8 defines the term by reference to CQ2 and should point at this ADR once accepted.
- "Regenerate the vp detection fixtures against a newer vite-plus" (https://github.com/schalkneethling/create-project-calavera/issues/433). The table is pinned to 0.3.1; a drift check beats rereading the output by hand.
- "Promote a dedicated Vite+ toolchain pin file to a detection signal". Opened only when such a file ships.
