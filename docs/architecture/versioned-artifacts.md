# Versioned artifact contracts

Calavera skills, hooks, and agents are independently versioned npm packages. A package contains one artifact payload plus a `calavera-artifact.json` manifest conforming to [`schemas/calavera-artifact.schema.json`](../../schemas/calavera-artifact.schema.json).

## Package identity

First-party packages use these names:

- `@schalkneethling/calavera-skill-<name>`
- `@schalkneethling/calavera-hook-<name>`
- `@schalkneethling/calavera-agent-<name>`

Artifact IDs retain their existing `skill-`, `hook-`, or `agent-` prefix. IDs are stable recipe and catalog identifiers; npm package names are distribution identifiers. The catalog maps IDs and legacy `src/ai` paths to package names.

Each manifest declares:

- schema version and stable artifact ID;
- artifact type and display name;
- package-relative payload path;
- supported target names when target adaptation is meaningful;
- the compatible `create-project-calavera` semver range.

The manifest never names an installed project destination. Destination selection belongs to the recipe and target adapter.

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
- Resolution rejects a manifest whose Calavera compatibility range excludes the running CLI.
- Integrity, identity, manifest, and payload checks complete before any project files or lock entries change.
- Lock and state writes are atomic. A failed multi-artifact operation leaves the previous project records intact.
- Existing local-edit protection applies to every package-backed installation.

Legacy `{ "type", "src", "target" }` recipe entries remain readable for one major-version compatibility window. Migration uses the catalog mapping to produce stable `{ "id", "target" }` entries before resolving an exact lock.

Issue #160 remains historical input for vendor-neutral naming and content decisions. Package extraction must not reintroduce vendor-specific names that the completed consolidation removed.
