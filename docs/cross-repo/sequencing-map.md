# Cross-Repo Sequencing Map: css-evolve and Calavera

**Status:** Draft 1, 9 September 2026. Owner: Schalk Neethling. Both agents read this at the start of every session and update the status column when a handoff is delivered or consumed.
**Revised:** 7 November 2026, when handoff H0 was delivered and Section 0 was reset for the next increment; 13 November 2026, when Section 0 recorded what 6.2.0 shipped and the owner's choice of issues for the next release; 14 November 2026, when Section 0 recorded the `cli-experience` release's name, goal, exit condition, decisions, and waves; 16 November 2026, when Section 0 recorded wave 1 and placed the issues the owner added to the release; 17 November 2026, when Section 0 recorded wave 2 and placed its follow-ups; 17 November 2026, when Section 0 recorded wave 3 and placed its follow-ups; 18 November 2026, when Section 0 recorded wave 4, placed its follow-ups, and split the remaining work into waves 5 and 6; 20 November 2026, when Section 0 recorded wave 5, placed its follow-ups, and added wave 7; 21 November 2026, when Section 0 recorded wave 6, placed its follow-ups, and split the remaining work into waves 7 and 8.
**Purpose:** One timeline with every point where one project delivers a frozen surface the other consumes, so neither agent starts work that is blocked and neither invents the other side's API.

---

## 0. Current Increment

This section is the live plan. The briefs describe where the projects end up; this section says what is being worked now. It is rewritten at the end of each increment. Work only the current increment; anything else noticed becomes an issue.

**Current increment: the `cli-experience` release.** Increment 1 ended when handoff H0 was delivered on 7 November 2026. The owner chose this release's issues on 2026-11-13, and its name, goal, and exit condition on 2026-11-14.

**Name:** CLI experience.

**Goal:** From the first `--new` to removing Calavera, every command Calavera prints or documents runs as printed, and every summary it prints names each change once, grouped, so a person or an agent can act on it without rereading.

**Exit condition:** Every issue labeled `milestone: cli-experience` is closed or moved out by the owner, and one rehearsal on the release candidate, run by the automated rehearsal from #918 (`pnpm release:rehearse:cli`, in pinned mode, which `pnpm release:prepare` and `pnpm release:publish` run as a release gate on the exact candidate commit, and which the "CLI experience rehearsal" workflow also runs on the Version Packages pull request as an early signal), shows all of the following. The command's result table is the evidence; each numbered item below is one or more named checks in `scripts/rehearsal-checks.mjs`, so change that list when this one changes:

1. `--new` launched through npm, pnpm, Yarn 2 or later, and Bun, and with Calavera itself started through `npx --package create-project-calavera`, produces a project that `inspect_project` reports as `managed`, through the runner that launcher implies (#909, #740, #689, #671).
2. `--init`, `apply --dry-run`, `apply`, a second dry run that reports no change, and `clean --dry-run` each print every file, dependency, and artifact once, under headings, and their next-step commands work when pasted (#601, #602, #617, #331).
3. After apply and a commit through the Vite+ pre-commit hook, `git status` is clean: the cache folder does not appear, the apply summary says why, and the state file is committed as apply wrote it (#838, #841).
4. A Calavera older than the published `latest` prints the version notice (#675).
5. The drift tests pass for the MCP tool list and the agent prompt (#839, #840).
6. On the item 2 project after the commit, `eject --dry-run` changes nothing, and `eject --dry-run` and `eject --yes` print every item once, under headings. Afterward, only the footprint that ADR-0017's Consequences keep and report remains, `vp check` and every script Calavera added exit 0, and a second `eject --yes` removes nothing (#678, #1074).

The owner asked on 2026-11-14 for the rehearsal to be automated, deterministic, and idempotent, so it can run more often than once per release (#918).

**Issues:** The release is the open issues labeled `milestone: cli-experience` (owner decision, 2026-11-13). That label is the list; this section does not copy it, so the two cannot drift apart.

- Shipped in `create-project-calavera` 6.2.0 on 12 November 2026: the Stryker integration work (#733, #734, #735, #736, #880, and #890), #846 with #844, and the list the owner approved on 2026-11-07 outside the increment plan (#829, #795 item 1, #830, #792, #790, #784, and #837). #795 stays open for items 2 to 6 and for the pnpm workspace install failure reported in its comments.
- #676 is decided ("follow the launcher") and recorded in the ADR-0010 amendment (#910). #909 implements it. #911 merged through #912.
- #740 ran its probe before #909, as recommended, and merged through #931: the pnpm and Yarn runners now spawn `pnpm dlx create-vite-plus@latest` and `yarn dlx create-vite-plus@latest`. The probe showed that Yarn 1 still needs #909's fallback to npm when Yarn 1 is installed without Corepack; the details are on #740 and #909, and in ADR-0010.
- Shipped in `create-project-calavera` 6.2.1 on 15 November 2026: the Yarn 1 hint from #911.
- **Wave 1 delivered** (merged 2026-11-15 and 2026-11-16): #432 (#929), #839 (#924), #840 (#930), #458 (#927), #740 (#931), #230 (#928), and #918 (#938).
- **Wave 2 delivered** (merged 2026-11-16 and 2026-11-17): #228 (#949), #841 (#953), #909 (#951), #601 (#950), #933 (#963, the README and skill lists; the `mcp.md` list moved to #934), #663 (#952), #430 (#954), #937 (#967), and #939 (#969).
- **Wave 3 delivered** (merged 2026-11-17): #689 (#978), #936 (#984), #602 (#976), #838 (#977), #925 (#982), #580 (#979), #964 (#981), #926 (#975), #398 (#980), and #940 (#983).
- **Wave 4 delivered** (merged 2026-11-17 and 2026-11-18): #671 (#1003), #958 (#1010), #617 (#1012), #957 (#1016), ADR-0017 for #678 (#1004; #678 stays open for the `eject` command in wave 5), #960 (#1017), #986 (#1019), #962 (#1002), #965 (#1008), #935 (#1006), #997 (#1011), #603 (#1005), #959 (#1014), #995 (#1018), #991 (#1009), #992 (#1013), and #988 (#1015). #232 was closed without a change, because the Composer redesign in #571 had already fixed it.
- **Wave 5 delivered** (merged 2026-11-18 to 2026-11-20): #970 (#1048), #999 (#1055), #1020 (#1047), #331 (#1058), ADR-0019 for #675 (#1062; #675 stays open for the version notice in wave 6), #678 as five stacked pull requests (#1050, #1065, #1066, #1067, #1070), #968 (#1094), #1007 (#1095), #966 (#1046), #990 (#1054), #431 (#1044), #961 (#1057), #1030 (#1059), #354 as ADR-0018 (#1045), #985 (#1060), #998 (#1061), #989 (#1049), and #987 (#1056). Two issues found during the wave also merged in it: #1068 (#1069) and #1074 (#1075).
- **Rehearsal status after wave 5:** a pinned rehearsal run during the #1075 review passed 22 of 23 checks, as recorded on #1075. The `version-notice` check (exit-condition item 4) fails until #675's notice ships in wave 6.
- **Wave 6 delivered** (merged 2026-11-20 and 2026-11-21): #1028 (#1102), #675 (#1104, the version notice from ADR-0019), #956 (#1106), #996 (#1099), #1031 (#1098), #1024 (#1100), #994 (#1103), #1029 (#1113), #1021 (#1114), #1022 (#1121), #1023 (#1132), #1034 (#1118), #1039 (#1123), #1033 (#1129), #1027 (#1105), #1038 (#1107), #1025 (#1108), #1037 (#1116), #1032 (#1122), #1026 (#1131), and #993 (#1124). Five issues found during the wave also merged in it: #1101 (#1115), #1109 (#1117), #1119 (#1120), #1125 (#1127), and #1128 (#1133). #247 was closed with an inventory of what the output issues delivered; #934, #1134, and #1135 cover what remains.
- **Rehearsal status after wave 6:** #1104 added the version notice that exit-condition item 4 checks, and its review reproduced the `version-notice` check's condition against the rehearsal's own registry. The full pinned rehearsal has not run since wave 5, because it needs Bun 1.4.4.

**Owner decisions of 2026-11-14,** each recorded on its issue:

- #689: remove `npm_config_package` and `npm_config_call` from the `vp create` child's environment only, and pass every other variable through unchanged. This does not reopen ADR-0010. Amended on 2026-11-21 by #1109: `npm_config_user_agent` is removed as well, so Vite+ follows the runner Calavera chose rather than the package manager that launched Calavera. Amended on 2026-11-21 by #1080: `COREPACK_ENABLE_AUTO_PIN` is set to `0` for every runner, so neither `pnpm dlx` nor `yarn dlx` writes `packageManager` into a `package.json` above the new project.
- #603: for `apply --config <outside path>`, the project root is the current directory with a `package.json`; otherwise refuse and name the directory, with no offer to create `package.json` and no workspace-ancestor check. #430 covers a different entry point, the `dry_run_apply` choices when the inspected directory has no manifest, so the two rules must not be merged.
- #617: one line per integration, with its package in parentheses only when the names differ; the full dependency list stays in `--json`.
- #663: an environment variable turns on stack traces.
- #838: write `.calavera/state.json` through the project's formatter.
- #841: the cache is not committed; Calavera writes the ignore line in a marked `.gitignore` block, and the apply summary says so.
- #678: the command is `eject`, and `package.json` scripts that call Calavera are reported, not removed. The ADR comes first.
- #602: the agent prompt follows `cd`; only `apply --dry-run` and `apply` wait for a recipe.
- #675: a CLI version notice, which needs a short ADR on its network behavior first.
- #840: the README's prompt is the single source.
- #247: split across the output issues, then closed with an inventory of what remains, or moved out.
- #354: kept, in wave 5, the last work wave, as a document only.

**Owner decisions of 2026-11-15 and 2026-11-16,** each recorded on its issue:

- #918: every rehearsal check is required from the start, with no "pending" state, because the Version Packages pull request is merged only when the release is ready. The pinned rehearsal is a gate in `pnpm release:prepare` and `pnpm release:publish`; the ruleset for `main` and `publish.yml` do not change.
- #230: apply removes an existing `quality` script only when `.calavera/state.json` records that Calavera wrote exactly that value. Aliases from 6.2.1 and earlier have no record, so they are kept and reported.
- The owner added the follow-ups found during wave 1 to the release; their places are in the waves table.

**Owner decisions of 2026-11-16 and 2026-11-17,** each recorded on the issue or pull request named:

- #933: split. The README and skill tool lists ship under #933; the tool list in the generated `.agents/calavera/mcp.md` moves to #934, so the new `mcp.md` text is registered once, under the real release version (#933, #934).
- #909: following the launcher changes the default for pnpm, Bun, and Yarn 2 or later users, so its changeset is a minor bump. The Yarn 2 or later run was recorded under Yarn 4.18.1 (#909).
- #601: the content of the `pointers` field in `--init --json` changes with the printed summary, because one list feeds both (#950).
- #925: `doctor` checks the four github-repository-controls files like every other managed file, and resolves the repository root first when it runs from a workspace package (#925).
- The owner added the follow-ups found during wave 2 to the release; their places are in the waves table.

**Owner decisions of 2026-11-17 (wave 3),** each recorded on its issue:

- #961: under `--manifest-choice create-here`, the formatter follows the parent's Vite+ verdict, as the install command and the `quality` script already do (#961).
- #968: `scripts.quality: false` keeps the `qualityScript` record of a value Calavera wrote, so a later apply can still remove it (#968).
- #991: a targeted `artifacts update <id>` installs and locks only the artifact it names (#991).
- #992: `artifacts update` still drops lock entries for artifacts the recipe no longer selects, and `artifacts status` and `artifacts update` name those entries (#992).
- #993: publishing a stable release also moves the package's npm `next` tag to it (#993).
- The owner added the follow-ups found during wave 3 (#985 to #999) to the release; their places are in the waves table.

**Owner decisions of 2026-11-17 and 2026-11-18 (wave 4),** each recorded on the issue or pull request named:

- #678: ADR-0017 (`eject`) is accepted. The owner answered its 13 open questions, confirmed the four places where the ADR goes beyond those answers, and confirmed that each extracted package folder counts as unknown to `eject --yes` (#678, #1004).
- #617: the rehearsal's listing check no longer counts a quoted value or the fixed ADR-0011 Vite+ lines as a second listing (#1012).
- #960: the `artifacts` commands write and record the `artifact-cache` block themselves (#960). Apply decides whether it ran before from the profile recorded in `.calavera/state.json`, not from the file existing, which ADR-0013 Amendment 1 records (#1017).
- #1033: a cleanup failure after a successful apply is a warning, and apply finishes (#1033).
- #1034: apply removes an old `.calavera/.staging/<id>` folder only when its contents match a package the lock records, and reports anything else (#1034).
- #1040: citing code by symbol rather than line number stays guidance for now (#1040).
- The owner added the wave 4 follow-ups to the release, except the menu-bar app issues #1035 and #1036, which stay unscheduled. #1007 joined the release with them.

**Owner decisions of 2026-11-18 to 2026-11-20 (wave 5),** each recorded on the issue or pull request named:

- Review: while Greptile has no review credits, a fresh independent subagent reviews each pull request's current head in its place, and the pull request says so in a comment (2026-11-18, #1096).
- #678: `eject` ships as a stack of five pull requests, layers 1 to 4 unregistered and layer 5 registering the command. ADR-0017 gained three amendments: a symbolic link or empty folder in the base skill needs interactive approval (Amendment 1); `--yes` keeps a linked cache's `.gitignore` block and the state that records it (Amendment 2); an MCP harness file shows only the lines around Calavera's entry, with values hidden, and `--json` carries none of its text (Amendment 3). Other rulings: marker-only guidance is searched for only in `AGENTS.md`; `mcp.md` is compared without normalizing its pin; a JSONC harness file is kept and reported, never rewritten; the CLI adds `smol-toml` and `jsonc-parser`; a harness file that cannot be parsed stops `eject` with only its line and column, never the parser's text; an edited Calavera-created `.coderabbit.yaml` gets no separate filter-line report (#678).
- #354: ADR-0018 is accepted. Finding options stays with MCP and the Composer, the skill uses only the tools the server lists, `apply_recipe` stays, `eject` is CLI-only, and a breaking change to a public tool needs its own issue, ADR, and pull request. Its follow-ups are #1051 to #1053 (#354, #1045).
- #675: ADR-0019 is accepted: a 1,500 ms check once per run, skipped for `--json`, `--help`, MCP, and the offline artifact commands; a notice on standard error after successful and failed runs; `CALAVERA_NO_VERSION_CHECK` turns it off; as a project dependency, one sentence on updating it. The Yarn, Bun, and `.npmrc` proxy gap goes to #1064 (#675, #1062).
- #1020: the same pull request also stops `--init` from naming `AGENTS.calavera.md` twice (#1047).
- #331: a skip reason keeps the name of the file the person has to change (#1058).
- #1007: `clean` keeps the base skill by its path, however it was installed (#1095).
- #1068: an empty `reviews:` or `path_filters:` key is still refused; the merge-key and anchor layouts that would change another key's meaning are refused too (#1069).
- #1074: a second `eject --yes` must remove nothing and list exactly what the first left, and the rehearsal's eject checks are exit-condition item 6 (#1075).
- The owner added every wave 5 follow-up to the release on 2026-11-20 (#1051 to #1053, #1064, #1076 to #1093); their places are in the waves table.

**Owner decisions of 2026-11-21 (wave 6),** each recorded on the issue or pull request named:

- #1028 and #1109: `vp create` also stops inheriting `npm_config_user_agent`, so Vite+ follows the runner Calavera chose. This amends the #689 decision (#689, #1117).
- #675: start the version check before argument parsing, so an unknown flag still shows the notice, as ADR-0019 Amendment 1 (#1110).
- #994: a selected artifact that is not installed yet passes `artifacts doctor` with a note; a deselected lock entry whose files were deleted becomes a warning (#1111); and the doctors will share one project phase derived from the files, decided by an ADR first (#1112).
- #993: `artifacts doctor --check-updates` exits 0 when the installed files are healthy, even if a registry lookup failed; moving npm's `next` tag to each stable release is #1126.
- #1101, #1119, and #1125 joined the release in wave 6. #1125: apply refuses, before writing, a legacy entry for an artifact that needs wiring or inputs, and points to `artifacts migrate`.
- #1034: `.calavera/.staging/` is Calavera's transient folder; `eject` keeps removing it whole, and apply keeps the stricter rule (ADR-0017 Amendment 4, #1118).
- #1026: the merged path-containment helper uses the precise rule (outside means `..`, a `../` prefix, or an absolute path); the remaining inline checks move to it in #1130.
- #247: closed with an inventory; #1134 and #1135 joined the release.
- The owner added every wave 6 follow-up to the release on 2026-11-21 (#1136 to #1151); their places are in the waves table.

**Order of work** (planned with the owner on 2026-11-14; the owner chose one wave at a time)**:** seven workstreams, grouped by the code they touch, because nearly every issue edits `packages/cli/src/index.js`. Within a workstream, issues run one after another; the workstreams run side by side. The owner chose to run one wave at a time: a wave ends when its pull requests merge, every open worktree rebases on `main`, and the owner hears the result before the next wave starts.

| Wave    | A. Runner    | B. Output                                                | C. Footprint                      | D. Catalog, MCP, and Composer     | E. Detection                          | F. Standalone                          | G. Artifacts                      |
| ------- | ------------ | -------------------------------------------------------- | --------------------------------- | --------------------------------- | ------------------------------------- | -------------------------------------- | --------------------------------- |
| 1       | #740         | #840                                                     | #458                              | #839                              | #432                                  | #230, #918                             | —                                 |
| 2       | #909         | #601                                                     | #841, #937                        | #228, #933                        | #430                                  | #663, #939                             | —                                 |
| 3       | #689, #936   | #602                                                     | #838, #925                        | #580, #964                        | #926                                  | #398, #940                             | —                                 |
| 4       | #671, #958   | #617, #957                                               | #678 ADR, #960, #986              | #232, #962, #965                  | #935, #997                            | #603, #959, #995                       | #991, #992, #988                  |
| 5       | #970, #999   | #1020, #331, #675 ADR                                    | #678, #968, #1007                 | #966, #990                        | #431, #961, #1030                     | #354, #985, #998                       | #989, #987                        |
| 6       | #1028, #1029 | #675, #1021, #1022, #1023, then #247 closed or moved out | #956, #1034, #1039, #1033         | #996, #1027                       | #1031, #1038                          | #1024, #1025, #1037, #1032, #1026      | #994, #993                        |
| 7       | #1080, #1090 | #1079, #1082, #1083, #1084, #1110                        | #1077, #1078, #1081, #1086, #1142 | #1051, #1053, #1052, #1089, #1147 | #1112 ADR, #1087, #1085, #1140, #1141 | #1088, #1091, #1092, #1093, #1149      | #1064, #1136, #1137, #1138, #1139 |
| 8       | #1126        | #1143, #1144, #1145, #1146, #1135                        | #1130                             | —                                 | #1112, #1111                          | #1150, #1151, #1148, #1134, then #1076 | —                                 |
| After 8 | —            | #934                                                     | —                                 | —                                 | —                                     | —                                      | —                                 |

Waves 1 to 6 are delivered. Wave 4's follow-ups made a sixth wave necessary, wave 5's a seventh, and wave 6's an eighth, so that no lane runs more than five issues in one wave. #936 follows #909 because both change the Yarn runner's failure handling. #958 follows #671 because both change what `--new` prints about its runner. #957 follows #617 because both change a summary Calavera prints. #968 is in wave 5 and #956 in wave 6 to keep column C's waves short, not because they depend on #678. #354 stays in wave 5 as the owner decided on 2026-11-14, although wave 6 now follows it. #960 follows the #678 ADR because both decide what Calavera leaves in a project. #962 and #965 both change the bundled skill, so they run one after the other. #959 follows #603 in column F. #968 and #961 were decided on 2026-11-17. #970 runs in wave 5 because it may change the Yarn check of the rehearsal that follows. #935 must merge before #934. #934 runs after wave 8, once the Version Packages pull request is open and the next version is known, and merges before it. #232 follows #580 in column D because both change the Composer. Column G holds the artifact commands from wave 3: they all edit `packages/cli/src/artifact-lifecycle.js` or the status report, so they run one after another, and #991 and #992 come first because #994 and #993 change the same status output. #999 follows #936 in column A because both change the Yarn failure hint. #986 follows #838 in column C because both format what Calavera writes. #997 sits in column E, after #935, because it adds a `doctor` check next to the one #925 changed. #990 and #996 follow #580 and #964 in column D, because #990 uses #580's labels and #996 reuses #964's drift-test helper. #995 sits in column F because it changes only the menu-bar app. #1020 runs first in column B because the rehearsal's listing check fails on `--init` output until it lands. #675's ADR comes in wave 5 and its implementation in wave 6. #1007 follows #678 because both decide what removes the base skill, and #1034 follows #678 because ADR-0017 plans `.calavera/.staging/` as `eject`'s transient folder. #1033 follows #1034 because both change apply's cleanup. #1031 and #1038 follow #1030 because all three change what `doctor` and the manifest checks report. #1026 runs last in column F because it merges path helpers that the other column F issues touch. #994 and #993 follow #989 and #987 in column G because they change the same status output. In wave 7, #1090 follows #1080 because both change the Yarn `--new` path: #1080 changes the `yarn dlx` run, and #1090 adds a rehearsal check that covers that run. #1052 follows #1051 because the new MCP tool's schema comes from #1051's shared definitions, and #1053 changes the skill's tool rule before #1052 adds a tool. #1089 runs last in column D because changing the bootstrap's MCP entries also changes what `eject` matches. #1085 follows #1087 because formatting the created `package.json` depends on what a real `vp fmt` from a subdirectory does. #1076 runs last in column F, in wave 8, because it touches nearly every test file. #1064 is independent of #675: ADR-0019 accepts the loader's gap. #1112's ADR comes in wave 7 and its implementation in wave 8, and #1111 follows it because both decide how `artifacts doctor` treats an artifact's phase. Column G holds the artifacts-command follow-ups (#1136 to #1139) after #1064 because they edit `artifact-lifecycle.js` and the registry options. #1143, #1144, and #1146 run in wave 8, column B, after the wave 7 output issues, because they change the release gate that checks that output. #1145 runs in wave 8 because it changes the apply summary that #1144's mask reads. #1135 and #1134 run in wave 8 because they move or merge wording the wave 7 issues still edit. When wave 8 has merged, the #918 rehearsal runs on the release candidate as the evidence for the exit condition, and the release follows.

**Explicitly not now:** #914 (Lighthouse) and #915 (Mergiraf) go to a later release (owner decision, 2026-11-14). Issues without the label stay out, including #673, #737 (blocked on stryker-mutator/stryker-js#6111), #746, #842, and #843.

**Increment 1 (closed) — Calavera becomes `vp`-aware and lean.** It started on 13 September 2026 and delivered H0 on 7 November 2026 with published `create-project-calavera` 6.1.0. The evidence is `docs/bootstrap-readiness-record.md`. The exit condition was: on a fresh `vp create` library monorepo, the Calavera agent-first flow from Claude Code (`inspect_project` → `compose_recipe` → `dry_run_apply` → `apply_recipe`) installs repository controls, governance and drift checks, EditorConfig, Knip, the selected Determinant gates, and the MCP registration, offers nothing Vite+ already provides, and a second `apply --dry-run` reports no drift.

- Revised by the owner on 2026-10-23 (ADR-0015): only `protected-branch-guard` was cataloged in this increment, so "the selected Determinant gates" meant the guard alone. `agent-red-test-verification` stays with the Determinant tracking issue (#744, closed on 2026-10-30; #746 holds the artifact).
- ADR-0010 (`--new` delegates scaffolding to `vp create`) is accepted (2026-09-28, #531), with an amendment proposed on 2026-10-21 under #688 and accepted on 2026-10-23. The decision issue #442 is closed.
- Checkpoint 1 is not claimed here. Its four criteria are in `docs/evolution-brief.md`. Only the first (a fresh `vp create` project is offered no JS or TS toolchain integration) has an evidence source, the readiness record; the other three have none yet.
- Increment 1 left these out, and nothing in this section changes that: the Baseline engine API and Lightning CSS mapping (built when CSSE-015 needs them), #357 release verification extraction (before css-evolve's first publish), Playwright, a `gate` integration kind, packaging all Determinant gates, `dual-schema-validation` (when the `Diagnostic` schema exists), and the css-evolve integration (when there is a css-evolve to install).

CQ1 was resolved by Increment 1: Calavera provides no JS or TS toolchain to any project; a project that has not adopted Vite+ runs `vp create` or `vp migrate` first.

**Planned before this reset, not yet decided again by the owner.** The two paragraphs below are the expected shape from the original plan. The owner decides whether they still hold.

**Increment 2 — css-evolve bootstrapped through Calavera (Claude Code, css-evolve repository; starts when H0 is delivered; about one week).** `vp create`, then the Calavera flow above; every point of friction is a `dogfood` request back to Calavera; css-evolve Phase 0 follows on the resulting repository. Exit: css-evolve Checkpoint 0 with the added criterion that the repository was produced by Calavera and a second `apply --dry-run` reports no drift.

**Increment 3 —** planned after Increment 2 from the records of both repositories. Expected shape: css-evolve Phase 1 on its own until CSSE-015, at which point Calavera builds the Baseline engine API.

## 1. Handoffs

| Id  | Producer   | Artifact (interface contract section)                                                                                              | Delivered at                                            | Consumer and consuming issue                                                                       | Blocked if it slips                                                                                                           | Status                                                         |
| --- | ---------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| H0  | Calavera   | `vp`-aware, lean Calavera with the first Determinant gates, verified on a scratch `vp create` project (Increment 1 exit condition) | Increment 1 end                                         | css-evolve CSSE-001 (Increment 2)                                                                  | css-evolve cannot start                                                                                                       | [delivered 6.1.0 2026-11-07](../bootstrap-readiness-record.md) |
| H1  | Calavera   | `calavera-baseline-core` API: resolve, feature availability, snapshot (I2.1 to I2.3), published version                            | Calavera CP2 (CAL-020, CAL-022)                         | css-evolve CSSE-015                                                                                | css-evolve Phase 1 cannot resolve `baselineTarget`; CSSE-016, CSSE-017 can proceed on a stub but must not merge with the stub | pending                                                        |
| H2  | css-evolve | `Diagnostic` and `DiagnosticReport` JSON and SARIF (I3), frozen                                                                    | css-evolve CP1 (CSSE-010)                               | Calavera CAL-033                                                                                   | Calavera Phase 3 diagnostics; Calavera can build the catalog entry (CAL-031) without it                                       | pending                                                        |
| H3  | Calavera   | Lightning CSS mapping (I2.4), published                                                                                            | Calavera CP2 (CAL-021, CAL-022)                         | css-evolve CSSE-041                                                                                | css-evolve Phase 4 Vite plugin ships without minifier reconciliation; overlay diagnostics unaffected                          | pending                                                        |
| H4  | css-evolve | Project surface declaration (I4): task names, `staged` entry, ESLint block, Vite plugin export, MCP server command                 | Names at css-evolve CP1; full surface at css-evolve CP4 | Calavera CAL-030, CAL-031, CAL-032                                                                 | Calavera Phase 3                                                                                                              | pending                                                        |
| H5  | css-evolve | Agent Plugins directory published (I5) and MCP tool surface frozen (I6)                                                            | css-evolve CP5 (CSSE-053, CSSE-054)                     | Calavera CAL-040                                                                                   | Calavera Phase 4                                                                                                              | pending                                                        |
| H6  | Calavera   | Integration metadata schema fields for `vp run` tasks and `staged` entries (I7) recorded in the contract                           | Calavera CP3 (CAL-030)                                  | css-evolve documentation only (README install section)                                             | none blocking                                                                                                                 | pending                                                        |
| H7  | Calavera   | Release verification extracted as a tool (#357)                                                                                    | Calavera Phase 6 (CAL-060)                              | css-evolve release process (new issue when H7 lands)                                               | none blocking; css-evolve uses its own verification until then                                                                | pending                                                        |
| H8  | css-evolve | Oxlint CSS language plugin (CSSE-063)                                                                                              | when oxc RFC #21936 ships                               | Calavera: apply C1 to the CSS lint scaffolding (Stylelint and ESLint CSS blocks become `vp check`) | none blocking; a Calavera removal issue is opened when H8 lands                                                               | pending                                                        |

## 2. Timeline

Phases run in parallel across the two repositories. Reading left to right within a row is the order of work; an arrow names the handoff that must have been delivered before the consuming issue starts.

Step 1 is complete: Increment 1 delivered H0 on 7 November 2026 (Section 1). The later rows are the original plan, which the owner has not yet decided again (Section 0).

| Step | Calavera repository                                                                    | css-evolve repository                                                                                                   | Handoffs                                                                                     |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1    | Increment 1: reduced audit, CQ2, `vp` detection, cleanup, first Determinant gates → H0 | waits for H0                                                                                                            | H0                                                                                           |
| 1b   | —                                                                                      | Increment 2: bootstrap through Calavera, then Phase 0 (Q1 spike, ADR-0002 scope, Q6 stub, migrate validator core) → CP0 | H0 consumed                                                                                  |
| 2    | Phase 1: `vp` detection, profile changes, removals → CP1                               | Phase 1: contract model, static checks, CLI, ESLint plugin (H1 stubbed if not yet delivered)                            | H2 delivered at css-evolve CP1; H4 names delivered at css-evolve CP1                         |
| 3    | Phase 2: engine API freeze, CQ5, Lightning mapping → CP2                               | Phase 1 continues; CSSE-015 waits for H1                                                                                | H1 and H3 delivered at Calavera CP2                                                          |
| 4    | Phase 3: CQ3, css-evolve catalog entry, MCP registration, diagnostics → CP3            | Phase 2: real-browser evaluation, engine matrix, expectation files, Vitest helper → CP2                                 | H1 → CSSE-015 merges; H2 → CAL-033; H4 names → CAL-030, CAL-031; H6 recorded at Calavera CP3 |
| 5    | Phase 5 (Playwright) may start; Phase 4 waits for H5                                   | Phase 3: probe runtime, directive, DevTools third-party tools adapter → CP3                                             | —                                                                                            |
| 6    | Phase 5 continues → CP5                                                                | Phase 4: Vite plugin, Lightning reconciliation, `vp` tasks → CP4                                                        | H3 → CSSE-041; H4 full surface delivered at css-evolve CP4 → CAL-031 finalizes               |
| 7    | Phase 4: css-evolve artifacts, #398 → CP4                                              | Phase 5: MCP server, skill, Agent Plugins directory, publish → CP5                                                      | H5 delivered at css-evolve CP5 → CAL-040                                                     |
| 8    | Phase 6: #357                                                                          | Phase 6: tokens, color assertions, WebDev Bench, Oxlint plugin when possible                                            | H7, H8 as they land                                                                          |

## 3. Parallelism and Stubs

- Calavera Phases 0, 1, 2, and 5 have no css-evolve dependency and should run ahead.
- css-evolve Phases 0, 2, and 3 have no Calavera dependency. Phase 1 depends on H1 only at CSSE-015; the rest of Phase 1 may proceed against a local stub of I2.1 to I2.3 that matches the contract types exactly. The stub is deleted when H1 lands; a PR that still imports the stub does not merge.
- Calavera Phase 3 may start the catalog entry (CAL-031) as soon as the H4 names are delivered at css-evolve CP1; it finalizes when the full surface lands at css-evolve CP4.
- Nothing in either project depends on H7 or H8.

## 4. Handoff Protocol

When a producer delivers a handoff:

1. The producing agent updates the interface contract if any detail changed before the freeze, marks the surface frozen, and records the published version.
2. The producing agent sets the handoff status here to `delivered <version> <date>`.
3. Schalk carries the notice to the consuming repository (or the consuming agent reads this map at session start).
4. The consuming agent sets the status to `consumed <issue> <date>` when the consuming issue merges.

When a handoff is late: the producing agent records the slip and the new target here; the consuming agent continues with unblocked work and does not build against a guess.

## 5. Contacts and Escalation

Schalk is the only human in the loop for both repositories. An agent that needs a decision from the other side writes a cross-repo request in its own repository under `docs/cross-repo/requests/` (template in `docs/cross-repo/request-template.md`), stops the blocked issue, records the block on that issue, and continues with unblocked work. Requests are answered in the same folder of the requesting repository once Schalk carries the answer across.
