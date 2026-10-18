# dependency-review

A Claude Code plugin that reviews Dependabot updates for what actually matters to the project you are in.

## What is in the plugin

The `dependabot-update-reviewer` agent takes a Dependabot pull request URL, reads the release notes for every version in the update, and reports important changes, breaking changes (separately, with a verdict on whether each affects the project), features that could benefit the project, and workarounds that fixed bugs would let you remove. If nothing matters, it gives a brief overview instead. It runs on Sonnet at medium effort, and it is read-only.

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

## Known limits

The map parses with regular expressions, not a full parser. It finds imports in JS and TS files, the script blocks of Vue, Svelte, and Astro files, and `@import`, `@use`, `@forward`, and `@plugin` rules in stylesheets. Usage that does not go through a module specifier is not tracked.
