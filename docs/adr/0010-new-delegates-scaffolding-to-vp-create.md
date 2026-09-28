# ADR-0010: `--new` Delegates Project Scaffolding to `vp create`

- **Status:** Accepted (2026-09-28, merged in #531)
- **Date:** 2026-09-27
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/442
- **Decides:** how Calavera starts a project that does not exist yet. `--new` confirms, spawns `vp create` through a package-manager runner with inherited stdio, and continues into what `--init` does today only when the child exits zero and ADR-0001 detection reports `managed` on the scaffolded directory. Calavera writes no JavaScript or TypeScript scaffolding itself, and nothing in C8 changes.

## Context

Calavera starts after a project folder exists. `docs/agent-first-calavera-workflow.md` and `docs/vite-plus-template-research.md` both open the recommended flow with a separate `vp create` step, followed by `cd` into the generated project and `npm create project-calavera -- --init`. Increment 1 resolved CQ1 so that Calavera provides no JavaScript or TypeScript toolchain to any project, and a project that has not adopted Vite+ runs `vp create` or `vp migrate` first. That makes `vp create` the first step of every new Calavera project, and the hand-off between the two tools is where users and agents lose their place.

Issue #442 proposes `--new`: Calavera spawns `vp create` with inherited stdio so that Vite+ asks its own questions, waits for the child to exit, checks the result with `detectVitePlus`, and then proceeds. The issue asks one primary review question: when Calavera is started with `--new`, does it delegate all JavaScript and TypeScript scaffolding to `vp create` by spawning it, confirm before the spawn, and continue into the normal flow only when the spawned process exits zero and ADR-0001 detection reports `managed`?

The CAL-002 probe of vite-plus 0.3.1, recorded in #442, produced three findings the design has to handle. `vp create` re-invokes `vp` by bare command name and fails with `spawn vp ENOENT` when `vp` is not on `PATH`. `vp create` has no `--no-install` flag, so scaffolding always installs dependencies. Success therefore has to be established after the fact, because an exit code alone does not say what was written.

Today, `--init` is parsed in `packages/cli/src/index.js` as a boolean that selects the `agent-init` command (`values.init ? "agent-init" : ...`), and `agentBootstrap` writes the base Calavera skill, agent guidance in `AGENTS.md` or `AGENTS.calavera.md`, one project-local MCP configuration or `.agents/calavera/mcp.md` notes, and `.calavera/state.json`. It does not inspect, compose, dry-run, or apply a recipe; an agent does that afterward through the MCP tools. `parseArgs` removes every `--` token before handing the arguments to `node:util` `parseArgs`, whose strict mode rejects options Calavera does not declare. The CLI already accepts `--yes` ("Use defaults and skip prompts") and `--package-manager`, and its prompts already fall back to non-interactive defaults when `options.json || options.assumeYes || !process.stdin.isTTY`.

## Evidence

**Source of `vp create` behavior.** `vite-plus` is not a dependency of this repository and does not resolve from its `node_modules`. The flags and failures that #442 relies on come from the CAL-002 probe of vite-plus 0.3.1: `--no-interactive`, `--package-manager <pnpm|npm|yarn|bun>`, `--directory`, `--no-git`, and a positional template name. The research PoC on vp 0.2.1 in `docs/vite-plus-template-research.md` additionally used `--no-hooks`, `--no-agent`, and `--no-editor`. To confirm mechanisms rather than flags, this decision also read the source of a vite-plus 0.2.8 global install on the author's machine (`~/.vite-plus/0.2.8/node_modules/vite-plus`). Where that source is cited below, the version is named, because 0.2.8 is older than the 0.3.1 the probe used and the implementation issue re-verifies each point against the version it spawns.

**Vite+ 1.0.0.** Vite+ 1.0.0 was released on 2026-09-27, after the probes above. On 2026-09-28, `pnpm dlx --package vite-plus@1.0.0 vp create --help` ran from a directory with no project and printed the same options as 0.2.8 plus `--interactive`: `--directory`, `--agent`, `--no-agent`, `--editor`, `--no-editor`, `--git`, `--no-git`, `--hooks`, `--no-hooks`, `--package-manager <pnpm|npm|yarn|bun>`, `--approve-builds`, `--verbose`, `--interactive`, `--no-interactive`, `--list`, and `--help`, with `-- TEMPLATE_OPTIONS` passed to the template unchanged. That run is also the first evidence that the runner shape in Decision 1 starts the `vp` bin of the `vite-plus` package. The 1.0.0 release notes list three breaking changes, none of which touch `vp create`, the way a project declares vite-plus, or the package and bin names: the Node.js floor becomes `^22.18.0 || ^24.11.0 || >=26.0.0`, `vp test` moves to vitest 5, and task cache settings move under `cache`. Calavera declares no `engines` field of its own, so `--new` inherits that floor through the child.

**The bare `vp` re-invocation.** In vite-plus 0.2.8, the dependency install that `vp create` performs is a child process whose command is `process.env.VP_CLI_BIN ?? "vp"` with arguments `["install", ...]` (`dist/prompts-DYap08te.js`, `runViteInstall`). The formatter step (`runViteFmt`), the Bun gated-build check, and the build-approval step use the same expression. Nothing in the distributed JavaScript sets `VP_CLI_BIN`; it is read and never documented. When `vp create` is run from a location that is not on `PATH`, the bare `"vp"` fallback is what produces `spawn vp ENOENT`.

**One package, several bins.** The vite-plus 0.2.8 manifest declares four bins: `oxfmt`, `oxlint`, `vp`, and `vpr`. A runner invoked with only the package name cannot tell which one to run, so the runner has to name both the package and the bin. `createMcpLaunchCommand` in `packages/cli/src/index.js` already builds exactly this shape for Calavera's own MCP bin: `pnpm dlx --package <spec> <bin>`, `yarn dlx --package <spec> <bin>`, `bunx --package <spec> <bin>`, and `npx --package <spec> <bin>`.

**No install switch.** The 0.2.8 `vp create --help` output lists `--directory`, `--agent`, `--no-agent`, `--editor`, `--no-editor`, `--git`, `--no-git`, `--hooks`, `--no-hooks`, `--package-manager`, `--approve-builds`, `--verbose`, `--no-interactive`, `--list`, and `-h`/`--help`, with arguments after `--` passed to the template. There is no install switch. The `--no-install` strings in the 0.2.8 source are arguments `vp create` appends to third-party template commands (`@tanstack/cli`, `sv`), not an option of its own. This matches the 0.3.1 finding.

**Interactivity.** In 0.2.8, `vp create` defaults to interactive mode when `!process.env.CI && process.stdin.isTTY` (`defaultInteractive`), and `--no-interactive` forces the non-interactive path.

**Target directory.** In 0.2.8, `vp create` chooses the target directory itself: it prompts with "Target directory:" in interactive mode, derives a default from the package name otherwise, and accepts `--directory`, including `.`. A target is available when it does not exist or contains nothing but `.git`. When it is not available, the non-interactive path exits 1 with `Target directory "<path>" is not empty`, and the interactive path offers "Cancel operation" or "Remove existing files and continue", the second of which deletes everything in the target except `.git`.

**Cancellation exits zero.** In 0.2.8, `cancelAndExit` defaults its exit code to `0`, and every canceled prompt in `vp create` calls it. A user who presses Control+C at the template picker, or answers "Cancel operation", leaves a process that exited zero and wrote nothing.

## Decision

`--new` is a Calavera option, matching `--init`. It is the scaffold hand-off and nothing more: Vite+ owns every scaffolding question and every file it writes, and Calavera orchestrates the hand-off and then does what `--init` does today. The seven questions #442 leaves open are settled as follows.

### 1. How the spawn finds `vp`

Calavera always runs `vp create` through a package-manager runner that names the package and the bin, following the shape `createMcpLaunchCommand` already uses:

| Runner package manager | Spawned command                                      |
| ---------------------- | ---------------------------------------------------- |
| npm                    | `npx --package vite-plus vp create <forwarded>`      |
| pnpm                   | `pnpm dlx --package vite-plus vp create <forwarded>` |
| Yarn                   | `yarn dlx --package vite-plus vp create <forwarded>` |
| Bun                    | `bunx --package vite-plus vp create <forwarded>`     |

The runner is chosen from Calavera's own `--package-manager` when it is given, and is npm otherwise, matching the `?? "npm"` fallback `agentBootstrap` already applies when no manifest names a package manager. There is nothing to detect in a directory that has no manifest yet. The runner only fetches and starts vite-plus; the project's package manager is a question Vite+ asks, or that a forwarded `vp create --package-manager` answers, and the `--init` step that follows detects it from the scaffolded manifest as it does today.

The runner is chosen over putting a bin directory on `PATH` because the `PATH` alternative requires Calavera to install vite-plus somewhere first and then locate its bin directory, which is the job a runner exists to do. A runner that executes a package bin is expected to expose that package's bins to the process it starts, and that is what the bare `"vp"` re-invocation needs. Setting `VP_CLI_BIN` is rejected for the same reason ADR-0001 rejected the `vite-plus-core` pin as a primary signal: it is an internal name Vite+ has not promised to keep. A globally installed `vp` is not preferred even when one is on `PATH`, because its version is whatever the machine happens to hold, and the spawn has to behave the same on every machine.

The exposure of `vp` to the child is verified per runner, not assumed. The implementation issue proves, for each of the four runners, that `vp create` completes its install with no `vp` on the parent `PATH`. If a runner does not expose `vp`, the implementation stops and returns to this decision rather than falling back to `VP_CLI_BIN` or a hand-built `PATH`.

### 2. Dependency installation cannot be skipped

`vp create` always installs dependencies, and Calavera does not try to prevent it. The confirmation states it before the spawn: Vite+ will install the project's dependencies, which needs network access and can take minutes, and there is no option to skip it. Calavera's own `--no-install` governs Calavera's apply step only and is not forwarded or reinterpreted.

### 3. What counts as success

Success is both of these, checked in order after the child exits:

1. The exit code is `0`.
2. `detectVitePlus` on the scaffolded directory returns `status: "managed"`.

The scaffolded directory is located without re-modeling Vite+'s target question. When the forwarded arguments contain `--directory <path>`, that path, resolved against the working directory, is the target. Otherwise Calavera records, before the spawn, the `package.json` of the working directory and of each top-level directory (absent, or its contents), and after the spawn the target is the working directory when its `package.json` is new, or the single top-level directory whose `package.json` is new or whose contents changed during the spawn. That covers a directory Vite+ created, a pre-existing empty directory it scaffolded into, and a pre-existing non-empty directory whose files Vite+ replaced after the user accepted its offer to do so. No candidate, or more than one, is a hard stop that lists what was found.

Any other outcome is a hard stop. The message names the exit code (or the terminating signal, when the child was killed and the code is `null`), the directory that was inspected, and the detection result: the `status` and the finding `kind` ADR-0001 defines (`vite-plus-unmanaged`, `vite-plus-signal-conflict`, or `vite-plus-detection-unknown`), with the finding message. After a hard stop Calavera writes nothing, does not continue into `--init`, and does not remove what Vite+ wrote; the message says that the directory may hold a partial scaffold that belongs to Vite+. Both conditions are required because neither is sufficient alone: the 0.2.8 source shows that a canceled `vp create` exits zero having written nothing, and a template that is not a Vite+ template can exit zero having written a project Vite+ does not manage.

### 4. Where the confirmation sits

The confirmation comes before the spawn, and it is separate from, and prior to, the recipe dry run. The spawn is a third-party write that happens before any recipe exists, so no `dry_run_apply` can describe it and it cannot shelter behind one. The recipe dry run is untouched: it still gates everything Calavera writes into the project afterward, and `dry_run_apply` remains the approval boundary for recipes under C8.

The prompt defaults to "no" and shows:

- the exact command line Calavera will spawn, runner and forwarded arguments included, and the working directory it will run in;
- that the runner may download vite-plus;
- that Vite+ will ask its own questions (template, target directory, package manager, and the rest) unless forwarded flags answer them, and that Calavera does not answer them;
- that Vite+ installs dependencies and that this cannot be skipped;
- that when the target directory Vite+ is given is not empty, Vite+ may offer to remove its contents, and that this choice is Vite+'s;
- that Calavera's dry run does not preview what Vite+ writes, and that Calavera does not undo it if the scaffold fails;
- when detection at the working directory reports an `ancestor`, the ancestor manifest path and its verdict, because the new project will sit inside another one;
- that after a successful scaffold Calavera will run the `--init` bootstrap in the new directory.

### 5. Pass-through and automation

`--new` ends Calavera's own arguments. Every token after it is forwarded to `vp create` verbatim and in order, including a `--` that introduces template arguments; Calavera parses only the tokens before `--new`. Calavera does not declare, validate, or rename any `vp create` flag, so a flag Vite+ adds or removes needs no Calavera change. This requires splitting the raw arguments at `--new` before `parseArgs` removes `--` tokens. The `npm create` separator rule from `docs/agent-first-calavera-workflow.md` still applies, so the npm form is `npm create project-calavera -- --new vite:library --no-interactive --package-manager pnpm`, while the pnpm, Yarn, and Bun launchers take `--new` directly.

Calavera reads two forwarded tokens and changes neither: `--directory`, to locate the target (Decision 3), and `--no-interactive`, to decide whether its own confirmation can be shown. Calavera's own confirmation is answered with the existing `--yes` flag, placed before `--new`. No new flag is introduced. When stdin is a TTY and `--yes` is absent, Calavera shows the confirmation. When `--no-interactive` is forwarded, or stdin is not a TTY, or `CI` is set, and `--yes` is absent, Calavera refuses before spawning and names `--yes` in the message. It never treats a non-interactive run as consent. `--yes` keeps its existing meaning for the `--init` step that follows, so a scripted run takes the same defaults `--init --yes` takes today, and `--agents-md` and `--mcp-harness` override them as they do today.

`--dry-run` before `--new` prints the confirmation text and the resolved command and spawns nothing, since `vp create` has no preview of its own. `--new` and `--init` together are refused as contradictory.

### 6. Refusals

When a `package.json` exists in the working directory, readable or not, `--new` refuses before prompting, spawns nothing, and points at the normal flow: `npm create project-calavera -- --init` and the matching pnpm, Yarn, and Bun commands. An existing manifest means a project already exists, and scaffolding over it is not what `--new` is for.

A non-empty working directory without a manifest is not refused. `vp create` scaffolds into a target directory of its choosing, by default a new subdirectory named from the package name, so running it from a non-empty parent folder is its ordinary use, and refusing that case would break it. Whether the target itself is usable is a check Vite+ already performs (Evidence, "Target directory"), and repeating it in Calavera would duplicate a check Vite+ owns. Issue #430 does not apply at this step. Its three-way choice governs applying a recipe to a directory with no manifest of its own; `--new` creates the manifest through Vite+, and detection then runs on the scaffolded directory, whose manifest gives it a verdict of its own. The ancestor, when there is one, is still shown in the confirmation (Decision 4).

### 7. Interaction with `--init`

After a successful scaffold, `--new` continues in the same process into exactly what `--init` does today, with the scaffolded directory as the project root, and ends with the same next prompt `--init` prints. The recipe flow that follows (`inspect_project`, `compose_recipe`, `dry_run_apply`, `apply_recipe`) remains the agent's work through the MCP tools, exactly as after `--init`.

Continuing in the same process is chosen because the hand-off between the two commands is the friction #442 exists to remove, and printing a second command to run would keep it. It adds no new write path: the bootstrap is the same CLI code under the same prompts, and its existing handling of an `AGENTS.md` that is already present covers the `AGENTS.md` or `CLAUDE.md` that `vp create --agent` can write. When the bootstrap fails after a successful scaffold, the scaffold stays, and the error names the `--init` command to run in the scaffolded directory.

`--new` is a CLI option only. It adds no MCP tool, and the MCP tool list in Section 2 of the brief is unchanged, because there is no project root for a project-local MCP server to run from before the scaffold exists, and because only the CLI writes into projects.

## Consequences

The next step is one implementation issue, opened with `gh issue create --template cal.md` under the `calavera-evolution` label: **"Add `--new`: confirm, spawn `vp create` through the package-manager runner, verify `managed`, continue into `--init`"**. Its acceptance criteria, copied from #442:

- On an empty directory, `--new` refuses to spawn without confirmation.
- With confirmation it produces a directory where `inspect_project` reports `managed`.
- On a non-zero exit it writes nothing further and reports the cause.
- On an exit of zero with an `unmanaged` or `unknown` result it hard-stops naming the detection finding.
- A directory that already has a manifest is refused with a pointer to the normal flow.

The same issue carries the checks this decision adds: each of the four runners completes `vp create` with no `vp` on the parent `PATH`; a forwarded `--no-interactive` without `--yes` is refused before spawning; tokens after `--new` reach the child unchanged, including `--`; a canceled scaffold that exits zero is a hard stop; and after success the `--init` bootstrap runs in the scaffolded directory. Tests spawn a stub in place of the runner so that they need neither network access nor vite-plus, and one manual probe against a real vite-plus release records the version it used.

The C8 tests are unchanged and must still pass. Only the CLI writes into projects: the spawn is started by the CLI after an explicit confirmation, and the `--init` step is existing CLI code. `dry_run_apply` remains the recipe approval boundary. Local-edit preservation, the rule that artifacts are not recorded in `package.json`, and conflict surfacing are not touched, because nothing in `--new` goes through the apply pipeline.

Calavera now depends at runtime on a package-manager runner being able to fetch `vite-plus` for `--new`. Nothing else in Calavera gains that dependency, and a user who prefers to run `vp create` by hand keeps doing so and then runs `--init`.

The documentation that describes `vp create` as a separate first step, `docs/agent-first-calavera-workflow.md` and the help text in `formatHelp`, gains the `--new` form alongside it in the implementation pull request. The separate-step flow stays valid for other scaffolds and for existing projects.

## Alternatives considered

**Calavera as a `vp create` template.** Rejected in `docs/vite-plus-template-research.md`. The `createConfig.templates` surface copies static directories or runs a template command, then Vite+ performs its own setup afterward, and there is no template-declared post-scaffold hook in which Calavera could run. It would also make Calavera the center of a flow that has to keep working after any scaffold, not only Vite+'s.

**A `create` verb.** Rejected in #442, because `npm create project-calavera -- create` reads badly, and because `--init` is already an option rather than a verb; `--new` matches it.

**Asking Vite+'s questions again in Calavera.** Rejected by the litmus test. Re-asking the template, target directory, and package manager in Calavera and passing the answers as flags would reimplement a UI Vite+ already does well, and would drift each time Vite+ changes a question. Inherited stdio lets Vite+ ask them. For the same reason Calavera does not choose the target directory up front by always passing `--directory`.

**Putting a bin directory on the child's `PATH`, or setting `VP_CLI_BIN`.** Rejected under Decision 1: the first reimplements what a runner does, and the second depends on an undocumented internal name.

**An exit-code-only success check.** Rejected because a canceled `vp create` exits zero in 0.2.8, and because a non-Vite+ template can succeed without producing a `managed` project, which Calavera would then treat as one.

**Refusing any non-empty working directory.** Rejected under Decision 6: it breaks the ordinary use of `vp create` from a parent folder and duplicates the target check Vite+ owns.

**Instructing the user to run `--init` after the scaffold.** Rejected under Decision 7, because it keeps the hand-off `--new` exists to remove.

## Open questions

- **Runner exposure of `vp`.** That each runner puts the vite-plus bins on the child's `PATH` is the premise of Decision 1, and it is not yet proven for any of the four runners. The implementation issue proves it; a runner that fails it sends this decision back for review.
- **Version drift between 0.2.8, 0.3.1, and 1.0.0.** The target-directory rules, the cancellation exit code, and the `VP_CLI_BIN` fallback were read from 0.2.8 source, the `ENOENT` finding comes from the 0.3.1 probe, and the option list was confirmed on 1.0.0. The implementation verifies the three 0.2.8 mechanisms against 1.0.0, the version the runner resolves today, and records the version it probed.
- **Node.js floor.** Vite+ 1.0.0 requires `^22.18.0 || ^24.11.0 || >=26.0.0` and Calavera declares no `engines` field. Whether the confirmation states the floor, or the hard stop explains a child that refused to start on an older Node.js, is left to the implementation.
- **Pinning vite-plus.** Decision 1 runs whatever version the runner resolves for `vite-plus`. Whether `--new` should pin a version, or accept one from the user, is not decided here.
- **`--json` with inherited stdio.** Vite+ writes its prompts and progress to the inherited stdout, which would corrupt a JSON result on the same stream. Whether `--new --json` is refused or routes the child's output elsewhere is left to the implementation issue, with the refusal as the default if it is not settled there.
- **`vp create --agent` and the bootstrap.** The bootstrap's existing `AGENTS.md` handling is expected to cover files Vite+ writes, but the combination has not been run. CAL-01y's bootstrap readiness check on a scratch `vp create` project is the evidence to read first.
