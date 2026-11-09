# Dependency notes

Maintained by the dependabot-update-reviewer agent. Records per-dependency review state and feature decisions so later reviews do not repeat work. Usage details come from the dependency map, not from this file.

## skills

reviewed: 1.7.6 (2026-11-07)
fingerprint: none

- note purpose: The package is a dev dependency used only by `scripts/check-skills-discovery.mjs`, which runs as `pnpm skills:discovery:check` in the "Plugins" job of `.github/workflows/pull-request.yml`. Calavera does not call it at runtime. The dependency map reports no imports (fingerprint `none`) because the script finds the package with `import.meta.resolve` and starts its binary as a child process.
- note guard: The check guards the fix for #704. Running `npx skills add schalkneethling/create-project-calavera` must list exactly the bundled skills and none of the plugin skills.
- note pin: The version is pinned exactly in `package.json`, with no `^` or `~`. The script parses the output of `skills add <path> --list` with a regular expression tied to its box-drawing layout, and it depends on how the CLI chooses which folders to search.
- note bump: A passing "Plugins" job means the new version is safe for this use. A failing job can mean a real discovery regression or only a change to the output layout, so read the CLI output in the job log before deciding which.
- note release-notes: Read these closely: changes to `--list` output, to folder discovery, to `metadata.internal` handling, to `.claude-plugin/marketplace.json` handling, or to `skills.sh.json`.
