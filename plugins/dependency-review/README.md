# dependency-review

A Claude Code plugin that reviews Dependabot updates for what actually matters to the project you are in.

## What is in the plugin

The `dependabot-update-reviewer` agent takes a Dependabot pull request URL and first reads the pull request's checks. When a check failed, it reads the failed steps and reports the cause before anything else, because a pull request with failing checks cannot be merged however harmless its updates are. It then reads the release notes for every version in the update, and reports important changes, breaking changes (separately, with a verdict on whether each affects the project), features that could benefit the project, and workarounds that fixed bugs would let you remove. If every check passed and nothing matters, it gives a brief overview instead. Each report ends with a `Merge readiness: ready | not ready | unknown` line, and only a pull request whose checks all passed or were skipped is `ready`. It runs on Haiku at medium effort, and it is read-only.

The `dependency-map.mjs` script, in `scripts/`, is a zero-dependency Node script that maps declared packages to the files, imported symbols, config files, package.json scripts, and `WORKAROUND` markers that use them, plus a usage fingerprint. The agent runs it before investigating, which keeps its code reading small.

The `workaround-markers` skill teaches the one-line `WORKAROUND(package)` comment convention and how to run the map. The `apply-dependency-notes` skill applies the "Notes update" block that the agent returns to `.claude/dependency-notes.md` in the project.

## Installing

The plugin is in Calavera's `calavera` marketplace:

```sh
claude plugin marketplace add schalkneethling/create-project-calavera
claude plugin install dependency-review@calavera
```

Installation is at user scope by default, so the plugin is available in every project. The plugin sets no `version`, so Claude Code uses the latest commit of the Calavera repository as its version, and any commit to the repository counts as an update. To take one, run `claude plugin marketplace update calavera`, then `claude plugin update dependency-review@calavera`, and restart Claude Code. You can also turn on auto-update for the `calavera` marketplace under `/plugin`, **Marketplaces**. After editing files in a marketplace added from a local checkout, run `/reload-plugins` in a session.

## Using it

From inside a project, ask Claude to review a Dependabot PR and paste the URL. The agent appears as `dependency-review:dependabot-update-reviewer`. Node 18 or newer is needed for the map script.

## Tests

The map script has a `node:test` suite in `tests/`. Run it with `node --test plugins/dependency-review/tests/*.test.mjs` from the repository root. `pnpm test:plugins` runs it together with the checks on the plugin layout.

The agent has `claude plugin eval` cases in `evals/`. They replay a recording of a real Dependabot pull request, schalkneethling/schalkneethling.com#1457, whose checks all failed at `pnpm install`:

- `failing-checks` uses the recording as it is. The report must lead with the failing checks and their cause, and say that the pull request is not ready to merge.
- `passing-checks` uses the same pull request with every check passed, so the report must not invent failures.
- `pending-checks` uses the same pull request while its checks are still running, so the report must say that it is not known yet whether the pull request can be merged.
- `unreadable-logs` uses the failing pull request after its job logs are gone, as after GitHub's log retention period, so the report must say that the logs could not be read and give no cause for the failures.
- `no-checks` uses the same pull request with no checks reported at all, so the report must call merge readiness `unknown`.
- `multiple-prs` reviews three pull requests, one agent run each, and asks for a merge order, as in the incident behind issue #713: #1457 as recorded, and two synthetic ones, #1458 with every check passed and #1459 with checks still running. Only #1458 may be ranked; the others must be listed separately with their reasons.

The data for the other cases is derived from the recording. `tests/eval-fixtures.test.mjs`, which `pnpm test:plugins` runs, checks that each case's files agree on every check's state and that the stand-in `gh` behaves like `gh` where the agent relies on it.

Each case passes the agent only a pull request URL, so it tests the agent's own instructions rather than what the main session adds to its prompt. Eval runs have no network or GitHub login, so a stand-in `gh` in `evals/fixtures/gh` answers from the recording. Each case's setup script copies it into the run's workspace as `.eval-bin/gh`, and the run finds it through a relative `PATH` entry. Run the cases from the repository root:

```sh
PATH=".eval-bin:$PATH" claude plugin eval plugins/dependency-review --scaffold --allow-tools Bash --ablation none
```

The runs call the model with your credentials, so they cost money and do not run in CI. A run of all six cases with the default three runs each costs about $4 at list price, as of October 2026. The `evals/` folder is part of the plugin, as `claude plugin eval` requires, so it adds about 284 KB to each install. The map script needs Node.js, which the eval sandbox hides when Node.js is installed in your home folder, so in the runs the agent uses its `git grep` fallback instead.

## Known limits

The map parses with regular expressions, not a full parser. It finds imports in JS and TS files, the script blocks of Vue, Svelte, and Astro files, and `@import`, `@use`, `@forward`, and `@plugin` rules in stylesheets. Usage that does not go through a module specifier is not tracked. `WORKAROUND` markers are found in those files, in HTML, and in shell scripts (`.sh`, `.bash`, `.zsh`), YAML, TOML, Python, and Ruby files, Dockerfiles, and `.npmrc`. The map skips symlinks, so it never reads a file outside the project through a link; a link to a file inside the project loses nothing, because that file is read itself.
