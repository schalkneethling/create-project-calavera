# Release gates and recovery reference

Use this reference to select checks for the project at hand. Do not copy commands blindly: discover
the repository's package manager, version tool, registry, hosting provider, and release scripts first.

## Contents

1. Release inventory
2. Branch and version gates
3. Local rehearsal
4. Artifact and registry preflight
5. Secure publication
6. Prerelease and stable promotion
7. Failure recovery
8. Evidence record

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
- reject vacuous success, unrelated private packages, and synchronized bumps that were not intended.

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
- Provenance/signing:

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
