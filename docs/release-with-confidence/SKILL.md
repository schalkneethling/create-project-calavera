---
name: release-with-confidence
description: Guide a software project through a staged, evidence-backed release with deliberate human checkpoints, prerelease channels, secure CI publication, recovery from partial failures, stable promotion, and post-release verification. Use when preparing, rehearsing, publishing, promoting, or recovering a package, monorepo, application, CLI, desktop app, or multi-surface release—especially with Changesets, npm trusted publishing, GitHub Releases, independent packages, or an integration branch.
---

# Release With Confidence

Treat a release as a sequence of verified state transitions, not one large command. Discover the
project's own tooling first, preserve its release boundaries, and stop for explicit approval before
each irreversible action.

## Operating contract

- Lead with the next gate and its expected evidence.
- Execute one release transition at a time.
- Keep read-only inspection separate from mutation.
- Never infer authority to merge, publish, create a tag, move a dist-tag, change credentials, or
  delete a release.
- Recheck the exact commit after every merge.
- Prefer an existing project command over an invented equivalent.
- Keep secrets out of commands, logs, reports, and committed files.
- Do not weaken integrity, provenance, signing, protected environments, or local-edit checks to make
  a release pass.
- If publication partially succeeds, preserve good versions and make the workflow safely rerunnable.

## 1. Map the release before changing it

Read repository instructions and inspect:

- the current branch, worktree, remote tracking state, and release tags;
- workspace/package manifests and private/public boundaries;
- versioning configuration and pending release notes;
- test, build, pack, publish, deployment, and signing workflows;
- registry channels or distribution tracks;
- protected environments, OIDC permissions, provenance, and token fallbacks;
- package-name reservation and trusted-publisher bootstrap or reconciliation tooling;
- application surfaces that deploy independently of packages;
- existing release runbooks and rehearsal records.

Build a release map with one row per surface:

| Surface | Version/deployment boundary | Candidate | Stable target | Trigger | Evidence |
| ------- | --------------------------- | --------- | ------------- | ------- | -------- |

Do not assume every workspace is publishable or that every changed surface shares a version.

## 2. Choose the release path

Use a direct stable release only for a small, well-understood, reversible change with an established
pipeline. Use a prerelease channel when the change adds packages, changes package topology, migrates
state, introduces a new application, changes authentication, or otherwise widens the blast radius.

For a large integration:

1. Create an integration branch from the current stable branch.
2. Land small issue-linked branches into it in dependency order.
3. Rebase or merge the updated integration branch into the next branch before each review.
4. Test every branch as an independently understandable increment.
5. Open the integration branch to the stable branch only after the complete candidate is rehearsed.

Preserve contributor authorship and commit history when incorporating outside work.

## 3. Establish gates and evidence

Open and read [`references/release-gates.md`](references/release-gates.md) before the first release
mutation. Select the applicable gates and create a durable record containing:

- source commit and operator;
- version plan for every release surface;
- local and remote validation results;
- packed artifact identities and contents;
- registry-before and registry-after observations;
- candidate and stable channel values;
- provenance/signing evidence;
- failures, recovery actions, and follow-up issues.

Use repository-native checks. Typical gates include a frozen install, quality suite, package
validation, workflow audit, version-plan inspection, builds, packing, fixture installation, migration
tests, and clean-environment smoke tests.

## 4. Rehearse the exact candidate

Run the full rehearsal on the exact commit intended for release:

1. Synchronize the stable branch reference without discarding work.
2. Confirm a clean worktree and record the commit SHA.
3. Install from the frozen lockfile.
4. Run repository checks and release-specific checks.
5. Inspect the calculated version plan; reject unrelated packages or missing changes.
6. Pack into a clean staging directory.
7. Read each packed manifest and verify name, version, privacy, repository metadata, entry points,
   files, and expected count.
8. Install or execute the packed artifact from a disposable consumer project.
9. Verify generated state, repeat application, cleanup, local-edit protection, and offline behavior
   where applicable.

Never treat source manifests as proof of tarball contents.

## 5. Publish a candidate safely

Before publishing:

- confirm the candidate tag and versions do not already exist;
- confirm stable channels will not move;
- confirm only the publish job can request an identity token;
- confirm the publish job depends on successful test and build jobs;
- confirm packed artifacts cross the job boundary instead of rebuilding with publish privileges;
- confirm registry lookup distinguishes a missing version from network or authentication failure.

When an npm release introduces new public package names or needs to reconcile trusted-publisher
settings, evaluate Fledgling. Read
[`references/fledgling.md`](references/fledgling.md) before using it. Keep Fledgling scoped to
package claiming and trust configuration; retain the project's existing version, changelog, pack,
publish, and verification workflow.

Create the release as a draft first. Verify its tag, target commit, title, notes, and prerelease flag.
Pause for approval, then publish. Monitor test, build, artifact upload, and publish separately.

After publishing, verify every expected package or artifact, its candidate channel, provenance or
signature, and the unchanged stable channel. Exercise the candidate in a fresh consumer project.

## 6. Promote to stable

Promote by creating stable versions from the verified source state. Do not merely relabel a
prerelease as stable unless the ecosystem and project explicitly define that policy.

1. Exit prerelease mode or create the stable version plan.
2. Simulate version generation in an isolated copy.
3. Inspect every generated file, including private applications and lockfiles.
4. Correct release-tool edge cases in the generated version branch before merge.
5. Rehearse the exact stable version commit.
6. Merge it, synchronize the stable branch, and rehearse the exact merge commit again.
7. Pack and inspect the stable artifacts.
8. Confirm stable versions and tags are absent from the registry.
9. Create a draft stable release targeting the verified commit.
10. Verify metadata, pause for approval, and publish.

Monitor the workflow to completion, then verify stable and candidate channels independently.

## 7. Recover without compounding a failure

Stop at the failed gate and record what changed externally.

- If nothing published, fix forward and produce a new candidate.
- If some packages published, do not unpublish good immutable versions. Make the workflow skip exact
  existing versions and retry only missing ones.
- If a registry lookup fails for reasons other than an explicit missing-version response, abort.
- If an artifact was not uploaded, fix its staging destination and create a new version when the
  release record requires immutability.
- If provenance metadata fails, inspect the packed manifest—not only source—and correct canonical
  repository identity.
- If automation cannot open a version PR, inspect repository Actions permissions before changing the
  workflow.
- If version tooling touches private applications, reproduce in an isolated copy and remove only the
  unintended generated changes.
- If signing fails locally, restore the signing agent; do not silently disable signing.

Require a fresh successful rehearsal after every recovery change.

## 8. Finish the release

Verify:

- the release tag resolves to the approved commit;
- the release is neither draft nor prerelease when stable was intended;
- all expected versions resolve from the public distribution channel;
- candidate channels retain the intended candidate versions;
- provenance or signing exists for every artifact;
- a consumer can resolve and execute the released version;
- the worktree is clean and temporary artifacts are removed;
- follow-up issues capture deferred cleanup or tooling bugs.

Report the outcome with exact versions, commit, release URL, workflow URL, validation evidence, and
any remaining caveats.
