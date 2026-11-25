---
"create-project-calavera": major
"@schalkneethling/calavera-artifact-core": major
---

Calavera requires Yarn 2 or later and no longer runs under Yarn 1 (Yarn Classic) (ADR-0023). When Yarn 1 starts Calavera, for example with `yarn create project-calavera`, every command stops before it does anything, after only the check of its arguments, and exits 1 with one message:

```text
create-project-calavera does not support Yarn 1.22.22. Use Yarn 2 or later (yarn dlx create-project-calavera), npm (npx --package create-project-calavera create-project-calavera), pnpm (pnpm dlx create-project-calavera), or Bun (bunx create-project-calavera).
```

With `--json`, the same message is the `error` issue of the JSON result. The MCP server stops the same way before it starts, with commands in the form an MCP host's configuration needs. Before this release, Calavera ran under Yarn 1 with the npm registry settings, and `--new` fell back to an npm runner.

Calavera recognizes Yarn 1 only from `npm_execpath` and `npm_config_user_agent`, so a project `.npmrc` `user-agent` cannot stop it under npm or pnpm, and under the Bun runtime a value that a `.env` file defines does not count. Under Yarn 1 itself, a repository's `.yarnrc` can change both variables, so the stop is not a security boundary.

These Yarn 1 paths are removed:

- The hint that `--new` added when `yarn dlx` failed, and the `yarn --version` and `yarn node` commands it ran to choose it. A failed `yarn dlx` now gets the same message as a failed `pnpm dlx`.
- The `-W` flag in the `yarn remove` command that `eject` reports at a Yarn workspace root. A project that pins Yarn 1 gets the Yarn 2 or later command.

`@schalkneethling/calavera-artifact-core` exports `unsupportedYarnVersion` from its `./registry` entry, and `loadNpmRegistryOptions` throws "Calavera does not support Yarn <version>. Use Yarn 2 or later, npm, pnpm, or Bun." under Yarn 1 instead of reading the npm settings.
