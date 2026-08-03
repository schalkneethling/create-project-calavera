---
name: npm-trusted-publishing-github-workflow
description: >
  Generate, repair, or debug the GitHub Actions workflow FILE that performs an OIDC
  trusted publish of a pnpm package — the concrete publish.yml, its test → build →
  publish job shape, the package tarball artifact handoff, Node-version inference from
  package.json, version-aware pnpm and runtime setup, the npm-CLI-version upgrade step, and
  repository.url/Sigstore provenance matching. Use when the user wants the actual
  workflow written or fixed, or is debugging a specific CI failure: npm publish
  E404/E403/422, NODE_AUTH_TOKEN appearing unexpectedly, provenance or id-token errors,
  pnpm/setup version resolution, or runtime version problems.
  For the broader publishing SECURITY POSTURE — account 2FA, repository and branch
  hardening, GitHub environments, changesets versus changelogithub, sole-maintainer risk,
  or auditing an existing pipeline — use the npm-package-publishing skill instead.
---

# NPM Trusted Publish

## Goal

Implement the same hardened npm trusted publishing pattern every time, without rediscovering the details from CI logs.

## Related skills

This skill generates and debugs the publish workflow file. For the surrounding security posture — account and repository 2FA, branch protection, GitHub publish environments, release-strategy choice, and sole-maintainer risk — use the `npm-package-publishing` skill. The two are complementary: `npm-package-publishing` decides how publishing should be set up, this skill writes and fixes the YAML that does it.

One number to keep consistent between the two: both skills use Node 24.8.0 or higher as the publish-step floor. Node 24.8.0 bundles npm 11.6.0, which already exceeds the npm CLI 11.5.1 minimum that trusted publishing requires, so on that floor no manual npm upgrade is needed. If a project must publish on an older supported Node, reject anything below Node 22.14.0 and upgrade npm only on Node 22.14.0 through 24.7.x.

## Workflow

1. Inspect `package.json`, `.npmrc`, lockfiles, and existing `.github/workflows/*.yml`.
2. Resolve every workflow dependency to its latest stable version at the moment the file is created, and pin each to the full-length commit SHA of that version. Never leave third-party or GitHub-owned actions pinned to tag-based refs such as `@v4`, `@v6`, or `@v7` in the final workflow; tag refs weaken supply-chain integrity and violate pinned-action policy. The SHAs in this skill's template are placeholders that will be out of date; never copy them verbatim. See "Pinning actions to current SHAs" below for the procedure.
3. Preserve pinned action SHAs when they already exist; annotate each with a version comment so Dependabot can bump it.
4. Resolve the pnpm major from the exact `packageManager` value before selecting setup actions. For pnpm 11 or newer, use `pnpm/setup`. For pnpm 10 or older, use `pnpm/action-setup` together with `actions/setup-node`; `pnpm/setup` cannot install those versions. Do not guess or float the pnpm major.
5. Drive the test and build jobs' Node version from the project's **existing** target, not from a number invented for this workflow. Read it from `devEngines.runtime`, `.nvmrc`, `.node-version`, `volta.node`, or existing CI; if none exists, ask rather than guessing. With pnpm 11 or newer, let `pnpm/setup` read `devEngines.runtime` or pass the resolved target as `runtime`. With pnpm 10 or older, pass the same target to `actions/setup-node`. Never use `engines.node`, which is the consumer compatibility range, as the CI runtime selector.
6. Never raise the project's Node version, create a new `.nvmrc`, or overwrite an existing one to "match" the publish step. The publish step's Node 24.8.0 is isolated and must not propagate to development, test, or build targets.
7. Ensure every job that reads the repo runs `actions/checkout` first.
8. Disable automatic installation in the selected pnpm setup action, then run `pnpm install --frozen-lockfile --ignore-scripts` explicitly so release install flags stay visible and hardened.
9. Do not use Corepack in release workflows: it is still marked experimental and downloads the package manager from the network on first use, which is an avoidable failure surface in a release pipeline.
10. Set `persist-credentials: false` on every `actions/checkout` step. Never rely on checkout's default credential persistence. If a workflow genuinely must push to git, use an explicit, narrowly scoped credential only for that push step.
11. Target Node 24.8.0 or higher in the publish step. If a lower version is unavoidable, reject Node below 22.14.0 before any npm upgrade, upgrade npm only on Node 22.14.0 through 24.7.x, and require npm 11.5.1 or newer.
12. Pack into a unique directory under `RUNNER_TEMP`, keyed by the workflow run and attempt.
13. In the publish job, download the artifact to the corresponding `RUNNER_TEMP` directory, find the `.tgz`, and publish its resolved path.
14. Use GitHub OIDC trusted publishing, not npm tokens. Provenance is generated automatically under trusted publishing, so the `--provenance` flag is not required.
15. Add a `concurrency` group keyed on the release so two tag pushes cannot race into overlapping publishes.

## GitHub Token Permissions

Every GitHub Actions workflow this skill creates or edits must declare explicit least-privilege
`GITHUB_TOKEN` permissions. Add a top-level `permissions:` block that grants the workflow-wide
minimum, usually `contents: read`, then add job-level `permissions:` only where a job needs more.

For trusted npm publishing, only the publish job should receive `id-token: write`; test and build
jobs should stay at `contents: read`. If a project genuinely needs another scope, grant it only to
the specific job that requires it and document why in the workflow review notes. Never rely on
GitHub's repository default token permissions.

Every `actions/checkout` step must include `persist-credentials: false`, including jobs that build
or upload artifacts. Persisted checkout credentials unnecessarily leave `GITHUB_TOKEN` available to
later build, test, packaging, and artifact steps.

## Package Metadata

Three different Node versions live in three different places, and keeping them separate is deliberate — conflating them is the main way this workflow goes wrong. `engines.node` in `package.json` is the _consumer_ floor: the only one that constrains people who install the package, and it should reflect what the package actually supports (npm warns, but does not hard-fail, when a consumer is outside it). The test and build jobs run on the project's _own_ target version, read from `devEngines.runtime` or the existing `.nvmrc`/`.node-version`/`volta.node`/CI config; these are development and CI targets, so they do not leak into the consumer contract. The publish step pins Node 24.8.0 or higher independently, purely because that floor bundles an npm new enough for OIDC. These three are not meant to agree: a repo can develop and test on Node 22, keep `engines.node` at its true support range, and still publish on Node 24 — all without affecting consumers, and without changing what the project builds and tests against.

The publish-step version must never be copied into the other two. Do not raise `engines.node` to 24.8.0, and do not set or bump `.nvmrc` or `devEngines.runtime` to 24, to "make things consistent". Doing so would move the test and build jobs onto Node 24, so the package would be validated against a version above its actual target and a Node-22 incompatibility could ship uncaught. The publish job runs `npm publish` on the already-built tarball with scripts ignored, so its Node version never rebuilds or retests the code; it plays no role in building the artifact.

```json
{
  "engines": {
    "node": ">=20"
  },
  "packageManager": "pnpm@11.0.4",
  "devEngines": {
    "runtime": { "name": "node", "version": "^22.0.0", "onFail": "download" }
  },
  "repository": {
    "type": "git",
    "url": "git+https://github.com/OWNER/REPO.git"
  }
}
```

The `engines.node` value above is the _consumer_ floor and should reflect what the package actually supports; `>=20` is only an example, and a bounded upper limit is sensible if the package genuinely needs one. Do not raise it to 24.8.0 to satisfy CI — the publish step pins its own Node version, and the test and build jobs read theirs from `devEngines.runtime` or another existing project target, so the trusted-publishing requirement never leaks into the consumer contract.

For pnpm 11-or-newer projects, prefer declaring the development runtime in `devEngines.runtime` so
`pnpm/setup` can read it from `package.json`. If the repo already uses `.nvmrc`, `.node-version`,
`volta.node`, or existing CI instead, keep that source of truth and set `pnpm/setup`'s `runtime`
input to the same resolved version. For pnpm 10 or older, pass that target to `actions/setup-node`.
Do not default test or build jobs to the publish step's 24.8.0.

The `repository.url` field is not cosmetic. Provenance verification runs through Sigstore, which compares the repository in the OIDC token against `package.json`. A mismatch fails the publish with a 422 error that the user-facing npm docs do not explain. Make sure the owner/name in `repository.url` matches the repository actually running the workflow.

Trusted publishing itself must not receive `NODE_AUTH_TOKEN`. A project that installs private dependencies may expose a read-only token only on the dependency-install step. Keep registry mapping and the environment reference in the checked-in `.npmrc`, never a token value. Do not persist the token through setup, build, pack, or publish steps. Run `npm publish` from an isolated directory under `RUNNER_TEMP` so npm does not discover the repository's private-install `.npmrc`.

```ini
@OWNER:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

```yaml
- name: Install dependencies
  env:
    NODE_AUTH_TOKEN: ${{ secrets.READ_ONLY_PACKAGES_TOKEN }}
  run: pnpm install --frozen-lockfile --ignore-scripts
```

## Workflow Template

Use this shape for pnpm 11-or-newer packages, adapting names, test commands, and pinned action SHAs. Verify the exact pnpm major from `packageManager` first. For pnpm 10 or older, replace every test/build `pnpm/setup` step with pinned `pnpm/action-setup` (`run_install: false`) plus pinned `actions/setup-node` using the resolved project Node target. In the publish job, use pinned `actions/setup-node` with Node 24.8.0 or newer; pnpm is not needed after the tarball is downloaded.

The `@<sha>` values below are **placeholders**: resolve each action to its latest stable release and replace the placeholder with that release's full-length commit SHA, keeping the version comment accurate. Do not copy the example SHAs.

For pnpm 10 or older, use this concrete setup shape in both test and build jobs:

```yaml
- name: Setup pnpm
  uses: pnpm/action-setup@2222222222222222222222222222222222222222 # PLACEHOLDER SHA, re-resolve before use
  with:
    version: 10 # Replace with the exact project major or version.
    run_install: false

- name: Setup Node.js
  uses: actions/setup-node@3333333333333333333333333333333333333333 # PLACEHOLDER SHA, re-resolve before use
  with:
    node-version: "22" # Replace with the resolved existing project target.
```

In the pnpm-10 publish job, only Node is required:

```yaml
- name: Setup Node.js for publish
  uses: actions/setup-node@3333333333333333333333333333333333333333 # PLACEHOLDER SHA, re-resolve before use
  with:
    node-version: "24.8.0"
```

```yaml
# NOTE: every action SHA below is a PLACEHOLDER and is almost certainly out of date.
# Re-resolve each action to its latest stable release and pin to that SHA before use.
# See "Pinning actions to current SHAs".
name: Publish

on:
  release:
    types: [published]

permissions:
  contents: read

concurrency:
  group: publish-${{ github.event.release.tag_name }}
  cancel-in-progress: false

jobs:
  test:
    name: Test
    runs-on: ubuntu-latest
    timeout-minutes: 60
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2 — PLACEHOLDER SHA, re-resolve before use
        with:
          persist-credentials: false

      - name: Setup pnpm and Node.js
        uses: pnpm/setup@1111111111111111111111111111111111111111 # v1.0.0 — PLACEHOLDER SHA, re-resolve before use
        with:
          # Runtime is read from devEngines.runtime when present. If the project uses
          # .nvmrc/.node-version/volta instead, set runtime to that exact target
          # (for example, runtime: node@22). Do not use engines.node here.
          install: false

      - name: Install dependencies
        run: pnpm install --frozen-lockfile --ignore-scripts

      - name: Check package
        run: pnpm run package:check

      - name: Run tests
        run: pnpm test

  build:
    name: Pack package
    needs: test
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2 — PLACEHOLDER SHA, re-resolve before use
        with:
          persist-credentials: false

      - name: Setup pnpm and Node.js
        uses: pnpm/setup@1111111111111111111111111111111111111111 # v1.0.0 — PLACEHOLDER SHA, re-resolve before use
        with:
          # Runtime is read from devEngines.runtime when present. If the project uses
          # .nvmrc/.node-version/volta instead, set runtime to that exact target
          # (for example, runtime: node@22). Do not use engines.node here.
          install: false

      - name: Install dependencies
        run: pnpm install --frozen-lockfile --ignore-scripts

      - name: Create package directory
        run: |
          package_dir="${RUNNER_TEMP}/npm-package-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
          mkdir -p "$package_dir"
          echo "PACKAGE_DIR=$package_dir" >> "$GITHUB_ENV"

      - name: Create package tarball
        run: pnpm pack --pack-destination "$PACKAGE_DIR"

      - name: Upload package tarball
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1 — PLACEHOLDER SHA, re-resolve before use
        with:
          name: npm-package
          path: ${{ runner.temp }}/npm-package-${{ github.run_id }}-${{ github.run_attempt }}/*.tgz
          if-no-files-found: error
          retention-days: 7

  publish:
    name: Publish to npm
    needs: build
    runs-on: ubuntu-latest
    timeout-minutes: 10
    environment: publish
    permissions:
      contents: read
      id-token: write
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2 — PLACEHOLDER SHA, re-resolve before use
        with:
          persist-credentials: false

      - name: Setup pnpm and Node.js
        uses: pnpm/setup@1111111111111111111111111111111111111111 # v1.0.0 — PLACEHOLDER SHA, re-resolve before use
        with:
          # Pinned for the publish step only. 24.8.0 bundles npm 11.6.0, new enough
          # for OIDC; this is independent of engines.node, the consumer floor.
          runtime: node@24.8.0
          install: false

      - name: Ensure npm is new enough for trusted publishing
        run: |
          minimum_node="22.14.0"
          no_upgrade_node="24.8.0"
          required_npm="11.5.1"
          pinned_npm="11.6.0"
          version_at_least() {
            node - "$1" "$2" <<'NODE'
          const [current, required] = process.argv.slice(2).map((version) =>
            version.split(".").map((part) => Number.parseInt(part, 10)),
          );
          for (let index = 0; index < 3; index += 1) {
            if (current[index] !== required[index]) {
              process.exit(current[index] > required[index] ? 0 : 1);
            }
          }
          NODE
          }

          node_version="$(node --version | sed 's/^v//')"
          current_npm="$(npm --version)"
          if ! version_at_least "$node_version" "$minimum_node"; then
            echo "Trusted publishing requires Node $minimum_node or newer; found $node_version." >&2
            exit 1
          fi

          if version_at_least "$current_npm" "$required_npm"; then
            echo "npm $current_npm satisfies $required_npm."
          elif version_at_least "$node_version" "$no_upgrade_node"; then
            echo "Node $node_version unexpectedly provides npm $current_npm; refusing a global npm mutation." >&2
            exit 1
          else
            echo "npm $current_npm is below $required_npm; upgrading to pinned npm $pinned_npm."
            npm install -g "npm@$pinned_npm"
          fi
          version_at_least "$(npm --version)" "$required_npm"

      - name: Download package tarball
        uses: actions/download-artifact@cc203385981b70ca67e1cc392babf9cc229d5806 # v4.1.9 — PLACEHOLDER SHA, re-resolve before use
        with:
          name: npm-package
          path: ${{ runner.temp }}/npm-package-${{ github.run_id }}-${{ github.run_attempt }}

      - name: Publish to npm
        run: |
          package_dir="${RUNNER_TEMP}/npm-package-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
          tarball="$(find "$package_dir" -type f -name '*.tgz' -print -quit)"

          if [ -z "$tarball" ]; then
            echo "No package tarball found in downloaded artifact."
            find "$package_dir" -maxdepth 3 -type f -print
            exit 1
          fi

          tarball="$(realpath "$tarball")"
          publish_dir="${RUNNER_TEMP}/npm-publish-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
          mkdir -p "$publish_dir"
          cd "$publish_dir"
          npm publish "$tarball" --ignore-scripts --registry https://registry.npmjs.org
```

Do not add `--access public` unconditionally. Prefer explicit package metadata such as `publishConfig.access` when public access is required, and preserve private or restricted package intent.

## Pinning actions to current SHAs

The template's SHAs are stale by design. Action versions and their commit SHAs change over time, so resolve them fresh whenever a `publish.yml` is created or reviewed. Pin to the full-length commit SHA, never a tag or branch, because a tag can be moved to point at malicious code after you have reviewed it. Tag-based refs such as `@v4`, `@v6`, and `@v7` are acceptable only as temporary input to a pinning tool; they must not survive in committed workflow YAML.

There are two reliable ways to produce current pins.

The preferred approach is to let tooling resolve and pin for you. Write the workflow first using human-readable tags only in the temporary draft consumed by the tool, then run `npx actions-up@1.16.0 --yes` so the command is non-interactive. Confirm each line carries a `@<40-hex-sha> # vX.Y.Z` form.

If resolving manually, for each action find the latest stable release tag, then read the exact commit that tag points to and pin that commit:

```bash
# Latest stable release tag for an action (skips pre-releases)
gh release view --repo actions/checkout --json tagName --jq .tagName

# The commit SHA that the tag resolves to — pin THIS value
gh api repos/actions/checkout/git/refs/tags/v4.2.2 --jq .object.sha
```

For an annotated tag the first lookup may return a tag object rather than a commit; dereference it with `gh api repos/<owner>/<repo>/git/tags/<sha> --jq .object.sha` to reach the underlying commit. Pin the commit SHA, not the tag SHA.

Keep the pins current after creation by letting Dependabot manage action updates. This is why every `uses:` line carries a `# vX.Y.Z` comment: Dependabot reads the comment to know which version a SHA represents and to raise update PRs. The companion Dependabot configuration should include a `github-actions` ecosystem entry pointing at `/` so the publish workflow is covered. Periodically re-running `npx actions-up@1.16.0 --yes` is a reasonable backstop if Dependabot is not enabled.

## Checks

After edits:

```bash
ruby -e 'require "yaml"; YAML.load_file(".github/workflows/publish.yml"); puts "YAML ok"'
```

If the project uses pnpm, validate packing without publishing:

```bash
pack_dir="$(mktemp -d)"
pnpm pack --pack-destination "$pack_dir"
```

Confirm no placeholder markers survived into the generated file, and that every action is pinned to a 40-character SHA rather than a tag:

```bash
# Must print nothing and fail if a marker remains
if grep -n "PLACEHOLDER" .github/workflows/publish.yml; then
  echo "Placeholder marker found" >&2
  exit 1
fi

# Parse the actual YAML uses values so comments and unrelated text cannot satisfy the check.
ruby <<'RUBY'
require "yaml"

uses = []
walk = lambda do |value|
  case value
  when Hash
    value.each do |key, child|
      uses << child.to_s if key.to_s == "uses"
      walk.call(child)
    end
  when Array
    value.each { |child| walk.call(child) }
  end
end
walk.call(YAML.load_file(".github/workflows/publish.yml"))

abort "No uses entries found" if uses.empty?
bad_refs = uses.reject do |ref|
  sha = ref[/@([0-9a-f]{40})\z/i, 1]
  sha && !sha.match?(/\A(.)\1{39}\z/)
end
unless bad_refs.empty?
  warn bad_refs.join("\n")
  abort "Unpinned or placeholder action found"
end
puts "All actions SHA-pinned"
RUBY
```

## Failure Clues

- `NODE_AUTH_TOKEN: ***` appears in the publish log: token auth is being used or injected into the publish step. A read-only token is acceptable only on a private-dependency install step and must be absent afterward.
- `E404 Not Found - PUT ... could not be found or you do not have permission`: often an auth/scope permission problem, especially if local manual publish works.
- `422 Unprocessable Entity` during publish with provenance: the repository in the OIDC token does not match `package.json`. Check `repository.url` first.
- npm silently publishing with a token despite trusted-publisher config: the runner's npm CLI is older than 11.5.1. This should not happen on the pinned Node 24.8.0 (which bundles npm 11.6.0); if the publish step was moved to an older Node, confirm the guard step actually upgraded npm and reported a version at or above 11.5.1.
- Tests or build now run on a newer Node than the project targets (for example Node 24 when the project is on 22): `.nvmrc` was created or bumped to match the publish step. Reset it to the project's actual target; the publish step's 24.8.0 must stay confined to the publish job.
- `package.json does not exist` from `pnpm/setup`: the job runs setup before checkout, or `package-json-file` points at the wrong path.
- `pnpm/setup` cannot resolve a pnpm version: the `packageManager` field is missing. Add the correct `packageManager` field or set the action's `version` input explicitly as a fallback.
- `pnpm/setup` installs the wrong runtime: `devEngines.runtime` is missing or does not match the project's existing CI target. Add or correct `devEngines.runtime`, or set the action's `runtime` input explicitly.
- Publishing an already-published version will fail even after the workflow is fixed.

## External Setup Reminder

Repo changes cannot create npm's trusted publisher entry. Remind the user to verify npm package settings:

- provider: GitHub Actions
- repository owner/name matches the repo
- workflow filename matches `publish.yml` (filename only, including the extension)
- publish environment matches the workflow if npm is configured with one
- at least one allowed action is selected: configurations created after 20 May 2026 require explicitly selecting an allowed action (for example, allow `npm publish`), or the publish will be rejected

The first version of a brand-new package cannot be published via OIDC, because npm requires the package to exist before its trusted-publisher settings can be edited. Publish the initial version manually or with a token, then configure trusted publishing for subsequent releases.
