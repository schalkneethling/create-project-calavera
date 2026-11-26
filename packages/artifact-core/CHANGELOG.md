# @schalkneethling/calavera-artifact-core

## 1.0.0

### Major Changes

- 703249c: Calavera requires Yarn 2 or later and no longer runs under Yarn 1 (Yarn Classic) (ADR-0023). When Yarn 1 starts Calavera, for example with `yarn create project-calavera`, every command stops before it does anything, after only the check of its arguments, and exits 1 with one message:

  ```text
  create-project-calavera does not support Yarn 1.22.22. Use Yarn 2 or later (yarn dlx create-project-calavera), npm (npx --package create-project-calavera create-project-calavera), pnpm (pnpm dlx create-project-calavera), or Bun (bunx create-project-calavera).
  ```

  With `--json`, the same message is the `error` issue of the JSON result. The MCP server stops the same way before it starts, with commands in the form an MCP host's configuration needs. Before this release, Calavera ran under Yarn 1 with the npm registry settings, and `--new` fell back to an npm runner.

  Calavera recognizes Yarn 1 only from `npm_execpath` and `npm_config_user_agent`, so a project `.npmrc` `user-agent` cannot stop it under npm or pnpm, and under the Bun runtime a value that a `.env` file defines does not count. Under Yarn 1 itself, a repository's `.yarnrc` can change both variables, so the stop is not a security boundary.

  These Yarn 1 paths are removed:

  - The hint that `--new` added when `yarn dlx` failed, and the `yarn --version` and `yarn node` commands it ran to choose it. A failed `yarn dlx` now gets the same message as a failed `pnpm dlx`.
  - The `-W` flag in the `yarn remove` command that `eject` reports at a Yarn workspace root. A project that pins Yarn 1 gets the Yarn 2 or later command.

  `@schalkneethling/calavera-artifact-core` exports `unsupportedYarnVersion` from its `./registry` entry, and `loadNpmRegistryOptions` throws "Calavera does not support Yarn <version>. Use Yarn 2 or later, npm, pnpm, or Bun." under Yarn 1 instead of reading the npm settings.

- 1df384b: Calavera no longer reads, expands, or sends registry credentials (ADR-0021). Artifact lookups, artifact downloads, and the version notice read only the registry, the registry of the artifact scope, and the proxy settings, and ignore every `//host/:_authToken`, `_auth`, `username`, `_password`, `certfile`, and `keyfile` key, from every `.npmrc` file and `npm_config_*` variable, and every credential in `.yarnrc.yml` and `bunfig.toml`, without a warning. Under Yarn 2 or later, Calavera reads no `.npmrc` file and no `npm_config_*` variable at all. A private registry or mirror that requires authentication for Calavera's packages no longer works: a registry or tarball host that answers 401 or 403 stops the command with an error that names the origin that answered, says that Calavera sends no credentials, and names the setting to change, and `artifacts status --check-updates` and `artifacts doctor --check-updates` report the same for each artifact, with a new `origin` field in the `--json` failure object. When only your default `registry` requires authentication, add `@schalkneethling:registry=https://registry.npmjs.org/` to your user `.npmrc`. A registry value that contains a variable, such as `registry=${COMPANY_REGISTRY}`, now stops the command with an error that names the setting, never the value; write the URL literally instead. A username and password in a registry URL are removed with a warning. Artifact tarballs now download from the artifact scope's own registry, the one the package document came from, so a configured mirror serves both the lookup and the download. No flag or setting brings credentials back. Proxy settings, including proxy authentication, are unchanged.
- 624fab4: A proxy setting that uses `${VAR}` in a user `.npmrc` outside your operating system account's home folder stops expanding (#1186). This includes a user `.npmrc` that `npm_config_userconfig` names, for example in CI. Calavera now ignores such a proxy entry with a warning that names the key, never the value. To keep the proxy, write its URL without a variable, or remove the entry and set the proxy in `~/.npmrc` in your account's home folder or as an environment variable, such as `npm_config_https_proxy`. Under `npx`, `npm exec`, and `npm run`, the environment variable does not replace the entry while the entry is still in the file. The same rule applies to a `~/.yarnrc.yml` in a `HOME` that is not your account's home folder, such as one that a Yarn 4 `.env.yarn` sets. Calavera still reads the registry and the literal proxy settings of such a file. Under `npx`, `npm exec`, and `npm run`, a proxy with `${VAR}` in npm's global configuration file (`<prefix>/etc/npmrc`, or the file `globalconfig` names) also stops working, because npm expanded it and Calavera no longer trusts the expanded copy: write the proxy URL without a variable, or remove the entry and set the proxy in your own `~/.npmrc` or an environment variable. When the operating system reports no home folder for your account, for example for a container user ID without a password database entry, no user file is your own, so even proxies in `~/.npmrc` stop expanding.

  A project file can no longer change which package manager's settings Calavera reads for artifact lookups, artifact downloads, and the version notice. When `npm_execpath` names npm or pnpm, Calavera reads the npm settings even when the user agent names Yarn or Bun. npm exports a project `.npmrc` `user-agent`, and pnpm its `userAgent` setting, as `npm_config_user_agent`, so that variable alone can come from the repository.

  Under `npx`, `npm exec`, and `npm run`, Calavera now recognizes two more kinds of values that npm passes on from a configuration file. One is a proxy that a chosen user `.npmrc` spells differently, such as `https_proxy`, which is no longer trusted as an environment variable. The other is a project `.npmrc` key with a variable in it, such as `registry${UNSET?}`, which npm expands and which now follows the project rules. Calavera also reads the global npm configuration file that npm used, which a project `.npmrc` can choose with `globalconfig` or `prefix`. When a project file chose that file, or it lies inside the project, its values follow the project rules, so npm's expanded copy of its registry or proxy is no longer trusted as environment. A project proxy written as a list (`https-proxy[]=…`), or with a variable in its key or value whose value changes after npm reads the file, such as `https-proxy${INIT_CWD?}=…` or `${npm_config_https_proxy?}`, is ignored too. When a project `.npmrc` sets `userconfig` in another spelling, such as `USERCONFIG`, which npm ignores but exports as `npm_config_userconfig` over your own value, the user `.npmrc` that Calavera reads follows the project rules.

  A user `.npmrc` that a project `.npmrc` chose with `userconfig` now follows the project rules when npm starts Calavera: its proxy is ignored with a warning, and a plain-`http` registry in it stops the command. Your own `~/.npmrc` keeps working as before, even when the project names it, and so does a user `.npmrc` that you name with `npm_config_userconfig`.

  A registry or proxy variable that a project's Yarn 4 `.env.yarn` sets from a variable, such as `YARN_HTTPS_PROXY=http://${CI_TOKEN}.example.com`, is now ignored with a warning, and so is one whose value holds any `$`, because Yarn turns an escaped `\${...}` into a literal one that Calavera would expand. The same applies to the `.env` files Bun loads when Bun runs Calavera, including the files Bun's `--env-file` option names. Yarn and Bun expand such a value from your environment before Calavera starts, so a repository could otherwise send an environment value to a host it chose. To keep such a setting, write it in the file without a variable, or remove it from the file and set it in your own environment. Under Yarn, only the environment files Yarn loaded for this run count, including under `yarn dlx`, so a variable you set still applies when only a file Yarn did not load names it. When Calavera cannot tell which files Yarn loaded, it ignores every registry and proxy variable with a warning that says why and how to fix it. An example is `YARN_INJECT_ENVIRONMENT_FILES` set in the environment; listing the files in the project's `.yarnrc.yml` fixes it. Calavera reads the folder Yarn ran in from `/proc` on Linux. On macOS and Windows, the `.env.yarn` files Yarn could have read for the run count, and only the variables those files set from a variable are ignored; a variable you set is then also ignored when one of those files sets it from a variable. A value those files set without a `$`, and a variable you set that no such file sets, apply as before. When the ignored variable is `HTTPS_PROXY`, `HTTP_PROXY`, or `PROXY`, Calavera sends its lookups and downloads, redirects included, without that proxy. When a `.yarnrc.yml` setting or `YARN_INJECT_ENVIRONMENT_FILES` names an environment file with a variable in its path, Calavera cannot tell which file Yarn loaded, so it ignores every registry and proxy variable with a warning.

  When Bun runs Calavera directly, such as with `bun calavera.js`, Calavera now reads the Bun settings instead of the npm settings, because no package manager started it. Bun sets neither `npm_execpath` nor `npm_config_user_agent` then, so a project `.env` could set them; a launcher variable that a `.env` file Bun loaded defines is now ignored with a warning that names the file. Under the Bun settings, Calavera reads no proxy from `.npmrc` files or `npm_config_*` variables, as Bun does not, so a `proxy`, `https-proxy`, or `noproxy` in your `~/.npmrc` no longer applies to such a run; a note names each `proxy`, `https-proxy`, and `noproxy` it skips, and `HTTPS_PROXY` and `NO_PROXY` still apply. When a file entry with a variable makes Calavera ignore an `npm_config_*` value under `npx`, `npm exec`, or `npm run`, and that value is not npm's own expansion of the entry, a note now says that a value you set for that variable was ignored too, and how to keep it.

### Minor Changes

- 827da59: Artifact lookups and the version notice now use the registry and proxy of the package manager that started Calavera. The `proxy`, `https-proxy`, and `noproxy` settings in your user `.npmrc` and the matching `npm_config_*` variables now apply, except under Bun, which does not support them, so a proxy set only in `.npmrc` no longer makes lookups fail. A `noproxy` in the project `.npmrc` also applies, but a proxy in a project file is ignored with a warning, and it never replaces the proxy in your user configuration. When npm starts Calavera (`npx`, `npm exec`, `npm run`), the project `.npmrc` is now the one npm read at its local prefix, such as the workspace root when you run from a workspace member, so a registry or proxy that npm passes on from that file follows the project rules; before, a workspace root `.npmrc` registry passed on this way was trusted as your environment. A project proxy written with another spelling, such as `https_proxy`, is recognized too, and a `noproxy` list that npm passes on is split into hosts. Under Yarn 2 or later, Calavera reads `npmRegistryServer`, `npmScopes`, `httpProxy`, and `httpsProxy` from your `.yarnrc.yml` files and `YARN_*` variables, and uses Yarn's default registry when none is set. Under Bun, it reads `[install] registry` and `[install.scopes]` from `bunfig.toml`, then the first of `BUN_CONFIG_REGISTRY`, `NPM_CONFIG_REGISTRY`, and `npm_config_registry` that starts with `http://` or `https://`, as Bun does. Warnings and errors name a setting, never its value, because a proxy or registry URL can carry credentials (#1064).
- 22cf9a6: The CLI now tells you when it is older than the version the npm `latest` dist-tag names, which happens when a package manager runs a copy it cached earlier (#675). After the command's own output, and after an error too, it prints a notice on standard error that names both versions and repeats your command pinned to `latest`; when Calavera is a project dependency, the notice also gives the command that updates it. The check asks the registry your npm configuration names, waits at most 1.5 seconds, writes no file, and prints nothing when it fails. It is skipped for `--json`, `--help`, `artifacts status` and `artifacts doctor` without `--check-updates`, and the MCP server. Set `CALAVERA_NO_VERSION_CHECK` to `1` or `true` to turn it off. Artifact-core adds `resolvePackageDistTag`, which resolves a dist-tag with the same registry settings as the artifact commands.
- 32d7e02: `artifacts status` and `artifacts doctor` now print each artifact with its locked version and channel instead of a single completion line. With `--check-updates`, each available update shows the installed and latest versions, a link to the release notes in the package's `CHANGELOG.md` on GitHub, and the command that applies it through the recipe's package manager, with `--tag next` for a `next`-channel artifact and `--config` for a recipe at another path. When an update is available and the recipe selects more than one artifact, with every locked one on one channel, status also prints the `--all` command. When every artifact is current, it says so. `--json` adds `releaseNotesUrl`, `updateCommand`, and `installCommand` to each artifact, and `updateAllCommand` and `checkUpdatesCommand` to the result. The link comes from the `repository` metadata of the published package, which `resolveArtifactPackage` in `@schalkneethling/calavera-artifact-core` now returns; without GitHub repository metadata, status still reports the update and its command (#398).
- 1e2dba1: The catalogs now carry the display labels that the Composer shows. `@schalkneethling/calavera-artifact-core` exports `ARTIFACT_TARGET_LABELS`, which maps each artifact target ID to the tool's own name, such as `claude-code` to "Claude Code". In `create-project-calavera`, each integration from `list_integrations` and `describe_integration` has a `statusLabel`, such as "Recommended" or "Framework-specific", which the MCP output schema declares, and each artifact from `list_ai_artifacts`, and from the `aiArtifacts` of `explain_recipe`, has `targets`, a list of `{ id, label }` objects that is empty for skills. The `compose_recipe` input description now says that an artifact's `target` is one of those IDs, not a directory. Recipe output does not change (#580).

### Patch Changes

- 4766fcb: `artifacts status --check-updates`, `artifacts doctor --check-updates`, and the MCP `artifact_status` tool with `checkUpdates` no longer wait indefinitely for a registry that accepts the connection and never answers. Each artifact's registry lookup now has a deadline of 15 seconds. When a lookup misses it, Calavera ends the request and reports that artifact as "update check failed" with the code `ELOOKUPTIMEOUT`, the reason "the registry did not answer the lookup for <package> within 15000 ms", and a remedy that names the command to run again. Calavera then sends no further lookups to that registry, identified by its URL, path included, in the same run: it reports each remaining artifact on that registry as "update not checked", with the code `ELOOKUPSKIPPED`, a reason that names the registry, and the same remedy, and it still checks artifacts on other registries, including a registry on the same host under another path. A run therefore waits for at most one deadline per registry that does not answer. Before, the lookup waited for npm's own timeout of five minutes. A lookup that misses the deadline still names the npm configuration Calavera ignored that may explain it, when the lookup reports it in time. Artifact-core's `resolveArtifactPackage` accepts a `signal` that ends the lookup when it is aborted, and a `beforeLookup` callback that receives the registry, with its URL, before any request is sent; an error the callback throws ends the lookup without a request (#1138).
- dd12688: Calavera now accepts an artifact tarball URL from a registry only when it is an `https` URL, or an `http` URL on `localhost`, `127.0.0.1`, or `::1`. Before, a registry's package document could name a `git+ssh:`, `git+https:`, `file:`, or plain `http` tarball URL, and pacote would run git with your SSH agent and credential helpers, read a file on your machine, or fetch over an unencrypted connection. Any other tarball URL, including an `https` URL that names a git repository, such as `https://github.com/owner/repo`, and a `registry.npmjs.org` URL that pacote would move onto a plain-`http` registry on another host, now stops with the error code `EBADTARBALLURL`, before anything is fetched. The error names the package and says why the URL was refused. It quotes the URL's protocol only when the protocol has at most 16 characters, and never the rest of the URL (#1194).
- c0490d4: Calavera no longer follows a redirect that would move an artifact lookup or download to plain `http` on a host other than `localhost`, `127.0.0.1`, or `::1`. Before, a registry or tarball host on `https` could redirect to plain `http`, so anyone on the network could see which package was fetched and, for a lookup, replace the package document. A package document lookup that started on `https`, or passed through it, and any tarball download, now stops before the `http` request with the error code `EINSECUREREDIRECT`. The error names the package and the two protocols, and quotes no URL. A plain-`http` registry that your own user configuration or environment names may still redirect a lookup over plain `http`, but only to its own host (the same host and port) or to `localhost`, `127.0.0.1`, or `::1`; a redirect to another plain-`http` host now stops with the same code. Redirects between `https` hosts and between loopback `http` hosts still work, and proxy settings apply as before. `artifacts status --check-updates`, `artifacts doctor --check-updates`, and the read-only `artifact_status` MCP tool report a refused lookup for that artifact, with a reason and a remedy that name no URL, and check the other artifacts instead of stopping (#1207).
- 1c0e622: `artifacts status --check-updates` and `artifacts doctor --check-updates` no longer fail for every artifact when one artifact's registry lookup fails, such as an artifact locked on `next` when npm has no `next` tag for its package. Status reports that artifact as "update check failed" with the cause, the npm configuration Calavera ignored that may explain it, and a remedy where one applies, and reports the others as usual. `--json` adds `updateCheckFailure` to each artifact and `updateAllBlockedBy` to the result, because status withholds the all-artifacts update command while a selected artifact's check failed. Because a failed check is not a problem with the installed files, `artifacts doctor --check-updates` now exits 0 when a registry lookup fails and the installed files are healthy, where it exited 1 before; its closing lines name the artifacts whose check failed. Errors that Calavera raises itself, such as an invalid `.npmrc` registry or a package identity mismatch, and local file system errors, such as a cache folder Calavera cannot write, still stop the command. Artifact-core's registry errors now carry the npm configuration notes as `npmDiagnostics` and `unsetVariables`, keep minipass-fetch's `type` when they wrap a failure, and use the code `EBADPACKUMENT`, with the original error as `cause`, when the registry returns a package document that cannot be read.

## 0.6.0

### Minor Changes

- 23b1b46: The input default kind `current-branch` is replaced by `repository-default-branch` in the artifact schema, in the artifact catalog's `ArtifactInput` type, and in the protected branch guard's `calavera-artifact.json` (#846). The new name says what Calavera suggests: the repository's default branch, which is not read from the current branch. A manifest that declares `current-branch` no longer validates against the artifact schema. The schema version stays 1. A Calavera release that predates this change reads the guard's input from its own bundled catalog, not from the installed manifest, so it keeps working with this artifact.

## 0.5.0

### Minor Changes

- 6c1d4b8: Skill artifacts can now declare inputs and wiring in `calavera-artifact.json` (ADR-0015, Decisions 4 and 6), and the artifact catalog carries them. An input such as `protectedBranch` has a prompt, an optional default, and a check. A recipe can record an answer on the artifact's entry, as in `{ "id": "skill-protected-branch-guard", "inputs": { "protectedBranch": "main" } }`, and `compose_recipe` accepts `inputs` on each AI artifact. Recipe validation refuses a value for an input the artifact does not declare. No artifact declares inputs or wiring yet, and apply does not read them yet; `skill-protected-branch-guard` will be the first artifact to use them.
- 873e517: Add `skill-protected-branch-guard`, which refuses a commit, a push, or a Claude Code file edit on the branch you protect (ADR-0015). Apply installs the skill and wires it into the project: a marked block in `.vite-hooks/pre-commit`, `.vite-hooks/prepare-commit-msg`, and `.vite-hooks/pre-push`, and hook groups in the committed `.claude/settings.json`. The dry run shows every line and group first, and apply stops with a conflict, writing nothing, when you have edited its part.

  Calavera asks for the protected branch, with the current branch as the default, and records it in the recipe. `compose_recipe` reports the input and its default, `dry_run_apply` returns the recipe with the value filled in, and `apply_recipe` refuses a recipe that does not record it, so the branch cannot change between approval and apply. When Git would not run the hooks, because the Vite+ hook dispatcher is not installed or hooks are turned off in the clone, apply warns and names the command that fixes it.

  A rewritten `.claude/settings.json` is formatted before the dry run with the project's own `vp fmt`, so it already passes `vp check` with the project's formatter settings.

## 0.4.2

### Patch Changes

- 1d5a412: Artifact resolution and extraction now honor the npm registry configuration. The registry, the registry of the artifact scope (`@scope:registry`), and registry credentials are read from the user `.npmrc`, the project `.npmrc` in the current directory, and `npm_config_*` environment variables, so private and mirrored registries work. `${VAR}` is expanded only in the user `.npmrc` and the environment; a project `.npmrc` entry that contains it is ignored with a warning, including when npm exports the expanded value to Calavera. A registry URL with a username or password is rejected, a project `.npmrc` must use an `https` registry, and `certfile` and `keyfile` are read only from the user `.npmrc`. The dry run of `apply`, `artifacts install`, and `artifacts update`, and the `dry_run_apply` MCP tool, now report the registry (`artifactRegistries`, such as `https://registry.npmjs.org`) and configuration warnings (`artifactWarnings`). Proxy, CA, and `strict-ssl` settings from an `.npmrc` are not read; `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS` apply. Credentials never appear in error messages.

## 0.4.1

### Patch Changes

- fba4a61: Drop the upper bound from the Calavera compatibility range so the artifact installs on create-project-calavera 3.0.0 and later. Every artifact declared `<3`, and the 3.0.0 CLI rejected all of them at install time while the hosted Composer hid them as waiting for a newer CLI. The lower bound stays: it is what keeps Composer from offering an artifact before a CLI that can install it is published. A change to the manifest contract itself is signaled by `schemaVersion`, not by a CLI major. The artifact catalog in `@schalkneethling/calavera-artifact-core` carries the same ranges and changes with them.

## 0.4.0

### Minor Changes

- 9386307: Isolate independently versioned skills, hooks, and agents from the CLI runtime dependency graph while preserving explicit locked artifact installation and updates.

## 0.3.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [d65cb63]
- Updated dependencies [5d620bc]
- Updated dependencies [398c6bb]
  - @schalkneethling/calavera-skill-release-with-confidence@0.2.0

## 0.3.0-next.1

### Patch Changes

- 5d620bc: Allow prerelease Calavera CLIs to install artifacts from compatible release lines and explicitly admit the Release with Confidence skill on the 2.4 prerelease line.
- Updated dependencies [5d620bc]
- Updated dependencies [398c6bb]
  - @schalkneethling/calavera-skill-release-with-confidence@0.2.0-next.1

## 0.3.0-next.0

### Minor Changes

- d65cb63: Add the Release with Confidence skill as an independently versioned Calavera artifact, expose it through the shared catalog, and keep browser surfaces gated until a compatible CLI is published.

### Patch Changes

- Updated dependencies [d65cb63]
  - @schalkneethling/calavera-skill-release-with-confidence@0.2.0-next.0

## 0.2.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- Updated dependencies [76d85ef]
- Updated dependencies [e3e46a7]
- Updated dependencies [71d46d1]
- Updated dependencies [dd70f1e]
  - @schalkneethling/calavera-skill-calavera@0.2.0
  - @schalkneethling/calavera-skill-code-review@0.2.0
  - @schalkneethling/calavera-skill-css-tokens@0.2.0
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0
  - @schalkneethling/calavera-skill-frontend-security@0.2.0
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0
  - @schalkneethling/calavera-skill-project-goal@0.2.0
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0

## 0.2.0-next.3

### Patch Changes

- e3e46a7: Verify the complete prerelease cohort through npm trusted publishing without a token fallback.
- Updated dependencies [e3e46a7]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.3
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.3
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.3
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.3
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.3
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.3
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.3
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.3
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.3
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.3
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.3
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.3
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.3
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.3
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.3

## 0.2.0-next.2

### Patch Changes

- 71d46d1: Retry the complete prerelease cohort with npm-compatible provenance metadata.
- Updated dependencies [71d46d1]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.2
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.2
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.2
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.2
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.2
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.2
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.2
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.2
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.2
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.2
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.2
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.2
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.2
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.2
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.2

## 0.2.0-next.1

### Patch Changes

- 76d85ef: Retry the prerelease cohort after correcting the package artifact upload destination.
- Updated dependencies [76d85ef]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.1
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.1
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.1
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.1
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.1
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.1
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.1
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.1
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.1
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.1
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.1
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.1
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.1
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.1
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.1

## 0.2.0-next.0

### Minor Changes

- dd70f1e: Extract every maintained Calavera skill, hook, and agent into an independently versioned package backed by a validated artifact manifest and shared catalog.
- 6ae1222: Add package-backed artifact recipe selections, migration, exact lockfiles, verified cached extraction, offline status, doctor, targeted updates, and local-edit-safe installation.

### Patch Changes

- Updated dependencies [dd70f1e]
  - @schalkneethling/calavera-skill-calavera@0.2.0-next.0
  - @schalkneethling/calavera-skill-code-review@0.2.0-next.0
  - @schalkneethling/calavera-skill-css-tokens@0.2.0-next.0
  - @schalkneethling/calavera-skill-frontend-engineering@0.2.0-next.0
  - @schalkneethling/calavera-skill-frontend-security@0.2.0-next.0
  - @schalkneethling/calavera-skill-frontend-testing@0.2.0-next.0
  - @schalkneethling/calavera-skill-github-goal-issue-triage@0.2.0-next.0
  - @schalkneethling/calavera-skill-more-secure-dependabot-config@0.2.0-next.0
  - @schalkneethling/calavera-skill-npm-publishing-best-practices@0.2.0-next.0
  - @schalkneethling/calavera-skill-npm-trusted-publishing-github-workflow@0.2.0-next.0
  - @schalkneethling/calavera-skill-project-goal@0.2.0-next.0
  - @schalkneethling/calavera-skill-refined-plan-mode@0.2.0-next.0
  - @schalkneethling/calavera-hook-auto-approve-safe-commands@0.2.0-next.0
  - @schalkneethling/calavera-hook-block-dangerous-commands@0.2.0-next.0
  - @schalkneethling/calavera-agent-technical-devils-advocate@0.2.0-next.0
