# Versioned artifact contracts

Calavera skills, hooks, and agents are independently versioned npm packages. A package contains one artifact payload plus a `calavera-artifact.json` manifest conforming to [`schemas/calavera-artifact.schema.json`](../../schemas/calavera-artifact.schema.json).

## Package identity

First-party packages use these names:

- `@schalkneethling/calavera-skill-<name>`
- `@schalkneethling/calavera-hook-<name>`
- `@schalkneethling/calavera-agent-<name>`

Artifact IDs retain their existing `skill-`, `hook-`, or `agent-` prefix. IDs are stable recipe and catalog identifiers; npm package names are distribution identifiers. The catalog maps IDs and legacy `src/ai` paths to package names.

## Dependency isolation

The artifact catalog contains only identity, routing, target, and compatibility metadata. Neither `create-project-calavera` nor `@schalkneethling/calavera-artifact-core` declares independently versioned artifact packages as runtime dependencies. They therefore do not appear transitively in a consumer's `package.json`, dependency lockfile, or `node_modules` through a Calavera CLI installation.

Artifact packages enter the project only through the explicit artifact lifecycle and are extracted into `.calavera`. Install and update may resolve from npm; ordinary apply only reuses or restores an exact locked version offline.

Each manifest declares:

- schema version and stable artifact ID;
- artifact type and display name;
- package-relative payload path;
- supported target names when target adaptation is meaningful;
- the compatible `create-project-calavera` semver range.

The manifest never names an installed project destination. Destination selection belongs to the recipe and target adapter.

## npm registry configuration

Artifact resolution and extraction use the registry and credentials that npm would use for the artifact's package scope. Calavera reads them itself because pacote does not read `.npmrc` files.

- **What is read.** `registry`, the `@scope:registry` of the artifact scope, and the `//host/:_authToken`, `_auth`, `username`, `_password`, `certfile`, and `keyfile` keys. The `certfile` and `keyfile` keys are read from the user `.npmrc` only; a project `.npmrc` entry for them is ignored with a warning. A registry for any other scope is not read, so a broken one cannot stop an unrelated install. A blank registry for the artifact scope is skipped with a warning.
- **Where it is read from.** The user `.npmrc`, then the project `.npmrc`, then `npm_config_*` environment variables; later sources win. The user `.npmrc` is `~/.npmrc` or the file named by `npm_config_userconfig`, which may use `~` and `${VAR}`. A `userconfig` key in a project `.npmrc` is ignored. The project `.npmrc` is the one in the current directory only; parent directories are not searched. Global and built-in npm configuration files and command-line flags are not read.
- **Variables.** `${VAR}` is expanded in the keys and values of the user `.npmrc` and of `npm_config_*` variables. It is never expanded in a project `.npmrc`, which is repository content and must not read the caller's environment. A project entry that contains `${...}` is ignored with a warning that names the key, never a value. Keys in warnings have control characters removed and are shortened, because the project file controls them. An entry that references an unset variable is ignored. When npm starts Calavera (`npx`, `npm exec`, `npm run`), npm exports its resolved settings as `npm_config_*` variables, with project `.npmrc` values already expanded. Calavera recognizes this by the `npm_command`, `npm_lifecycle_event`, or `npm_config_local_prefix` variable. It then compares each such variable with the same key in the project and user files: a value equal to the project file's value after expansion is project content, not environment. It is ignored when the project entry contains `${...}`, and otherwise labeled as coming from the project `.npmrc`. A value that differs was set by the caller and is trusted as environment. Registry failures name the ignored keys and unset variables, because an MCP client often passes a minimal environment.
- **Registry URLs.** A `registry` or `@scope:registry` value must be an `http` or `https` URL without a username or password, in the user `.npmrc`, the project `.npmrc`, and the environment alike. A project `.npmrc` must use `https`, because npm sends the credentials of a host whatever the protocol, and a project file must not be able to send your token without TLS. To use an `http` registry, set it in your user `.npmrc`. Any `http` registry that has credentials configured for its host produces a warning that they are sent in plain text. Credentials belong in the `//host/:` keys, which npm sends only to the matching host.
- **What is shown.** The dry run of `apply`, `artifacts install`, and `artifacts update` reports the registry that artifacts resolve from, with its protocol, host, and port (`https://registry.npmjs.org`), and says when it comes from the project `.npmrc`. The `dry_run_apply` MCP tool returns the same fields (`artifactRegistries` and `artifactWarnings`).
- **Not read.** `proxy`, `https-proxy`, `noproxy`, `cafile`, `ca`, and `strict-ssl` from an `.npmrc` are not loaded. The `HTTPS_PROXY`, `HTTP_PROXY`, and `NO_PROXY` variables of the Calavera process, and `NODE_EXTRA_CA_CERTS`, do apply.
- **Secrets.** Credentials never appear in logs, warnings, or error messages.

A project `.npmrc` can choose the registry that artifacts resolve from. Extraction verifies each tarball against the integrity that registry reported for the resolution. Re-checking that integrity against the lock when an artifact is restored is not part of this behavior.

## Project records

The three project records deliberately answer different questions:

| File                            | Question answered                                          | Update authority                            |
| ------------------------------- | ---------------------------------------------------------- | ------------------------------------------- |
| `calavera.config.json`          | Which artifacts and targets does the project want?         | User, Composer, or approved CLI composition |
| `.calavera/artifacts.lock.json` | Which exact packages and payloads were resolved?           | Artifact install or update command          |
| `.calavera/state.json`          | Which files were installed, and have they changed locally? | Existing managed-file application flow      |

The lockfile conforms to [`schemas/artifacts-lock.schema.json`](../../schemas/artifacts-lock.schema.json). It is deterministic and checked in. It records exact versions, registry resolution and integrity, the selected npm tag, manifest schema version, install destination, and payload hash. It contains no generated timestamp.

The state file remains the authority for installed hashes and overwrite protection. A lockfile payload hash verifies resolved package content; it does not prove that the installed copy is still unedited.

## Compatibility and updates

- Ordinary `apply` and top-level `update` install exact locked versions.
- Only the explicit artifact update workflow advances versions.
- `latest` is the default channel; `next` requires explicit selection.
- Resolution rejects a manifest whose Calavera compatibility range excludes the running CLI. The range is a lower bound only: it names the first CLI that can install the artifact, and the hosted Composer uses the same range to withhold an artifact until that CLI is published. It carries no upper bound, because a CLI major does not change the manifest contract; a change to that contract bumps `schemaVersion`. `packages/artifact-core/test/compatibility.test.mjs` fails when any range is invalid or excludes the workspace CLI version. `packages/cli/scripts/release-integration.test.mjs`, run by `release:fixture`, packs every workspace artifact and installs it through the real `artifacts install` path and `extractArtifactPackage` with the workspace CLI version, one artifact per fixture and all artifacts together.
- Integrity, identity, manifest, and payload checks complete before any project files or lock entries change.
- Lock and state writes are atomic. A failed multi-artifact operation leaves the previous project records intact.
- Existing local-edit protection applies to every package-backed installation.

Legacy `{ "type", "src", "target" }` recipe entries remain readable for one major-version compatibility window. Migration uses the catalog mapping to produce stable `{ "id", "target" }` entries before resolving an exact lock.

Issue #160 remains historical input for vendor-neutral naming and content decisions. Package extraction must not reintroduce vendor-specific names that the completed consolidation removed.
