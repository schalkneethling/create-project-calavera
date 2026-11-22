# ADR-0021: Remove Registry Credentials from Artifact Downloads

- **Status:** Proposed
- **Date:** 2026-11-22
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/1185
- **Decides:** Calavera stops reading, expanding, and sending the registry credentials that npm, Yarn, and Bun configuration can hold. The registry settings loader in artifact-core keeps the registry, the registry of the artifact scope, and the proxy settings, and keeps nothing else: every `//host/:` credential key (`_authToken`, `_auth`, `username`, `_password`, `certfile`, and `keyfile`) goes, from every source, together with the code that exists only to protect those credentials. A registry that answers 401 or 403 fails with a message that names the registry and says that Calavera sends no credentials. No flag, setting, or deprecated path brings credentials back. Private mirrors that require authentication become unsupported, and #1165 (Yarn and Bun credentials) stays closed as not planned. Credentials that a registry or proxy URL carries inside the URL itself are open questions 1, 2, and 3. This document changes no code. The issue's scope puts the ADR and the removal in one pull request; this ADR is proposed on its own first so that the owner can answer its open questions before the code changes, and the implementation pull request closes #1185.

## Context

The owner decided on 2026-11-22 that Calavera never needs access to a secret, so it stops reading registry credentials altogether, and that registry and proxy settings stay (https://github.com/schalkneethling/create-project-calavera/issues/1064#issuecomment-7084597069). The owner's rule for secrets is that sensitive credentials are used only through Varlock with 1Password locally, or through a platform's secret store on a platform, and never from plain text on disk. A `//host/:_authToken` line in an `.npmrc` file is exactly that plain text.

Calavera's own artifacts are public packages in the `@schalkneethling` scope on the npm registry, so no Calavera feature needs a credential to work. Credential reading came from #608, which asked that artifact resolution honor "the user's npm registry and auth configuration", so that a person behind a private registry or a mirror could still resolve artifacts. That use case becomes unsupported when the registry demands authentication. It keeps working when the mirror serves the artifact packages without authentication.

The removal follows a run of security reviews on #1064 (PR #1161). Each review found another route by which repository content could reach a credential: a project `.npmrc` that names a `userconfig`, a Yarn 4 `.env.yarn` that sets an http registry or a proxy, a spoofed package manager user agent, and a same-host https-to-http redirect that make-fetch-happen follows with the `Authorization` header still attached. PR #1161 answers the first three with two invariants: no credential over plain http, and credentials only from the account's real `~/.npmrc` when a package manager starts Calavera. The owner accepted the redirect gap "only until #1185 removes credential reading entirely" (https://github.com/schalkneethling/create-project-calavera/issues/1064#issuecomment-7084781247). When Calavera holds no credential key, none of these routes has a credential to carry.

The issue's litmus test is a removal: Calavera must never hold a secret. Vite+ is unaffected, because it does not fetch Calavera's artifacts.

## What exists today

### The loader on `main`

`loadNpmRegistryOptions` in `packages/artifact-core/src/npm-config.js` reads the user `.npmrc`, the project `.npmrc`, and `npm_config_*` variables, and returns the options that `pacote` and `npm-registry-fetch` read. On `main` at 790c44e, the credential parts are these:

| Code (`npm-config.js` on `main`)                                                                                   | What it does with credentials                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AUTH_KEY` (line 16)                                                                                               | Matches `//host/:_authToken`, `_auth`, `username`, `_password`, `certfile`, and `keyfile`, so the loop keeps them alongside the registry keys.                        |
| `CERTIFICATE_KEY` (line 18) and the project-layer check (lines 170 to 175)                                         | Ignores `certfile` and `keyfile` in a project `.npmrc` with a warning, because they name paths on the machine.                                                        |
| The project-layer filter (line 163) and the expanded-key filter (line 198)                                         | Let a credential key through from every layer, so `${VAR}` expansion (lines 197 to 209) applies to credential keys and values from the user file and the environment. |
| The plain-http warning (lines 228 to 239)                                                                          | Warns that credentials configured for an http registry's host travel in plain text.                                                                                   |
| The `https` rule for a project registry (lines 255 to 260) and the URL user-information message (lines 261 to 266) | Justify themselves by credentials: a project file must not send the user's token without TLS, and the message tells the person to use the `//host/:` keys instead.    |

Comments that describe credentials as part of the loader's job sit at lines 10, 114 to 116, 202 and 203, and 256 of `npm-config.js`. `packages/artifact-core/src/registry.js` spreads `npm.options` into every `pacote.manifest` and `pacote.extract` call: `resolveArtifactPackage` (line 32), `resolvePackageDistTag` (line 79), and `extractArtifactPackage` (line 99). Its comments at lines 15, 66, and 154 describe the options as "registry and auth settings", the dist-tag lookup as made "with its credentials", and the diagnostics as making "a missing token" visible.

`npm-registry-fetch` 20.0.1, the version pacote 22.0.1 installs here, takes credentials from the options it is given and reads no environment variable for them. `getAuth` in `lib/auth.js` looks up `${regKey}:_authToken`, `:_auth`, `:username` with `:_password`, and `:certfile` with `:keyfile` for the request's host and path, and reads the files that `certfile` and `keyfile` name. It also honors a `forceAuth` option, and `lib/index.js` accepts top-level `cert` and `key` options. `lib/index.js` turns a token into `authorization: Bearer` and `_auth` into `authorization: Basic`. The loader passes none of `forceAuth`, `cert`, or `key` today. So when the loader's options hold only registry and proxy keys, `npm-registry-fetch` attaches no credential that the person configured.

Two routes stay outside the loader. First, a URL's own user information: minipass-fetch turns `https://user:pass@host/` into an `Authorization: Basic` header (`minipass-fetch/lib/request.js`), whether the URL is a configured registry or a tarball URL that a registry's package document names. Second, a token in a URL's path or query, such as a path-token registry URL, travels as part of the URL. Open questions 1 and 2 cover the configured registry URL. A tarball URL comes from the registry, not from the person's configuration, so it is not one of the person's secrets.

### The CLI

`updateCheckFailure` in `packages/cli/src/artifact-lifecycle.js` (lines 840 to 897) builds the reason and remedy of a failed `artifacts status --check-updates` lookup from the error's `code` and `statusCode`, never from its message. For HTTP 401 or 403 (lines 885 and 886) the remedy is "Check the npm credentials for this registry". `packages/cli/scripts/artifact-update-status.test.mjs` asserts that remedy at lines 562, 582, and 616.

Any other artifact command that hits a 401 or 403 stops with the error from `npm-registry-fetch`: `401 Unauthorized - GET <url> - <body.error>` (`HttpErrorGeneral`), `Unable to authenticate, need: <www-authenticate>` (`HttpErrorAuthUnknown`), or the `EOTP` and `EAUTHIP` messages. `withNpmDiagnostics` wraps that error when the loader ignored something, keeps it as `cause`, and copies `code`, `statusCode`, and `type`, but not `uri`. `runCli` prints the error with `formatErrorChain` (`packages/cli/src/index.js`, lines 7424 to 7436), which prints every cause as a `Caused by:` line, redacted, with or without `CALAVERA_DEBUG` (`packages/cli/src/utils/error-chain.js`, lines 328 to 340). None of these messages says that Calavera chose not to authenticate. The version notice (ADR-0019) prints nothing for a failed check unless `CALAVERA_DEBUG` is on.

`packages/cli/src/utils/redact.js` removes tokens, `Bearer` and `Basic` values, and URL user information from text that the CLI prints.

### The docs

`docs/architecture/versioned-artifacts.md`, section "npm registry configuration", says that resolution uses "the registry and credentials that npm would use", lists the credential keys under "What is read", and explains the `https` rule and the plain-http warning by credentials. The README says that the version check "sends the credentials that your user and project `.npmrc` files and `npm_config_*` variables name" (line 932), and that a failed update check tells the person to "check the credentials" (line 1246). ADR-0019 mentions credentials in its "Decides" line ("registry and authentication settings"), in Decision 3 ("with the same credentials"), and in its Consequences ("the configured credentials").

### What PR #1161 adds

PR #1161 is open at the time of writing (head 7878682). The owner's decision after its fourth review has it merge first and #1185 run next (https://github.com/schalkneethling/create-project-calavera/issues/1064#issuecomment-7084781247). It adds these credential parts, which this removal also deletes:

- `requestOptions` and `pacoteTarballUrl` in `npm-config.js`, the first invariant: every pacote call in `registry.js` passes its options through `requestOptions`, which drops credential keys for a non-https URL, and `pacoteTarballUrl` computes the URL pacote really fetches after its `replaceRegistryHost` rewrite.
- `credentialsLocked`, `credentialHome`, `credentialPath`, and `credentialLayer` in `loadNpmRegistryOptions`, `accountHomeFolder` and the `userInfo` import from `node:os`, the `ACCOUNT_NPMRC` label, and the `accountHome` test parameter that `loadNpmRegistryOptions`, `resolveArtifactPackage`, `resolvePackageDistTag`, and `extractArtifactPackage` accept: the second invariant, which takes credentials only from the account's `~/.npmrc` when a package manager starts Calavera.
- The warnings that name ignored credential keys, the warning for a credential key built by variable expansion, and the reworded plain-http warning ("Calavera sends no credentials to it, although some are configured").
- Under Yarn 2 or later, `.npmrc` files and `npm_config_*` variables are read only for credential keys (`npmKeys.yarn` accepts only `AUTH_KEY`). After the removal, a Yarn 2 or later start reads neither.
- In `launcher-config.js`, `credentialsNote`, which has two halves: one notes that a Bun `[install]` or `[install.scopes]` table has `token`, `username`, or `password` (line 235 looks for them), and the other notes that user information was removed from a Bun registry URL. Both tell the person to "Set them in an .npmrc file instead".
- A "Security model" subsection in `docs/architecture/versioned-artifacts.md`, credential wording in its Yarn, Bun, "Registry URLs", and "Project files" bullets and in README lines 933 to 938, credential comments in `launcher-config.js` (lines 11 and 12) and `npm-config.js` (lines 21, 164 to 166, 348 to 353, 472 and 473, 590, and 598), and a changeset (`.changeset/1064-registry-proxy-yarn-bun.md`) that announces both invariants.
- Tests for both invariants in `npm-config.test.mjs`, `launcher-config.test.mjs`, `registry.test.mjs`, and `dist-tag.test.mjs`.

If the implementation starts before #1161 merges, it works from `main`, and #1161 drops its credential parts when it rebases.

## Decision

### 1. No credential key is read, expanded, or sent

The loader keeps an allowlist of the keys that decide where a request goes: `registry`, the registry of the artifact scope (`@schalkneethling:registry`), and, after #1161, `proxy`, `https-proxy`, and `noproxy`, the Yarn registry and proxy settings, and the Bun registry settings. Calavera reads no Bun proxy setting. The loader drops every other key as it reads each layer: the user `.npmrc`, the project `.npmrc`, the file a `userconfig` names, `npm_config_*` variables (including `npm_config_//host/:_authToken`), `.yarnrc.yml`, `YARN_*` variables, and `bunfig.toml`. It never expands a credential key, never returns one, and never names one in a warning, because naming it would mean that the loader still looks for credential keys.

The implementation removes, on `main`:

- `AUTH_KEY`, `CERTIFICATE_KEY`, the project-layer certificate check, and the credential branch of both key filters in `loadNpmRegistryOptions`;
- the plain-http credential warning;
- the credential wording in the comments listed under "The loader on `main`".

If #1161 has merged, it also removes everything listed under "What PR #1161 adds", including `requestOptions` and `pacoteTarballUrl`, and amends #1161's changeset if both ship in the same release, so that the changelog does not announce rules the same release removes. `registry.js` then spreads the loader's options into pacote directly again. Of `credentialsNote`, the table half goes, because it exists only to look for Bun credential keys. The URL half depends on open question 2.

The tests replace the credential tests with the test that the issue asks for. It plants every credential key (`_authToken`, `_auth`, `username` with `_password`, `certfile` with `keyfile`) for the registry host and for a tarball host, in the user `.npmrc`, the project `.npmrc`, a `userconfig` file, `npm_config_*` variables, `.yarnrc.yml`, and `bunfig.toml`. It runs once for each launcher (npm, Yarn 2 or later, and Bun), because the loader reads a different set of files under each. Against local servers, it runs resolution and extraction and asserts that no request carries an `authorization` header, that no TLS client certificate is presented, and that no planted value appears in any warning, diagnostic, error message, error cause, or `--json` output. A second assertion checks that every key the loader returns is on the allowlist, so the test fails if any credential key, or any option such as `forceAuth`, `cert`, or `key`, comes back.

### 2. What a user of an authenticated registry sees

A registry or tarball host that answers 401 or 403 stops the command with an error that names the origin of the request that failed and says that Calavera sends no credentials. artifact-core raises it in `registry.js` from one wrapper that all three pacote calls use, inside `withNpmDiagnostics`, so the artifact commands and the version notice get the same message. For a 401 from the configured registry, it reads:

```text
The registry https://npm.example.com answered 401 for @schalkneethling/calavera-skill-frontend-security.
Calavera sends no credentials to any registry. If this registry requires authentication, Calavera cannot use it: point the setting below at a registry that serves Calavera's packages without authentication, such as https://registry.npmjs.org/.
The registry comes from @schalkneethling:registry in the project .npmrc.
```

The rules for the message:

- It names the origin (protocol, host, and port) of the URL that failed. `npm-registry-fetch` sets `uri` on every HTTP error to the final URL after redirects, and the wrapper reads it before `withNpmDiagnostics` wraps the error. When `uri` is missing, it falls back to the loader's registry origin. The message never prints the path, the query, or user information, because a URL can carry a token.
- It says "if this registry requires authentication", not that it does, because a 403 can also come from a repository firewall that blocks a package or from an expired signed tarball URL.
- It prints the third line, which names the setting and layer that chose the registry, only when the failing origin equals the configured registry origin. A tarball or CDN host that the registry redirected to was not chosen by that setting. The loader's `registry` result gains a `setting` field next to `origin` and `source`, built from the key the loader used (`registry` or `@schalkneethling:registry` on `main`, and the Yarn and Bun setting names after #1161, such as `npmScopes.schalkneethling.npmRegistryServer`). When the registry is the default, the line says so.
- The new error keeps `code` (`E401`, `E403`, `EOTP`, or `EAUTHIP`), `statusCode`, and the failing origin as fields, so a debugging run can still tell an OTP demand from an IP block, and a test proves that the three stay distinguishable. It does not keep the original `npm-registry-fetch` error as `cause`, because `formatErrorChain` prints every cause, and that error's message holds the full URL, the registry's response text, or the `www-authenticate` header. The message never repeats the registry's own text.
- `updateCheckFailure` in the CLI keeps building its own reason from these fields, and its remedy for 401 and 403 becomes "If this registry requires authentication, point the registry setting at a registry that serves Calavera's packages without authentication, then run: <retry command>". The `--json` shape of `updateCheckFailure` does not change; only the `reason` and `remedy` texts do. The tests in `artifact-update-status.test.mjs` that assert the old remedy change with it.
- The version notice still prints nothing for a failed check (ADR-0019, Decision 6). With `CALAVERA_DEBUG` on, it prints this message.

There is no flag, environment variable, or configuration key that turns credentials back on, and there is no warning period. A person who needs a private registry for their own packages keeps using their package manager for those; only Calavera's artifact and version lookups lose the credential.

### 3. What stays

The registry, the artifact-scope registry, and the proxy settings stay, with the precedence, `${VAR}` expansion rules, and project-file restrictions that `main` and #1161 define for them, except where open question 1 changes expansion in registry values. The tests for registry, scoped registry, and proxy behavior pass unchanged, except where a test asserted a credential alongside a registry, in which case only the credential assertion goes.

`redact.js` in the CLI stays, because registry and proxy error text can still carry a token that a person put into a URL, and redaction does not depend on what Calavera reads.

Three existing rules lose the reason their comments give. The rule that ignores a proxy set in a project file is owner decision 1 on #1064, which this ADR does not reopen. Its remaining reason is that a proxy chosen by a cloned repository sees which packages Calavera fetches, and for an http registry it can change the package documents and tarballs together. The implementation rewrites its comments and warning to give that reason. Open question 4 asks whether the `https` rule for a registry that a project file sets stays, and open question 2 asks what happens to a registry URL that contains a username or password.

### 4. What this supersedes

This ADR replaces the credential parts of ADR-0019: "and authentication" in its "Decides" line, "with the same credentials" in Decision 3, and "the configured credentials" in its Consequences. The version check asks the registry that the configuration names, without credentials. ADR-0019 is an accepted record and is not edited. This ADR also replaces the "auth configuration" half of #608's scope.

### 5. How C8 holds

The removal touches no write path. Only the CLI writes into projects, `dry_run_apply` stays the approval boundary, local edits are preserved, artifacts are not written to `package.json`, and conflicts still surface as a hard stop or a migration decision. The loader reads fewer keys from the same files and writes nothing. The C8 safety-property tests need no change; the implementation must not modify them.

## Consequences

A private registry or mirror that requires authentication for Calavera's packages no longer works with Calavera. The person sees the message from Decision 2. When the authenticated registry is only the artifact scope's, they change `@schalkneethling:registry`. When it is the default `registry`, as in a common corporate setup that sends everything through one authenticated server, they add this line to their user `.npmrc`, which sends only Calavera's artifact scope to the public registry:

```ini
@schalkneethling:registry=https://registry.npmjs.org/
```

The version notice cannot be fixed that way, because it looks up the unscoped `create-project-calavera` package, which the scope line does not cover. Behind an authenticated default registry, the notice therefore stops appearing, silently, as ADR-0019 Decision 6 specifies for every failed check. A mirror that serves the public registry's packages without authentication keeps working for both.

A person whose `~/.npmrc` holds a `//registry.npmjs.org/:_authToken` for publishing their own packages, and who uses the default registry, resolves Calavera's public artifacts as before, now without sending that token.

The security work of #1161 shrinks. Both credential invariants, the same-host redirect gap, the `userInfo` account-home logic, and the test-only `accountHome` parameter go, because they only protected credentials. #1161's proposed follow-up for the redirect gap is no longer needed. Its follow-ups about error causes and about a project `userconfig` that chooses the user `.npmrc` stay, because causes can still hold a proxy URL with credentials (open question 3), and that file still chooses the registry and the proxy.

#1165, which would have read Yarn and Bun credentials, was closed as not planned on 2026-11-22.

The loader still reads whole `.npmrc` files, because the registry and proxy keys live in them, so a token's text passes through memory while `ini` parses the file. Calavera keeps no credential key from the parsed result, expands none, logs none, and passes none on. The process environment also holds whatever the caller exported, such as an `NPM_TOKEN`, and Calavera does not read it. "Never holds a secret" therefore means that no Calavera code path reads, keeps, or sends a configured credential, not that no credential bytes ever enter the process.

The docs change with the implementation: the "npm registry configuration" section of `docs/architecture/versioned-artifacts.md`, including #1161's "Security model" subsection and bullets, drops the credential keys and states that Calavera sends no credentials, and the README drops the credential wording at line 932, at line 1246, and in #1161's lines 933 to 938. The changeset is a major bump for `create-project-calavera` and `@schalkneethling/calavera-artifact-core`, as ADR-0006's removal was for the CLI, because a setup that worked with an authenticated registry stops working.

Outside this removal, the review of this ADR found a possible credential route that predates it: `resolveArtifactPackage` checks only that `dist.tarball` exists before passing it to `pacote.extract`, and pacote chooses a fetcher by the spec's type, so a registry that names a `git+ssh:` or `git+https:` tarball could make pacote run git with the person's SSH agent and git credential helpers. That route is not tested. It is proposed as its own security issue, which would require `dist.tarball` to be an http or https URL.

## Open questions for the owner

1. **May a registry URL carry a token in its path, and may it come from a variable?** Some registries put a token in the URL's path, such as `registry=https://npm.example.com/${REGISTRY_TOKEN}/team/`. After this removal the loader still expands `${VAR}` in a registry value from the user `.npmrc` and the environment, and the token travels as part of the URL. Calavera cannot tell a token path segment from an ordinary one in a literal URL. **Recommendation:** stop expanding `${VAR}` in registry values, with a warning that names the setting and never the value, because a variable in a registry URL is in practice a way to inject a secret, and document a literal token in a URL as outside what Calavera can detect. The owner's decision of 2026-11-22 already tracks `${VAR}` expansion in registry and proxy values from a repository-chosen user file as a follow-up, which this answer would narrow.
2. **What happens to a registry URL that contains a username or password?** On `main`, `assertRegistryUrl` stops the command for user information in a registry URL from every layer, including the environment, and its message tells the person to use the `//host/:` keys that this ADR removes. After #1161, Yarn registry URLs are refused the same way, and a Bun registry URL is used without its user information, with a note. minipass-fetch would turn user information into basic authentication, so the URL can never be passed on as written. **Recommendation:** treat npm, Yarn, and Bun the same way, by removing the user information and using the rest of the URL, with a warning that names the setting and its layer, never the value, and says that Calavera sends no credentials. A mirror that also serves anonymous requests then keeps working, and an authenticated one fails with the Decision 2 message. The alternative is to stop the command in all three, which is stricter but breaks a working anonymous mirror because of a line the person may not control.
3. **Are credentials in a proxy URL a credential under this rule?** A proxy URL such as `https://user:pass@proxy.example.com:8080`, from `proxy` or `https-proxy` in the user `.npmrc`, a Yarn proxy setting, or the `HTTPS_PROXY` variable, makes `https-proxy-agent` and `http-proxy-agent` 9.1.0 send a `Proxy-Authorization: Basic` header to the proxy, and a `socks:` proxy URL sends its user information as SOCKS authentication. The owner's decision keeps proxy settings but says Calavera never needs a secret, and the issue scopes the removal to registry credentials. **Recommendation:** keep proxy authentication out of this removal, because it authenticates the network path rather than the registry, `@npmcli/agent` reads `HTTPS_PROXY` itself rather than through Calavera's loader, and refusing it would cut off everyone behind an authenticated corporate proxy. If the answer is that proxy credentials must go too, that becomes a separate removal issue with its own ADR, as the repository rules require for removals.
4. **Does a project `.npmrc` still have to use an `https` registry?** The rule exists so that a project file cannot send the user's token without TLS (`assertRegistryUrl`, lines 255 to 260 on `main`). Without credentials, the remaining reason is integrity: the tarball's integrity comes from the same package document as the tarball, so on an http registry anyone on the network path can replace both together, and the artifact passes verification. **Recommendation:** keep the rule, change its comment and message to give the integrity reason, and keep allowing `http` from user configuration, where the person chose it.
5. **Should Calavera say when it ignored a credential key?** A warning such as "Calavera ignored //npm.example.com/:_authToken" would explain a later 401 before it happens. It would also require the loader to look for credential keys, which the issue's acceptance criteria rule out. **Recommendation:** no warning; the 401 or 403 message from Decision 2 explains the failure when it happens.

## Alternatives considered

- **Keep credentials behind the #1161 invariants.** Rejected by the owner's rule: four review rounds each found a new route to a credential, and the redirect gap remains open. Removing the credential removes that class of bug.
- **Keep credentials behind an opt-in flag or environment variable.** Rejected: the repository rules call for complete removals with no deprecated paths, flags, or legacy modes, and an opt-in would keep all the code that protects the credential.
- **Read credentials through Varlock or a platform secret store.** Rejected: Calavera's artifacts are public, so no Calavera feature needs a secret, and adding a secret source would make Calavera hold one.
- **Fall back to the public registry after a 401 or 403.** Rejected: a silent switch would hide which registry served an artifact, and a person who configured a mirror on purpose, for example to block the public registry, would get packages from a source they did not choose.
