# ADR-0012: `vp add` Installs Development Dependencies in a Vite+-Managed Project

- **Status:** Proposed
- **Date:** 2026-10-03
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/618
- **Decides:** how `apply` installs a recipe's development dependencies when ADR-0001 detection reports `managed`. Calavera delegates the install to Vite+ by running `vp add -D <packages>` with the project's own `vp` bin, started by the running Node.js. Projects that are not managed keep the per-package-manager command. Detection is unchanged, and nothing in C8 changes.

## Context

`apply` writes the recipe's managed files, its `package.json` scripts, `calavera.config.json` when asked to, and `.calavera/state.json`, and then installs the development dependencies the selected integrations declare. Before this decision, the install was always the command `packageManagerCommands[packageManager].installDev` builds in `packages/cli/src/index.js`: `npm install --save-dev`, `pnpm add --save-dev`, `yarn add --dev`, or `bun add --dev`, run by bare name from `PATH`.

Issue #618 records the failure that command produces in a project `vp create` scaffolded. `vp create` pinned the package manager in `package.json` as `"devEngines": { "packageManager": { "name": "pnpm", "version": "12.8.1", "onFail": "download" } }` and installed `node_modules` with that version, whose store layout is `v11`. The `pnpm` on the user's `PATH` was 10.33.2, which uses the `v10` store, and it refused with `ERR_PNPM_UNEXPECTED_STORE`. Every `--new` project whose global package manager differs from the version `vp create` pinned meets this failure, and `--new` is the main path Calavera offers.

The failure had two further defects. The spinner started before the install was never stopped when `execa` threw, and its timer kept the process alive after the error was printed, so the command did not exit. The same pattern wrapped the `package.json` creation in `ensurePackageJSON`. The error was the raw `ExecaError`, which said nothing about the files, scripts, and state `apply` had already written, or about how to finish the install.

The litmus test settles the direction. Vite+ owns the JavaScript toolchain, and the package manager version is part of it: `vp create` chose it, recorded it, and installed with it. Calavera choosing a package manager of its own in a Vite+-managed project is Calavera competing with Vite+.

## Evidence

The evidence comes from a vite-plus 1.0.0 global installation on the author's machine (`~/.vite-plus/1.0.0/node_modules/vite-plus`), read and run on 2026-10-03. vite-plus is not a dependency of this repository.

**`vp add` and `-D`.** `vp add --help` prints `Usage: vp add [OPTIONS] <PACKAGES>... [-- <PASS_THROUGH_ARGS>...]` and lists `-D, --save-dev` with the description "Save to `devDependencies`". The usage line and the `-D` entry are the same whether it is run through the global `vp` or through the package's own `bin/vp`. The top-level `--help` of the package's own `bin/vp` lists only `install` under "Package Manager Commands", while the global `vp` lists `add` under "Manage Dependencies"; `add` is accepted by both.

**How the package's bin dispatches `add`.** The manifest declares `"bin": { "vp": "./bin/vp", "vpr": "./bin/vpr" }` and exports `./package.json`. `bin/vp` is a Node.js script that imports `dist/bin.js`. The comment that opens `src/bin.ts` in `dist/bin.js` describes it as the "Unified entry point for both the local CLI (via bin/vp) and the global CLI (via Rust vp binary)", and states that the global binary "resolves the project's local vite-plus installation using oxc_resolver and runs its dist/bin.js directly". `create`, `migrate`, `sync-versions`, `config`, `hooks`, `staged`, and `--version` are handled in JavaScript; every other command, `add` included, is passed to the Rust core through the NAPI binding's `run`, with `nodeExecPath: process.execPath`.

**`devEngines.packageManager` is honored.** The NAPI binding of 1.0.0 contains the strings `devEngines.packageManager`, `onFail`, and `does not satisfy devEngines.packageManager`, and the error names `UnsupportedDevEnginesPackageManager` and `PackageManagerVersionNotFound`. A probe confirmed the behavior. In a scratch project declaring `vite-plus` and `"devEngines": { "packageManager": { "name": "pnpm", "version": "10.33.0", "onFail": "download" } }`, with `node_modules/vite-plus` linked to the 1.0.0 installation and no `pnpm` anywhere on `PATH`, `node node_modules/vite-plus/bin/vp add -D is-number` downloaded pnpm 10.33.0 into `~/.vite-plus/package_manager/pnpm/10.33.0`, added `is-number` to `devDependencies`, and reported `Done in 674ms using pnpm v10.33.0`; `node_modules/.modules.yaml` recorded `packageManager: pnpm@10.33.0`. The same probe with pnpm 11.3.0 pinned reported `using pnpm v11.3.0` and the `v11` store. With no `node` on `PATH` the downloaded pnpm 10.33.0 failed to start (`exec: node: not found`), because its launcher is a shell script that runs `node`; that is how Vite+ starts that package manager, and the process Calavera starts from a shell has `node` on `PATH`.

## Decision

### 1. When `apply` delegates, and from which detection

`apply` installs through Vite+ when ADR-0001 detection reports `managed` for the project directory, and also when it reports `unknown` because the directory has no `package.json` of its own while the nearest ancestor verdict is `managed`, as in a new member directory of a Vite+ workspace. Detection keeps reporting `unknown` there; only the install treats the directory as part of the workspace, which keeps the install away from the package manager on `PATH`, the program that failed in #618. In that case the dry run's `vitePlus` report says `unknown`, while the result of the apply that follows says `managed`, because the package manager's `init` created the manifest before the report was made; the install command is identical in both, because both come from the plan.

`managed` follows ADR-0001's ancestor rule: any ancestor manifest that declares vite-plus makes the directory managed. A nested project with its own `package.json` inside a Vite+ repository therefore installs through Vite+, using the first vite-plus that Node.js resolution finds walking up from the project directory, which is the same one a global `vp` would run there. In every other case, `unmanaged`, or `unknown` without a managed ancestor, the install command is the per-package-manager command, unchanged.

A directory without a `package.json` of its own gets one from the package manager's `init` command, as before this decision, and the dev dependency install that follows still goes through `vp add -D`. This is intended. Such a directory was not scaffolded by `vp create`, which always writes a `package.json`, so creating the manifest with the project's package manager is correct. `init` writes only `package.json`; it does not link `node_modules` or touch the store, so the `ERR_PNPM_UNEXPECTED_STORE` class of failure in #618 does not apply to it.

Through Vite+, the install command is `vp add -D <packages>`, with the packages in the order the recipe declares them. The package manager Calavera resolved, including one given with `--package-manager` or the MCP `packageManager` input, does not change it, because Vite+ installs with the package manager the project pins. `devDependencyInstallCommand` in `packages/cli/src/index.js` makes this choice from the detection result alone.

The install is planned once, from one detection made before `apply` writes anything, including the `package.json` it creates for a directory without one. A dry run makes the same plan from the same state, so the command it shows is the command apply runs. Planning after `package.json` creation would let the new manifest change the verdict between the dry run and the apply, which would break the C8 approval boundary.

### 2. How `apply` finds `vp`

`apply` runs the `vp` bin of the vite-plus package the project itself resolves. It resolves `vite-plus/package.json` with `createRequire` from the project directory, which follows the Node.js resolution algorithm: the project's own `node_modules`, then each ancestor's, so a workspace member finds a vite-plus installed at the workspace root, and a pnpm symbolic link resolves to the real package. It reads `bin.vp` from that manifest, refuses a path that leaves the package directory, and spawns the running Node.js, `process.execPath`, with that file and `add -D <packages>`.

This finds the version of Vite+ the project installed, which is the version the global `vp` would also run, since the global binary resolves the project's local vite-plus and runs its `dist/bin.js`. It does not depend on `vp` being on `PATH`, which ADR-0010 found unreliable (`spawn vp ENOENT`), and it uses no `.cmd` shim on Windows, because the spawned program is Node.js itself. It does not use a globally installed `vp` or a package-manager runner, because both can run a different version of Vite+ from the one the project installed, and ADR-0010 Decision 1 already rejected relying on whatever version a machine happens to hold. A runner is the right choice for `--new`, where no project exists yet; here the project exists and has its own vite-plus.

The bin is located as part of the plan, before `apply` writes anything. When it cannot be located, `apply` stops at that point with an error that names the reason, keeps the underlying error as `cause`, and states that Calavera stopped before writing anything. The reasons are distinguished: vite-plus is not installed in the project directory or any ancestor; the installed vite-plus does not export `./package.json`; vite-plus could not be resolved for another reason, such as an unparseable manifest; the manifest could not be read; it declares no `vp` bin in an object-form `bin` field; or the `vp` bin it declares lies outside the package. The error does not suggest a `vp` command, because `vp` may not be on `PATH`; it suggests installing the project's dependencies, or running `apply --no-install` and adding the listed packages.

### 3. What the dry run reports

`ApplyResult` gains `installCommand` and `installNotes`. `installCommand` is the command that installs the recipe's development dependencies, as a person would type it, `vp add -D <packages>` when the install goes through Vite+; it is `null` when the recipe has none, or when an apply that is not a dry run skips the install. A dry run plans the install even with the install skipped, because `dry_run_apply` always runs that way and `apply_recipe` installs unless told not to. `installNotes` says how apply runs the command through Vite+: the exact command line, the running Node.js and the project's `vp` bin; that an explicit package manager does not change it; which command creates `package.json` in a directory without one; or, when the bin cannot be located, that apply would stop and why. `apply --dry-run` prints `Dev dependency install command: <command>` followed by the notes, and `apply --dry-run --json` and `dry_run_apply` carry both fields, so all of this is visible at the approval boundary.

### 4. A failed install

When the install fails, the spinner stops with an error state, and `apply` throws an error whose message is complete on its own. It states that the recipe's files, `package.json` scripts, configuration, and state were already written and lists the written paths; gives the install command exactly as it was spawned, quoted for the shell, which runs without `vp` on `PATH`; says whether it exited with a code, was terminated by a signal, or could not start; shows the last ten lines of the standard output Calavera captured, because standard error already went to the terminal; and asks the user to run that command in the project directory to finish the install. The underlying error is kept as `cause`, and the CLI exits with a non-zero code. The `package.json` creation step stops its spinner the same way when the package manager's `init` fails, with the same description of the failure. How the CLI prints `cause` in general is not changed here.

### 5. Detection is unchanged

ADR-0001 requires detection to spawn no process, resolve nothing through `node_modules`, and consult no global toolchain. This decision keeps that contract. It reads the detection result after detection has run, and the resolution and the spawn belong to the install step, which already spawned a process before this decision.

## Consequences

In a Vite+-managed project, the development dependencies are installed by the package manager and version the project pins, through Vite+, which is the same path `vp create` used to install `node_modules`. The `ERR_PNPM_UNEXPECTED_STORE` failure in #618 no longer happens, because Calavera no longer chooses the package manager there.

A managed project whose vite-plus is not installed, or cannot be used, now stops before `apply` writes anything, where it previously ran the global package manager. The dry run reports the same problem in advance.

The C8 tests are unchanged and pass. Only the CLI writes into projects: the install is still started by the CLI, after the recipe is approved. `dry_run_apply` remains the approval boundary, and it now names the install command, computed from the same detection apply uses. Artifacts are still not recorded in `package.json`; `vp add -D` adds only the integration packages it is given, as the previous command did. Local-edit preservation and conflict surfacing are not touched.

The `vp-project-flow` tests cover the delegation offline, with a stand-in vite-plus package at the fixture root that records its invocation: the library, the monorepo root, and the monorepo member, whose stand-in is found at the workspace root. `dev-dependency-install.test.mjs` covers the dry-run output and notes, the explicit package manager note, the unchanged command for an unmanaged project, the new workspace member without a `package.json` whose dry run and apply name the same command, each reason vite-plus cannot be located, the failure message and `cause`, and that the CLI exits non-zero within a time limit when the install, or the `package.json` creation, fails.

## Alternatives considered

**Bare `vp` from `PATH`.** Rejected. ADR-0010 found that `vp` is not reliably on `PATH`, and when it is, it is the global binary, which resolves the project's vite-plus anyway. Spawning the project's bin directly reaches the same code without the dependency on `PATH`, and without a `.cmd` shim on Windows.

**A package-manager runner, such as `npx --package vite-plus vp add -D`.** Rejected. The runner fetches whatever version of vite-plus it resolves, not the version the project installed. In a pnpm project the obvious runner is the global `pnpm`, which is the program that failed in #618.

**Running `node_modules/.bin/vp`.** Rejected. Package managers write a shell script there, or a `.cmd` file on Windows, in whichever `node_modules` they chose for the package, so finding it means repeating, by hand, the upward search Node.js resolution already performs, and then starting a shim. Resolving the package through Node.js covers hoisted and linked layouts alike and starts Node.js directly.

**Honoring `packageManager` or `devEngines.packageManager` in Calavera.** Rejected for a managed project by the litmus test: it reimplements the package manager selection, download, and version check Vite+ already performs. Whether an unmanaged project should honor those fields is out of scope for #618 and is not decided here.

**`vp install -D <packages>`.** Not chosen. The top-level help describes `install` as able to "add packages if package names are provided", but `vp add` is the command whose help documents `-D, --save-dev`, and it is the command #618 verified.

## Open questions

- **Windows shells.** The printed install command quotes arguments with cmd-style double quotes. PowerShell needs such a command prefixed with `&` when its first word is quoted, and cmd expands `%VAR%` even inside double quotes. Neither shell is tested, because CI runs on Linux only.
- **Yarn Plug'n'Play.** A project installed with Yarn Plug'n'Play has no `node_modules/vite-plus`, so the resolution fails and `apply` stops with the missing vite-plus error. Whether `vp create` produces such projects, and how Calavera should find `vp` in them, is not settled.
- **Hidden `add` in the package's own help.** The package's `bin/vp` accepts `add`, but its top-level help lists only `install`. If a later vite-plus release stops accepting `add` through the package's bin, the install fails with the Calavera error and its `cause`, and this decision returns for review.
- **Node.js floor.** vite-plus 1.0.0 declares `^22.18.0 || ^24.11.0 || >=26.0.0`. Calavera starts the project's `vp` with the Node.js running Calavera, so an older Node.js fails inside Vite+, and the failure is reported through the install error.
