# Release gates and recovery

Use this reference to select checks for the project at hand. Do not copy commands without
consideration: discover the repository's package manager, version tool, registry, hosting provider,
and release scripts first.

## Gate restart rule

Treat one pass through the release gates as one evidence chain. If any command or check fails, output
is unexpected, a corrective change is made, or external state changes only partially:

1. Stop immediately.
2. Record the failure and every external mutation that already happened.
3. Recover or fix forward without weakening a gate.
4. Synchronize the repository and record the exact resulting commit and external state.
5. Restart the full applicable gate sequence from its first gate.

Do not resume at the failed command. Earlier passing results remain useful diagnostic history, but
they are not approval evidence for the recovered candidate. This rule applies even when the failure
looks transient: a clean uninterrupted pass is the release gate.

For a partial publish, preserve the versions that already exist and make the retry idempotent, but
restart the gates for the corrected candidate or workflow before publishing the missing versions.

## Contents

1. Gate restart rule
2. Release inventory
3. Branch and version gates
4. Local rehearsal
5. Artifact and registry preflight
6. Secure publication
7. Prerelease and stable promotion
8. Failure recovery
9. Evidence record
10. Calavera terminal examples

## 1. Release inventory

Record one row per independent surface:

| Surface | Public/private | Current | Candidate | Stable | Release trigger | Rollback |
| ------- | -------------- | ------- | --------- | ------ | --------------- | -------- |

Inspect at minimum:

- root and workspace manifests;
- workspace include/exclude patterns;
- private package flags;
- version groups, linked versions, ignored packages, and base branch;
- internal dependency ranges;
- static applications and deployment inputs;
- desktop/mobile versions and platform release configuration;
- build outputs and artifact upload paths;
- published schema or catalog files consumed by hosted applications.

Check for timing hazards. A hosted UI must not advertise package behavior that is not yet available to
users. Gate newly exposed features by their minimum compatible package version, or deploy only after
the matching package is published.

## 2. Branch and version gates

Before feature integration:

- update the stable branch from remote;
- create the issue before the branch when required by repository policy;
- use an issue-linked feature branch;
- keep structural moves separate from behavior changes where practical;
- use an integration branch for a large train of dependent pull requests;
- preserve contributor attribution.

Before versioning:

- confirm the worktree is clean;
- confirm the local stable branch reference is current;
- list pending release notes and affected packages;
- compare calculated versions with the release inventory;
- reject an empty success result, unrelated private packages, and synchronized bumps that were not
  intended.

Some version tools compare against a named local base branch. If the base reference is missing, fetch
or create the tracking branch normally. Do not fabricate divergence or force-move a branch to silence
the tool.

Simulate destructive version generation in a true disposable copy:

1. Create a fresh temporary directory.
2. Copy the repository while excluding `.git`, dependency directories, build output, and credentials.
3. Set the command's actual working directory to the temporary copy.
4. Invoke the project-local version binary.
5. Compare every generated file with the source tree.

Do not rely only on `cd` embedded in a long shell command. Verify the process working directory
explicitly.

## 3. Local rehearsal

Typical gate order:

1. Record `HEAD`, remote stable SHA, and worktree state.
2. Install dependencies with the frozen lockfile.
3. Run formatting, linting, type checking, tests, schema validation, and security checks.
4. Run release contract and workflow audits.
5. Build every independently released surface.
6. Run package-content validation.
7. Run targeted fixture tests for high-risk lifecycle behavior.
8. Calculate release status.
9. Pack all publishable workspaces.
10. Verify the tarball count and embedded manifests.

For a package-managed JavaScript workspace, equivalent commands might resemble:

```text
<package-manager> install --frozen-lockfile
<package-manager> run quality
<package-manager> run release:contracts
<package-manager> run workflow:check
<package-manager> run release:status
<package-manager> run publish:check
```

Use the repository's scripts rather than assuming these names.

### Consumer fixture

Create a disposable project outside the repository. Resolve the packed or published artifact by exact
version, then exercise:

- help/version output;
- dry-run output;
- first application;
- repeat application and idempotency;
- state or lockfile contents;
- safe cleanup;
- local-edit refusal;
- offline locked operation when supported;
- migration from the previous format when supported.

Record hashes only when they communicate a meaningful invariant. State files may legitimately change
once when obsolete fields are normalized, then remain stable on subsequent runs.

## 4. Artifact and registry preflight

Pack into an empty, known staging directory. Verify every archive:

- filename;
- embedded name and version;
- public/private status;
- expected entry points and exports;
- license and readme;
- repository URL and monorepo directory;
- included and excluded files;
- integrity-relevant generated content.

Count archives and compare the identities with the release inventory.

Query the registry by exact name and version. Treat only an explicit missing-version response as
permission to publish. DNS, TLS, authentication, rate-limit, server, and malformed-response errors
must fail the release.

Run registry preflight read-only. Do not move channels during inspection.

## 5. Secure publication

Prefer workload identity/OIDC trusted publishing:

- grant `id-token: write` only to the publish job;
- place the publish job behind a protected environment;
- keep test, build, and publish jobs separate;
- disable persisted checkout credentials when not required;
- pin third-party workflow actions by immutable SHA;
- publish artifacts built in the unprivileged build job;
- require package provenance;
- remove long-lived token fallbacks after any unavoidable bootstrap.

For new npm package names or trusted-publisher drift, consider the optional Fledgling workflow in
[`fledgling.md`](fledgling.md). Use its plan and reconciliation output as evidence; do not treat
successful trust setup as evidence that package contents, versions, or the publish workflow are
correct.

Some registries require a package to exist before trusted publishing can be configured. If bootstrap
credentials are unavoidable:

1. Limit their scope and lifetime.
2. Publish only the minimum bootstrap candidate.
3. Configure trusted publishing for every new package.
4. remove the secret and workflow fallback;
5. revoke the credential;
6. publish another candidate through OIDC alone.

A masked `NODE_AUTH_TOKEN` line from registry setup is not, by itself, proof that a stored secret was
used. Verify workflow inputs, environment secrets, registry provenance, and the publish log.

## 6. Prerelease and stable promotion

For a candidate release:

- use an explicit prerelease version and non-stable channel;
- keep `latest` or the equivalent stable channel unchanged;
- create the GitHub/provider release as a prerelease;
- install the candidate by exact version or explicit candidate channel;
- verify unrelated packages did not move.

For stable promotion:

- generate stable versions from the verified candidate source;
- inspect the generated version PR;
- remove version/changelog changes for private applications if the version tool added them
  incorrectly;
- merge and rehearse the exact stable commit;
- confirm stable versions are absent;
- create a draft stable release with the prerelease option disabled;
- verify the exact target SHA before publishing;
- confirm the stable channel advances and the candidate channel remains available.

## 7. Failure recovery

| Failure                                                  | Safe response                                                               | Avoid                                            |
| -------------------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------ |
| Version PR cannot be created                             | Check repository Actions permission to create PRs                           | Adding broader workflow tokens blindly           |
| Artifact upload finds no files                           | Compare pack destination and upload glob; create a new candidate            | Publishing from an unreviewed fallback directory |
| One package fails provenance                             | Inspect its packed manifest and canonical repository identity               | Disabling provenance                             |
| Trusted publishing cannot be configured for new packages | Perform a minimal, time-bounded bootstrap, then remove and revoke the token | Keeping a permanent token fallback               |
| Partial multi-package publish                            | Record successes; rerun idempotently and skip exact existing versions       | Unpublishing good packages                       |
| Registry lookup fails                                    | Abort unless the response explicitly means version absent                   | Treating every nonzero exit as 404               |
| Version tool modifies private apps                       | Reproduce in isolation and restore only those paths in the generated PR     | Merging null or incidental versions              |
| Base branch divergence cannot be found                   | Synchronize the real local base reference                                   | Resetting history                                |
| Local signing helper fails                               | Unlock or repair the signing agent and retry                                | Committing unsigned without approval             |
| Hosted UI exposes an unreleased feature                  | Add a minimum-version compatibility gate or delay deployment                | Letting schema/catalog surfaces drift            |

After any failure, ask:

1. What external state changed?
2. Which exact artifacts now exist?
3. Is retry idempotent?
4. Does the recovery require a new version?
5. Which prior evidence is invalidated?

Then restart the full applicable sequence at its first gate. Do not rerun only the failed step.

## 8. Evidence record

Capture:

```text
Release:
Operator/date:
Source commit:
Version plan:
Candidate release:
Stable release:

Local gates:
- Frozen install:
- Quality:
- Workflow audit:
- Release status:
- Pack count:
- Consumer fixture:

Remote gates:
- Version PR:
- Release target:
- Test job:
- Build/upload job:
- Publish job:
- Integrity evidence by surface (or justified alternative/N/A):

Registry:
- Candidate channels:
- Stable channels before:
- Stable channels after:
- Unrelated packages unchanged:

Recovery:
- Failures:
- External state after each failure:
- Corrective releases:
- Follow-up issues:
```

Do not record credentials, private filesystem paths, or sensitive registry responses.

## 9. Calavera terminal examples

These are commands used during the Calavera `2.3.0` release. They are concrete examples, not
universal defaults. Discover and use the target repository's scripts, package manager, package names,
release tool, workflow, registry, and version numbers.

Apply the gate restart rule to every command block below. If any command fails or its output differs
from the stated expectation, stop. After recovery, return to repository synchronization and repeat
the full applicable sequence.

### Prefer the automated gate

Current Calavera releases normally require two commands:

```bash
pnpm release:prepare
pnpm release:publish
```

`release:prepare` synchronizes and identifies the exact candidate, runs the frozen install and all
local gates, calculates the complete public workspace inventory, and distinguishes exact npm 404s
from registry failures. It is read-only unless a newly introduced npm package requires the explicit
`--bootstrap` transition:

```bash
pnpm release:prepare -- --bootstrap
```

That transition uses the pinned Fledgling dependency to claim only the reviewed package names and
configure trusted publishing, publishes the real initial stable packages through the existing OIDC
workflow, removes the temporary bootstrap tag, and restarts the gates.

`release:publish` reruns preparation, creates or verifies a draft release for the exact commit,
pauses once for publication approval, watches the matching workflow run, verifies provenance and
dist-tags, and exercises the published CLI and a changed artifact in a disposable consumer.
Successful reruns rediscover and verify an already published release instead of repeating it.

Use `--yes` only when the operator has already reviewed the exact transition and deliberately wants
to answer the script's publication checkpoint non-interactively. The detailed commands below remain
valuable for diagnosis and recovery. They are not the normal release interface.

### Synchronize and record the exact state

```bash
git status --short --branch
git pull --ff-only origin main
git rev-parse HEAD
git rev-parse origin/main
pnpm install --frozen-lockfile
```

Expected before rehearsal:

- a clean worktree;
- local `main` equal to `origin/main`;
- the recorded candidate SHA;
- a frozen install with no lockfile changes.

On a feature, integration, or generated version branch, pull that branch rather than switching to
`main` and losing context. Keep the local `main` reference synchronized because Changesets compares
against its configured base branch.

### Run repository npm scripts

Calavera exposed release gates as package scripts:

```bash
pnpm release:rehearse
pnpm workflow:check
pnpm release:status
```

Its rehearsal composed existing scripts rather than duplicating their behavior:

```json
{
  "scripts": {
    "quality": "pnpm lint && pnpm format:all:check && pnpm typecheck && pnpm knip && pnpm test && pnpm release:contracts",
    "publish:check": "pnpm --filter create-project-calavera publish:check && pnpm --filter @schalkneethling/calavera-baseline-core exec publint && pnpm --filter @schalkneethling/calavera-artifact-core exec publint && pnpm --filter './packages/artifacts/*' --recursive exec publint",
    "release:status": "changeset status",
    "release:version": "node scripts/release-version.mjs",
    "release:prepare": "node scripts/release-orchestrator.mjs prepare",
    "release:publish": "node scripts/release-orchestrator.mjs publish",
    "release:rehearse": "pnpm quality && pnpm release:fixture && pnpm web:build && pnpm --filter @calavera/baseline-explorer build && pnpm --filter @calavera/menu-bar build:web && pnpm publish:check",
    "workflow:check": "uvx zizmor@1.25.2 --offline .github/workflows"
  }
}
```

Run these individually when diagnosing a failure:

```bash
pnpm quality
pnpm release:fixture
pnpm web:build
pnpm --filter @calavera/baseline-explorer build
pnpm --filter @calavera/menu-bar build:web
pnpm publish:check
pnpm release:contracts
```

Passing individual commands during diagnosis does not resume the release. After the fix, restart at
the synchronization block and run the composed gates again.

### Inspect and change Changesets state

Before changing versions:

```bash
pnpm release:status
```

Examples of Calavera's prerelease transitions:

```bash
pnpm changeset pre enter next
pnpm release:version

# After the complete candidate cohort was verified:
pnpm changeset pre exit
pnpm release:version
```

`release:version` mutates manifests, changelogs and Changesets state. Simulate it first in a true
disposable copy, then inspect every generated file. Do not run it merely to see what might happen in
the working repository. Calavera's wrapper also formats only the generated JSON, Markdown, and YAML
files so Changesets prerelease state is deterministic.

When Changesets could not find where `HEAD` diverged from `main`, Calavera synchronized the genuine
local `main` reference and restarted the gates. It did not force or fabricate branch history.

### Pack every public workspace into one clean directory

```bash
mkdir -p package
find package -maxdepth 1 -type f -name '*.tgz' -delete

pnpm --filter create-project-calavera pack --pack-destination package
pnpm --filter @schalkneethling/calavera-baseline-core pack --pack-destination package
pnpm --filter @schalkneethling/calavera-artifact-core pack --pack-destination package
pnpm --filter "./packages/artifacts/*" --recursive pack --pack-destination package

find package -maxdepth 1 -type f -name '*.tgz' | sort
```

Calavera expected exactly eighteen archives: one CLI package and seventeen shared or artifact
packages. A missing archive, unexpected archive, duplicate identity, or prerelease suffix during
stable rehearsal fails the gate and restarts the sequence.

### Read the embedded package identities

```bash
for tarball in package/*.tgz; do
  tar -xOf "$tarball" package/package.json |
    node -e '
      let body = "";
      process.stdin.on("data", chunk => body += chunk);
      process.stdin.on("end", () => {
        const pkg = JSON.parse(body);
        console.log(`${pkg.name}@${pkg.version}`);
      });
    '
done | sort
```

Inspect the packed manifest rather than trusting the source manifest. Calavera also inspected
repository metadata directly from a tarball:

```bash
tar -xOf \
  package/schalkneethling-calavera-baseline-core-0.2.0.tgz \
  package/package.json |
  node -e '
    let body = "";
    process.stdin.on("data", chunk => body += chunk);
    process.stdin.on("end", () => {
      console.log(JSON.stringify(JSON.parse(body).repository, null, 2));
    });
  '
```

### Confirm exact versions are absent from npm

This preflight distinguishes an explicit missing-version response from registry, DNS,
authentication, or other failures:

```bash
for tarball in package/*.tgz; do
  package_name=$(
    tar -xOf "$tarball" package/package.json |
      node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(body).name))'
  )
  package_version=$(
    tar -xOf "$tarball" package/package.json |
      node -e 'let body=""; process.stdin.on("data", chunk => body += chunk); process.stdin.on("end", () => process.stdout.write(JSON.parse(body).version))'
  )

  view_output=$(mktemp)

  if npm view "${package_name}@${package_version}" version >"$view_output" 2>&1; then
    rm "$view_output"
    echo "ERROR: already published ${package_name}@${package_version}"
    exit 1
  else
    view_status=$?

    if ! grep -Eq '(^|[[:space:]])(E404|404)([[:space:]]|$)' "$view_output"; then
      cat "$view_output" >&2
      rm "$view_output"
      exit "$view_status"
    fi

    rm "$view_output"
    echo "Confirmed absent: ${package_name}@${package_version}"
  fi
done
```

Any output other than the complete expected set of `Confirmed absent` lines fails the gate.

### Create and verify a draft GitHub release

Confirm the tag and release do not exist:

```bash
git ls-remote --tags origin refs/tags/v2.3.0
gh release view v2.3.0
```

Create a draft targeting the exact rehearsed commit:

```bash
gh release create v2.3.0 \
  --draft \
  --target 4c7fba960ce58fd52e5483dd863ab14f4e550f10 \
  --title "Calavera 2.3.0" \
  --generate-notes
```

Verify the draft before publication:

```bash
gh release view v2.3.0 \
  --json name,tagName,isDraft,isPrerelease,targetCommitish,url,body
```

Publishing is an irreversible human checkpoint:

```bash
gh release edit v2.3.0 --draft=false --latest
```

Do not run the publication command until the user explicitly approves the verified draft.

### Monitor each remote job

```bash
gh run view <run-id> --json status,conclusion,url,headSha,event,jobs
gh run watch <run-id> --exit-status --interval 10
```

Calavera required the release event and workflow `headSha` to match the rehearsed commit. Test, build,
archive upload and protected OIDC publication each had to complete successfully.

If any remote job fails, record partial external state, recover, and restart the full gates. Do not
rerun only the failed job and treat earlier checks as current release approval.

### Verify registry channels and provenance

```bash
npm view create-project-calavera dist-tags --json
npm view @schalkneethling/calavera-baseline-core dist-tags --json
npm view @schalkneethling/calavera-artifact-core dist-tags --json
```

Calavera expected:

- `latest` to resolve the stable version;
- `next` to remain on the verified `next.3` candidate;
- unrelated packages and channels to remain unchanged.

It inspected the publish log for both package identities and provenance statements:

```bash
gh run view <run-id> --job <publish-job-id> --log |
  rg 'Signed provenance statement|\+ (@schalkneethling/|create-project-calavera@)'
```

Compare the number of published identities and provenance statements with the release inventory.

### Execute the published package as a consumer

```bash
pnpm dlx create-project-calavera@2.3.0 --help
```

For project-mutating behavior, create a fresh temporary consumer project and exercise dry run,
application, repeat application, local-edit protection, cleanup and doctor commands. Do not test a
published package only through the source workspace.

### Clean local staging only after verification

```bash
find package -maxdepth 1 -type f -name '*.tgz' -delete
rmdir package 2>/dev/null || true
git status --short --branch
```

The final expected state is a clean stable branch synchronized with its remote.
