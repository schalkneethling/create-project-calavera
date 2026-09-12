# Release runbook: from a Changesets PR to a published release

[`docs/release-and-update-journey.md`](./release-and-update-journey.md) describes Calavera's release
architecture and the full rehearsal checklist. This runbook is its concrete companion: the exact
commands to run once a Changesets "Version Packages" pull request (for example
[PR #387](https://github.com/schalkneethling/create-project-calavera/pull/387)) is open and ready to
release.

## Before you start

- A local clone with `origin` pointing at this repository, and the [`gh`](https://cli.github.com/) CLI
  authenticated against it.
- [`uv`](https://docs.astral.sh/uv/getting-started/installation/) available. `pnpm workflow:check` runs
  `uvx zizmor@1.25.2 --offline`, so prime that exact version once while online before relying on the
  offline check:
  ```bash
  uvx zizmor@1.25.2 --version
  ```
  After that, `uvx zizmor` is available offline for every subsequent `workflow:check` run. You do not
  need a separate `uv sync` step: the rehearsal's SkillSpector scan runs through `uv run --frozen`,
  which synchronizes its own environment from the locked dependencies automatically.
- npm CLI 11.15.0+ if the release includes a brand-new package name (see "New packages" below).
- You do not need a local npm token. Publishing happens inside the protected `publish` GitHub
  environment through npm trusted publishing, not from your machine.

## 1. Review the version PR

Open the "Version Packages" PR and confirm before merging:

- Only public packages you intended to release have version bumps. Composer, Baseline Explorer, and
  the menu-bar app are private and must never appear (see
  [contributor release boundaries](./release-and-update-journey.md#contributor-release-boundaries)).
- Each changelog entry under a package heading matches the actual change that shipped.
- CI on the PR is green.

If a bump is wrong, do not hand-edit the generated `package.json` or `CHANGELOG.md` files in the PR.
Fix or remove the source Changeset on `main` instead and let the bot regenerate the PR.

## 2. Merge the version PR

Merge it using the repository's normal merge method. This updates versions and changelogs on `main`
but does not publish anything by itself — nothing reaches npm yet.

## 3. Sync your local `main`

```bash
git checkout main
git pull --ff-only origin main
git rev-parse HEAD
git rev-parse origin/main
```

The two `rev-parse` values must match. `release:prepare` (next step) refuses to run unless the current
branch is `main`, the worktree is clean, and the local ref equals `origin/main`.

## 4. Run the automated release gate

```bash
pnpm install --frozen-lockfile
pnpm release:prepare
```

This single command runs the full local rehearsal (`release:rehearse`), the workflow audit
(`workflow:check`), and confirms Changesets has no packages left to version. It then compares the
local workspace against the npm registry and prints a plan, for example:

```text
Release candidate: b6f8d23...
Packages absent from npm:
- create-project-calavera@2.5.0 -> latest
- @schalkneethling/calavera-artifact-core@0.4.0 -> latest
Packages already published:
- @schalkneethling/calavera-agent-technical-devils-advocate@0.2.1
```

Compare the "absent from npm" list against the merged PR body before continuing. If it names a
package that has never existed on npm, stop here and follow "New packages" below instead of step 5.

## 5. Publish

```bash
pnpm release:publish
```

This reruns the gates from step 4, then creates (or reuses) a draft GitHub release targeting the exact
merged commit and pauses for a single manual checkpoint:

```text
Verified draft: https://github.com/schalkneethling/create-project-calavera/releases/tag/v2.5.0
Type "publish v2.5.0" to continue:
```

Typing the exact phrase is the one human approval in the whole flow. After that, the script:

1. flips the draft release to published, setting the prerelease flag from the version channel;
2. waits for the resulting `.github/workflows/publish.yml` run (triggered by `release: published`) and
   watches it to completion;
3. verifies npm provenance and the correct dist-tag for every package in the plan. Each `npm view`
   lookup here retries a bounded number of times on an explicit "not found yet" response — npm's own
   publish output warns a fresh version "may take a few minutes to become available" — before failing;
   any other registry error still fails immediately;
4. smoke-tests the published CLI with `npx create-project-calavera@<version> --help`, and, when an
   artifact package changed, installs it into a disposable fixture project.

Use `--yes` only once you have already reviewed the draft yourself and want to skip the interactive
prompt (for example, scripted re-runs after a transient failure):

```bash
pnpm release:publish -- --yes
```

## 6. Confirm

`release:publish` exits non-zero if any check in step 5 fails — treat a non-zero exit as "not
released" even if some packages already reached npm. To double-check independently, look up every
public workspace, not just the CLI: the same public/private split used in step 4's plan is available
from pnpm directly.

```bash
pnpm list -r --depth -1 --json |
  node -e '
    let body = "";
    process.stdin.on("data", (chunk) => (body += chunk));
    process.stdin.on("end", () => {
      for (const pkg of JSON.parse(body)) {
        if (pkg.private === false) console.log(pkg.name);
      }
    });
  ' |
  while read -r name; do
    echo "== $name =="
    npm view "$name" dist-tags --json
  done
```

Compare each package's dist-tags against the channel the step 4 plan printed for it (`-> latest` or
`-> next`):

- for a stable (`latest`) release, `latest` should resolve to the new version;
- for a `next` prerelease, `next` should resolve to the new version while `latest` stays on whatever it
  pointed to before.

Unrelated packages and channels should be unchanged either way.

## New packages (bootstrap)

If step 4 stops because the version PR introduces a package name that has never been published, rerun
with `--bootstrap`:

```bash
pnpm release:prepare -- --bootstrap
```

This uses the pinned Fledgling dependency to claim the new package name(s), configure npm trusted
publishing for them, publish the real first stable version through the same OIDC workflow, remove the
temporary bootstrap tag, and then restart the gates automatically. It refuses to run alongside any
other package that is also unpublished, so bootstrap new names on their own before mixing them into an
ordinary release. Once bootstrap finishes, continue with step 5 as normal.

## If something fails

Do not re-run only the failed step. `release:prepare` and `release:publish` re-validate the candidate
commit every time they run, and treat any package already confirmed on npm as released, so retries are
idempotent — rerun the same command from the top rather than skipping ahead. For partial failures,
recovery, and the reasoning behind each gate, see
[`docs/release-and-update-journey.md`](./release-and-update-journey.md#local-edits-and-recovery) and
the more detailed
[`release-gates.md`](../packages/artifacts/skill-release-with-confidence/payload/release-with-confidence/references/release-gates.md)
reference.

## Prereleases (`next`)

To ship a `next` prerelease instead of a stable release, enter Changesets prerelease mode before
merging the version PR:

```bash
pnpm changeset pre enter next
pnpm release:version
```

Then follow steps 2 through 6 above unchanged; the orchestrator derives the `next` npm channel from
the prerelease version string automatically. Exit prerelease mode once the candidate is verified and
you are ready to promote to stable:

```bash
pnpm changeset pre exit
pnpm release:version
```

See
[Artifact authoring and package release](./release-and-update-journey.md#artifact-authoring-and-package-release)
for the full prerelease-to-stable promotion flow used for individual artifacts.
