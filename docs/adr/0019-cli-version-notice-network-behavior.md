# ADR-0019: The CLI Version Notice and Its Network Behavior

- **Status:** Proposed
- **Date:** 2026-11-18
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/675
- **Decides:** how the CLI tells a person that the Calavera they are running is older than the version the npm `latest` dist-tag points to. The CLI asks the registry for `latest` once per run, in parallel with the command, with the registry and authentication settings that the artifact commands already read. It prints a short notice to standard error after the command's own output, whether the command succeeded or failed, and only when the running version is lower than `latest`; the notice informs and is not styled as an error. It repeats the person's command, pinned to the `latest` version, so it runs as printed, and when Calavera is a project dependency it adds one sentence saying that the dependency is unchanged and the command that updates it. The Yarn and Bun registry settings and `.npmrc` proxy settings are not read until #1064 lands. A failed, slow, or offline check prints nothing, unless `CALAVERA_DEBUG` is on, and it never changes the exit code. The check does not run for `--json`, for `--help`, for the artifact commands that promise to stay offline, or in the MCP server, and the `CALAVERA_NO_VERSION_CHECK` environment variable turns it off. The check writes no file anywhere. The owner answered the open questions of the first draft on 2026-11-19 on #675, and each answer is recorded in the decision it belongs to. This document changes no code.

## Context

npm can run a stale Calavera without saying so. For `npm create project-calavera`, npm runs `npm exec create-project-calavera` ("`npm init foo` -> `npm exec create-foo`", [npm init](https://docs.npmjs.com/cli/v11/commands/npm-init)), and it reuses a copy of the package that is already installed in its `_npx` folder. The issue's reproduction shows this under npm 11.19.0: with 4.0.2 in that folder, `npm create project-calavera -- --dry-run --new` ran 4.0.2 while 4.1.0 was `latest`, and npm's log showed only `GET 200 .../create-project-calavera (cache revalidated)`. The npm documentation describes the cache use ("The npm cli utilizes its internal package cache when using the package name specified", [npm exec, "A note on caching"](https://docs.npmjs.com/cli/v11/commands/npm-exec)) but does not state when a cached copy satisfies a spec without a version, so the reproduction, not the documentation, is the evidence for that part.

The issue offered two fixes: print and document only versioned commands, or have the CLI tell the person when it is older than `latest`. The owner chose the notice on 2026-11-14 and asked for this ADR on its network behavior before implementation: when it checks, how it behaves offline or behind a proxy, how it stays quiet in `--json` and MCP output, and how a person turns it off. Item 4 of the `cli-experience` exit condition (`docs/cross-repo/sequencing-map.md`, Section 0) requires that a Calavera older than `latest` prints the notice. The rehearsal check for it already exists (`versionNoticeCheck` in `scripts/rehearsal-checks.mjs`): it serves a newer `latest` from a local registry named in the user `.npmrc` and in `npm_config_registry`, runs `--init --dry-run --yes`, and looks for both versions in the combined standard output and standard error.

The owner answered the seven open questions of the first draft on 2026-11-19 in https://github.com/schalkneethling/create-project-calavera/issues/675#issuecomment-7012272995. Each answer appears below as "owner decision of 2026-11-19". The same comment confirms that the notice only informs: the command runs to the end with the installed version, and the notice prints afterwards on standard error.

## What exists today

### The Composer already reads `latest`

The hosted Composer asks the registry for the latest CLI version when the page loads. `loadPublishedCliCompatibility` in `apps/composer/cli-compatibility.js` fetches `NPM_LATEST_CLI_URL`, which is `https://registry.npmjs.org/create-project-calavera/latest`, with `Accept: application/json`, checks that `version` is a valid semantic version, and falls back to `SAFE_CLI_FALLBACK_VERSION` (2.2.0) on any failure. The fetch function is a parameter, so tests run it without a network. `apps/composer/script.js` calls it once and filters the catalog by the result. The npm registry documents this endpoint as `GET /{package}/{version}`, where the version is "a version number or `latest`" ([REGISTRY-API.md](https://github.com/npm/registry/blob/main/docs/REGISTRY-API.md)).

The Composer's request suits a browser. It always goes to `registry.npmjs.org`, it sends no credentials, and it uses the global `fetch`. In Node.js, the global `fetch` uses the `HTTP_PROXY`, `HTTPS_PROXY`, and `NO_PROXY` variables only when `NODE_USE_ENV_PROXY=1` or `--use-env-proxy` is set ([Node.js CLI, `NODE_USE_ENV_PROXY`](https://nodejs.org/api/cli.html#node_use_env_proxy1); [Node.js HTTP, "Built-in Proxy Support"](https://nodejs.org/api/http.html#built-in-proxy-support)), so the same request in the CLI would fail behind most proxies.

### The CLI already reaches the registry for artifacts

`resolveArtifactPackage` in `packages/artifact-core/src/registry.js` resolves a tag such as `latest` with `pacote.manifest`. It passes the options that `loadNpmRegistryOptions` (`packages/artifact-core/src/npm-config.js`) builds: the registry and authentication keys from the user `.npmrc`, the project `.npmrc`, and `npm_config_*` variables, with npm's precedence. It also passes `fullMetadata: true` and a cache folder in the project (`.calavera/cache/npm`, or a temporary folder for a dry run, from `packages/cli/src/artifact-lifecycle.js`).

pacote sends the request through `npm-registry-fetch` and `@npmcli/agent`. The agent reads the proxy environment variables in any letter case: for an `https:` registry it uses `https_proxy`, for an `http:` registry `https_proxy`, `http_proxy`, or `proxy`, and it skips the proxy for hosts in `no_proxy` (`@npmcli/agent/lib/proxy.js`). Without `fullMetadata`, pacote asks for the abbreviated package document (`application/vnd.npm.install-v1+json`), which lists the `dist-tags` ([package-metadata.md](https://github.com/npm/registry/blob/main/docs/responses/package-metadata.md)), and it retries with the full document when the registry answers 404 (`pacote/lib/registry.js`). pacote writes an HTTP cache only when it is given a `cache` option: its default cache folder is kept for tarballs and is not passed to the package-document request, and `make-fetch-happen` caches nothing without a cache path (`pacote/lib/fetcher.js`, `pacote/lib/registry.js`, `make-fetch-happen/lib/cache/policy.js`).

`loadNpmRegistryOptions` reads only `.npmrc` files and `npm_config_*` variables, and among those only registry and authentication keys. It does not read proxy or certificate-authority settings from `.npmrc` (its header comment says so), and it does not read Yarn's or Bun's registry settings. The artifact commands share these gaps today.

### Which commands promise to stay offline

The README says that `artifacts status` "contacts no registry" and that `artifacts doctor` verifies a project "without checking the registry", in both cases unless `--check-updates` is given. ADR-0018 (Decision 3) relies on the same promise for the planned artifact status MCP tool.

### How the CLI and the MCP server print

`printResult` in `packages/cli/src/index.js` prints a `--json` result with `console.info`, which writes to standard output, and the human summaries through `logger` (`packages/cli/src/utils/logger.js`), whose `info` and `success` write to standard output and whose `warn` and `error` write to standard error. `--new` refuses `--json` (in `newProject`). `runCli` prints a failure through `formatErrorChain` to standard error and sets the exit code to 1. Two cancel paths call `process.exit(0)` (in the interactive prompts and in `newProject`). `newProject` changes the working directory with `process.chdir`.

The MCP server (`packages/cli/src/mcp.js`) talks JSON-RPC over standard input and output. The MCP specification says that the server "MUST NOT write anything to its `stdout` that is not a valid MCP message" and "MAY write UTF-8 strings to its standard error (`stderr`) for logging purposes", and that clients "MAY capture, forward, or ignore this logging" ([MCP transports, stdio](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio)). `runMcpEntrypoint` writes one start line to standard error. The registration that `agent-init` writes pins the version, `create-project-calavera@<version>` (`createMcpLaunchCommand` in `index.js`).

### Environment variables

The CLI reads one switch of its own, `CALAVERA_DEBUG`. `isDebugEnabled` in `packages/cli/src/utils/error-chain.js` treats `1` or `true`, in any letter case, as on. The README's "Debugging Errors" section documents it, and explains why it is an environment variable rather than a flag: it must also reach the MCP server that an agent client starts.

### One core, several adapters

ADR-0018 (Decision 2) makes the CLI, the MCP server, and the Composer adapters over one core in the same process. An adapter translates input and output and holds no logic of its own.

## Decision

### 1. Which runs check

The CLI checks for a newer version when it runs a command that prints human output. It does not check:

- When `--json` is given. The person or program asked for a machine-readable document on standard output, and the owner asked that this output stay quiet; the owner decision of 2026-11-19 confirms that `--json` skips the check. The README's `npm create project-calavera doctor --json` and `apply -- --dry-run --json` examples therefore get no notice, even though they use the unversioned form that runs a stale copy. That is the accepted cost of a quiet machine-readable mode.
- For `--help` (`options.command === "help"`), because help must work instantly and offline.
- For `artifacts status` and `artifacts doctor` without `--check-updates`, because the README promises that they contact no registry. With `--check-updates`, they contact the registry anyway, and the check runs.
- In the MCP server. Its registrations pin a version on purpose, standard output is reserved for protocol messages, and clients may discard standard error, so the notice would rarely reach a person. ADR-0018 adds an MCP capability only where a structured tool adds something; an agent that runs the CLI in a shell sees the notice there.
- When `CALAVERA_NO_VERSION_CHECK` is on (Decision 5).

The check does not depend on a terminal or on `CI`. Agents run the CLI without a terminal and read its output, and they are a primary audience, so they should see the notice.

### 2. When the check runs and how long it may take

The CLI starts the request as soon as it has parsed the arguments, and runs it in parallel with the command, so that a command that takes longer than the request costs no extra time. The core function captures the working directory and the environment when it starts, because `newProject` changes the working directory while the request may still be open. The request has a deadline of 1,500 milliseconds from its start (owner decision of 2026-11-19), which allows a slow registry or proxy round trip and keeps the worst added wait under two seconds. It has no retries: the CLI passes `fetchRetries: 0` and an `AbortSignal` as `signal`, which pacote passes through to `npm-registry-fetch` with its other options. When the command finishes before the request, the CLI waits at most until the deadline and then aborts the request, so an open request never keeps the process alive. A run therefore takes at most 1,500 milliseconds longer than it would without the check, and only when the command itself is faster than that and the registry is slow or unreachable.

The CLI checks on every run and keeps no record of earlier checks. A record would be a new file Calavera writes outside the project, and one small request per run is cheap.

### 3. Where the request goes

The check reads the registry and authentication settings with `loadNpmRegistryOptions` and resolves `create-project-calavera@latest` with `pacote.manifest`, as `resolveArtifactPackage` does, but with the abbreviated package document and without a `cache` option, because it needs only the `latest` version and must write nothing. It therefore asks the registry that the person's npm configuration names, with the same credentials, and it follows the proxy environment variables through `@npmcli/agent`. It does not use the Composer's fixed `registry.npmjs.org` URL, because a person on a private registry or a mirror would otherwise be compared with a `latest` they cannot install.

Artifact-core gains one function that resolves a dist-tag of a package name to a version with these settings, because artifact-core already owns the npm configuration and the registry requests. The CLI holds no registry code of its own.

The registry is the one npm and pnpm read. Yarn 2 or later and Bun read their own settings, which `loadNpmRegistryOptions` does not, so under those launchers the check can ask a different registry than the one that installed Calavera. Proxy settings that exist only in `.npmrc` do not reach the request either. The owner decision of 2026-11-19 accepts both gaps for this ADR: #1064 changes `loadNpmRegistryOptions` to read `proxy`, `https-proxy`, and `noproxy` from `.npmrc`, and the Yarn and Bun registry settings, so the fix reaches the notice and the artifact commands at once. The notice needs no change of its own when #1064 lands.

### 4. What the notice says and where it goes

The CLI compares its own version (`packageJson.version`) with `latest` by semantic version precedence. It prints the notice only when its version is lower. A prerelease that is newer than `latest`, such as one installed from `next`, prints nothing. The comparison uses the `semver` package, which the CLI package adds as a direct dependency at the version artifact-core pins, because pnpm does not let the CLI import artifact-core's dependency.

The notice goes to standard error, as the owner confirmed on 2026-11-19. Standard output carries a command's result, and standard error carries messages about the run: POSIX opens `stdout` "for conventional output" and `stderr` "for diagnostic output" ([POSIX, `stdin`](https://pubs.opengroup.org/onlinepubs/9799919799/functions/stdin.html)). A shell pipe and a command substitution take only standard output: in Bash, "The standard output of command is connected via a pipe to the standard input of command2", and `$(command)` is replaced "with the standard output of the command" (`bash(1)`, sections "Pipelines" and "Command Substitution"). So the notice stays out of captured and piped output, and a person still sees it in the terminal.

Standard error is not only for errors, and the notice is not styled as one. It does not go through `logger.error` or `logger.warn`, whose red and yellow mark a failure or a problem with the run. It uses the informational color that `logger.info` uses, through `style` in `packages/cli/src/utils/text.js`, with `util.styleText`'s `stream` option set to `process.stderr`, so the color follows whether standard error is a terminal. The notice names the running version and the `latest` version, and it gives the command the person ran, rebuilt to run the `latest` version pinned to its exact number. The command uses the launching package manager, from `launchingPackageManager` (which reads `npm_config_user_agent`) and `createPackageRunnerCommand`, followed by the arguments of this run, quoted by the existing `formatShellCommand`. The command therefore runs as printed, which the release goal requires of every printed command. For example, after `npm create project-calavera -- --init --dry-run` under npm:

```
create-project-calavera 6.2.1 is running, but 6.3.0 is the latest release. To run 6.3.0: npx --package create-project-calavera@6.3.0 create-project-calavera --init --dry-run
```

When Calavera runs from the project's own dependencies, the notice adds one sentence, as the owner decided on 2026-11-19: the project's dependency is unchanged, and this command updates it. The run above uses the installed version, and the command shown first runs `latest` once without touching the project. The update command comes from `devDependencyInstallCommand` in `packages/cli/src/index.js`, the function that builds apply's install command, with `create-project-calavera@<latest>` as the dependency: `vp add -D` when Vite+ manages the project (ADR-0012), and the package manager's own command otherwise. The CLI treats a run as a project dependency when its own package folder is inside a `node_modules` folder of the project it works in, and that project's `package.json` lists `create-project-calavera`.

The exact wording is the implementation's choice; the content is fixed here.

The CLI prints the notice after the command's own output, so that it never interrupts a prompt or the output of `vp create` during `--new`. It also prints it after an error, because an old version is a likely cause of the error (owner decision of 2026-11-19). The two cancel paths that call `process.exit(0)` print no notice, because the person stopped the run. The notice never changes the exit code.

### 5. Turning it off

`CALAVERA_NO_VERSION_CHECK` set to `1` or `true`, in any letter case, turns the check off, and it is the only switch (owner decision of 2026-11-19): the CLI makes no request and prints nothing. It parses like `CALAVERA_DEBUG`, and the README documents both in one place. It is an environment variable rather than a flag, so that a person can set it once for a shell, a CI job, or an agent, and so that `npm create project-calavera -- <arguments>` needs no extra argument. The CLI does not read other tools' switches, such as `NO_UPDATE_NOTIFIER` from the `update-notifier` package or npm's `update-notifier` setting, because they belong to those tools and their meaning can change without Calavera.

### 6. Failures stay quiet and diagnosable

An offline machine, a DNS failure, a refused connection, a proxy that blocks the request, a timeout, a status other than success, or a response without a valid version prints no notice and changes nothing else. A version check must not make a working command look broken. When `CALAVERA_DEBUG` is on, the CLI prints one line to standard error that says the version check failed, followed by the redacted cause chain from `formatErrorChain`, so that a person behind a proxy can see why no notice appears. Redaction matters here, because a registry URL or a request error can carry a token from `.npmrc`.

### 7. One core function and tests without a network

The check is a core function in the CLI package that takes the running version, the arguments, the working directory, the environment, and a function that resolves `latest`, and returns either nothing or the notice's facts: the running version, `latest`, and the command. The CLI adapter starts it, applies the deadline, and prints its result. This follows ADR-0018 Decision 2 and the Composer's `loadPublishedCliCompatibility`, whose fetch function is a parameter.

The unit tests pass a resolver that returns a version or throws, so they cover an older, an equal, and a newer version, a failure with and without `CALAVERA_DEBUG`, `--json`, `--help`, the offline artifact commands, and the switch, without network access, as the issue's acceptance criterion requires. The tests that start the CLI's bin as a process, such as those in `packages/cli/scripts/`, set `CALAVERA_NO_VERSION_CHECK=1`, so that they make no real registry request and their standard error stays unchanged. The rehearsal keeps only an allowlist of variables from the caller's environment (`scripts/rehearse-cli-experience.mjs`), so a switch set in a developer's shell cannot hide the notice from the rehearsal check.

### 8. How C8 holds

- **Only the CLI writes into projects.** The check writes no file, in the project or elsewhere (Decision 3).
- **`dry_run_apply` is the approval boundary.** This is unchanged; the MCP server does not check.
- **Local edits are preserved.** This is unchanged, because the check writes nothing.
- **Artifacts are not recorded in `package.json`.** This is unchanged.
- **Conflicts surface as a hard stop or a migration decision.** This is unchanged.

## Consequences

Every human-output run that Decision 1 does not exempt makes one registry request, unless the switch is on. The request tells the configured registry that Calavera ran, with a user agent that names `npm-registry-fetch` and the Node.js version (`npm-registry-fetch/lib/default-opts.js`) and, for a private registry, the configured credentials, as the artifact commands that resolve packages already do. A person on a slow or blocked network waits up to 1,500 milliseconds longer for a command that is faster than that, and sees no notice. Until #1064 lands, a person whose proxy is configured only in `.npmrc` sees no notice, and under Yarn 2 or later or Bun the check can ask a different registry than the launcher used (Decision 3).

The README documents `CALAVERA_NO_VERSION_CHECK` next to `CALAVERA_DEBUG`, and says which runs skip the check.

The documented `npm create project-calavera` commands stay unversioned. The notice tells the person when that form ran a stale copy; it does not prevent the stale run.

## Alternatives considered

**Print and document only versioned commands.** The issue's first option. The owner chose the notice on 2026-11-14.

**Reuse the Composer's request: the global `fetch` of `registry.npmjs.org`.** This was rejected because it ignores the configured registry and its credentials, and, without `NODE_USE_ENV_PROXY`, every proxy.

**Check at most once a day, with a record of the last check.** This is how `update-notifier` works by default (`updateCheckInterval`, one day). It was rejected because the record is a new file outside the project and the saving is one small request.

**Print the notice before the command runs.** This would warn before a stale version changes anything, but it makes every run wait for the network first, and on a failure it adds the full deadline to every run. Printing after the command costs nothing when the command is slower than the request.

**Print the notice to standard error in `--json` mode, or add the versions to the JSON result.** The first would keep the JSON on standard output intact, and the second would change the shape of every JSON result. The owner decided on 2026-11-19 that `--json` skips the check.

**Read `NO_UPDATE_NOTIFIER` as well.** The owner decided on 2026-11-19 that `CALAVERA_NO_VERSION_CHECK` is the only switch (Decision 5).

**Skip the check when Calavera is a project dependency.** The owner decided on 2026-11-19 to show the notice there, with the update command, because the person still learns that a newer release exists.

**Skip the check in CI or without a terminal.** This was rejected because agents often run without a terminal, and they should see the notice.
