# Release and update journey

Calavera has independent release surfaces. A change should release only the package or application whose inputs changed.

| Surface                           | Version or deployment boundary                  | Trigger                                      |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| CLI, Baseline core, artifact core | Independent npm semver through Changesets       | Approved GitHub release                      |
| Each skill, hook, or agent        | Its own npm semver through Changesets           | Approved GitHub release                      |
| Composer                          | Static `dist-web` deployment                    | Composer or shared browser-safe input change |
| Baseline Explorer                 | Static `apps/baseline-explorer/dist` deployment | Explorer or Baseline data input change       |
| macOS companion                   | `menu-bar-v*` GitHub release                    | Menu app input change                        |

Private applications are excluded from Changesets. Public packages are neither fixed nor linked. The npm workflow packs all public workspaces for inspection but publishes only a package version confirmed absent from npm. A registry, DNS, authentication, or other lookup failure aborts publication instead of being treated as a missing version.

## Contributor release boundaries

- Add a Changeset only for each public package whose published behavior changed. Internal dependency bumps are calculated by Changesets; do not add unrelated packages merely to keep versions aligned.
- Composer, Baseline Explorer, and the menu-bar app are private applications. They do not receive Changesets.
- Deploy `dist-web` only for a Composer or shared Composer-input change. Deploy `apps/baseline-explorer/dist` only for an Explorer or Baseline browser-data change. Building both in CI is validation, not deployment.
- Create a `menu-bar-v<version>` tag only when menu-bar inputs changed. The tag must exactly match `apps/menu-bar/src-tauri/tauri.conf.json`.
- Create every feature branch after its GitHub issue and include the issue number in the branch name.

## Baseline data refresh

1. Update the pinned `web-features` and `baseline-browser-mapping` versions in `packages/baseline-core`.
2. Run the data generator and review the generated source versions, generation date, feature changes, and browser mappings.
3. Run Baseline unit and cross-surface parity tests.
4. Add a Changeset for Baseline core. Deploy the Explorer separately; do not couple its static deployment to npm publication.

The initial release remains CSS-focused. Browserslist, minimum-version, analytics, RUM, percentage-coverage, and general JavaScript compatibility inputs are deferred audience-mode work.

## Artifact authoring and package release

Each directory below `packages/artifacts` contains exactly one payload and one `calavera-artifact.json` source of truth. Update its manifest, payload, tests, and Changeset together. Validate the manifest, target support, CLI compatibility range, payload hash, tarball paths, and `publint` result before publishing.

Use Changesets prerelease mode to create a reviewed version such as `1.1.0-beta.0` for the selected artifact. The protected workflow derives the npm channel from the exact version:

- stable versions publish under `latest`;
- versions containing a prerelease suffix publish under `next`.

Install the `next` version in a fixture with `artifacts update <id> --tag next`, confirm the exact lock entry and installed bytes, then release a stable version for `latest`. Never move an ordinary project lock during `apply`; only `artifacts update` may advance it.

Before publishing, record the current versions of the CLI and at least one unrelated artifact. After the `next` publish, verify those versions and dist-tags did not move. Promote by leaving prerelease mode, creating the stable Changeset version, and publishing that version under `latest`; do not retag the prerelease as stable.

## Local edits and recovery

Calavera compares managed-state hashes before writing. If an artifact or generated file has local edits, stop and inspect the diff. Preserve the edit outside the managed destination or intentionally incorporate it into the recipe/artifact source before retrying. Do not delete `.calavera/state.json` to bypass ownership checks.

For registry failure, use an exact existing lock with its verified cache. For cache or integrity failure, reconnect to the registry and run an explicit artifact install/update; never weaken identity, integrity, compatibility, or payload verification. Run `create-project-calavera artifacts doctor` before retrying. Lock and state files are written atomically so a failed multi-artifact operation retains the prior records.

If publication partially succeeds, do not unpublish good versions. Record every published package, correct the failure, and rerun the same GitHub release: confirmed existing versions are skipped. Deprecate a bad version if consumers must avoid it, then publish a corrected patch. Roll static applications back by redeploying the last known-good output commit. Keep a failed macOS release as a draft and create a corrected version/tag rather than replacing an installed binary in place.

## macOS companion registration and release

Register project directories explicitly in the menu app. Registration, selected npm tag, polling preference, and notification history stay local. The app reads recipe, lock, and state files; it never scans for projects or runs their update commands.

A `menu-bar-v*` tag starts the protected macOS workflow. It tests the web layer, installs both Apple Rust targets, builds a universal app, signs it, submits it for notarization, staples the result, and drafts the DMG release. The `publish` environment must hold the Apple certificate, identity, Apple ID app-specific password, and team ID. Install the resulting DMG on a clean Mac before publishing the draft release.

## Rehearsal checklist

Run the offline/local portion:

```bash
pnpm release:rehearse
pnpm workflow:check
pnpm release:status
```

`release:status` compares with the Changesets `baseBranch` and therefore requires an up-to-date local `main` ref. A single-branch clone can create it without switching away from the rehearsal branch:

```bash
git fetch origin main
git branch --track main origin/main
```

If `main` already exists, update it normally instead of forcing the ref.

Then use disposable releases and projects to verify:

1. Build and deploy `dist-web` and `apps/baseline-explorer/dist` separately. Record each deployment commit and confirm neither operation creates an npm version, GitHub release, or menu-bar tag.
2. Publish one prerelease artifact to `next`; confirm other artifacts and the CLI remain unchanged.
3. Install, reapply offline from the exact verified cache, perform a targeted update, simulate an integrity failure, and confirm local edits block overwrite.
4. Publish the stable artifact under `latest` and confirm `artifacts status` remains offline unless `--check-updates` is supplied.
5. Confirm Composer, CLI, MCP, and WebMCP expose the same artifact versions and Baseline output.
6. Tag a menu app release, install the signed/notarized DMG on a clean Mac, register multiple projects, and verify notification deduplication plus copy-only behavior and the optional preferred-terminal launch.

Copy [`release-rehearsal-record.md`](release-rehearsal-record.md) for each rehearsal. The rehearsal is complete only when unchanged-package suppression, a clean targeted-update fixture, recovery behavior, and every independent deployment boundary are recorded.
