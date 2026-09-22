# ADR-0008: Remove Package Minting from the Release Orchestrator

- **Status:** Accepted (2026-09-22, Schalk Neethling)
- **Date:** 2026-09-22
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/507
- **Decides:** removal of automated npm package minting from `scripts/release-orchestrator.mjs`.
  `pnpm release:prepare` no longer runs Fledgling itself; it fails before the gates when a planned
  package does not yet exist on npm and prints the exact commands for a human to run. This reverses
  the automated bootstrap introduced in #365 (commit 398c6bb, 2026-07-30, "Automate gated package
  releases"). It does not touch a catalog entry, a managed file, or anything Calavera writes into a
  project.

## Context

`bootstrapNewPackages` in `scripts/release-orchestrator.mjs:320-400` (as it stood before this change)
issued two Fledgling subprocess calls, a dry-run plan and then the mutating claim, and then ran a
second, orchestrated release inside the release: it created a `packages-bootstrap-<sha>` draft, flipped
it to prerelease, watched the resulting publish workflow run, verified the newly minted packages,
removed the temporary `bootstrap` npm dist-tag, and restarted the ordinary gates before returning
control to `prepareRelease`.

None of that path can be exercised end to end. Minting a package name on npm is irreversible and
public: there is no dry-run equivalent for the claim itself, no way to undo it, and no way to run it
twice against the same name to produce a passing test. The path exists for an event that happens once
per new package, so the repository carried roughly eighty lines of orchestration: a second draft
release, a second workflow watch, a second verification pass, a dist-tag cleanup, and a guard against
running alongside other unpublished packages. That code could only ever be reviewed by reading it,
never by running it.

The untestable surface area had a second cost. `scripts/check-release-contracts.mjs:91` pinned the
`fledgling` devDependency to the literal `"1.2.1"`, because `references/fledgling.md` asks for an
exact, reviewed version and the contract check enforced that by freezing a specific number. Dependabot
pull request #504 bumped `fledgling` from 1.2.1 to 1.3.1 and failed the `Check` workflow with a bare
`AssertionError [ERR_ASSERTION]: '1.3.1' !== '1.2.1'`, an assertion that says nothing about what
changed between the two versions or why the bump is unsafe. Every Fledgling bump, safe or not, would
fail the same way, because the check enforced a frozen number rather than the property the reference
doc actually asks for: that the version is exact and was reviewed.

## Evidence

Reproducing pull request #504 by running `node scripts/check-release-contracts.mjs` against
`fledgling@1.3.1` in `package.json` fails at line 91 with `'1.3.1' !== '1.2.1'` and no further context.
The failure is identical in shape regardless of what changed inside Fledgling 1.3.1, which confirms the
check was pinned to a number rather than testing a property.

`git log --follow -- scripts/release-orchestrator.mjs` shows `bootstrapNewPackages` unchanged in shape
since commit 398c6bb introduced it: two Fledgling `run()` calls, a `packages-bootstrap-<sha>` draft, a
`gh release edit --draft=false --prerelease=true`, a `gh run watch`, `verifyPublishedPackages`, a
`npm dist-tag rm ... bootstrap` loop, and a final `runGates` re-invocation. `scripts/release-orchestrator.test.mjs`
at that commit covers `--bootstrap` only as a flag accepted by
`parseOptions`; no test exercises the draft-and-watch sequence itself, because doing so would require
either mocking away the entire function body or minting a real npm package name in CI.

## Decision

Remove `bootstrapNewPackages`, the `--bootstrap` option, the `packages-bootstrap-` draft and
run-watching branch, the `bootstrap` dist-tag cleanup, and the "refuse while other packages are
unpublished" guard from `scripts/release-orchestrator.mjs`. No compatibility flag or legacy mode
survives.

`prepareRelease` now plans the public packages, then calls `assertPackagesMinted` before running any
gate. If any planned package does not exist on npm, it throws a `ReleaseError` naming every such
package and containing the exact Fledgling commands, built from one shared argument builder
(`fledglingArgs`/`fledglingCommand`), so the printed dry-run and apply commands can never drift from
each other:

```text
pnpm exec fledgling add <names> --dry-run --repo schalkneethling/create-project-calavera --workflow publish.yml --env publish --permissions publish --placeholder-version 0.0.0
pnpm exec fledgling add <names> --yes --repo schalkneethling/create-project-calavera --workflow publish.yml --env publish --permissions publish --placeholder-version 0.0.0
```

The command drops `--tag bootstrap`: the placeholder is published straight onto npm's default `latest`
dist-tag, so there is no temporary tag left to remove after the first real publish. The error states
the npm 11.15.0 minimum Fledgling requires and instructs the operator to rerun `pnpm release:prepare`
once the name is minted.

Because the placeholder lands on `latest`, the first real release of a minted package must be stable.
`assertStableAfterPlaceholder` refuses a prerelease version for any package whose `latest` dist-tag is
still the `0.0.0` placeholder, with a message distinct from the minting failure, so an operator cannot
accidentally leave a placeholder on the channel real users resolve.

`verifyTrust` is unchanged in what it checks, a structured `npm trust list` response against the
expected GitHub workflow, repository, environment, and `createPackage` permission, but it now runs on
every `prepareRelease` for each package the release will publish, not only for packages Fledgling
just minted. Packages already on npm at their local version are skipped: trust drift there says
nothing about the release at hand, and checking it would block a release of the other packages. It is
the check that matters for OIDC publishing regardless of how a package's name was claimed.

`scripts/check-release-contracts.mjs:91` now asserts only that the `fledgling` devDependency spec is
exact (no `^` or `~` prefix), not that it equals a specific number. Fledgling stays an exact-pinned
devDependency so the printed command runs a known, reviewed binary; the review that number deserves
happens on the Dependabot pull request, not in a script assertion that fails identically for every
bump.

## Consequences

`pnpm release:prepare` fails fast for a new package name: before the Baseline data check, the local
rehearsal, and the workflow audit, not after them. An operator sees the exact Fledgling commands
immediately instead of waiting for the full gate sequence to learn the same thing indirectly.

The release orchestrator no longer contains a code path that cannot be exercised. Every branch in
`prepareRelease` now runs on every invocation and is covered by `scripts/release-orchestrator.test.mjs`
without mocking around an irreversible registry mutation.

A Dependabot Fledgling bump now passes `scripts/check-release-contracts.mjs` and is reviewed on its own
pull request, the same as any other dependency bump, instead of failing the `Check` workflow on a
frozen literal that could not distinguish a safe bump from an unsafe one.

Minting a new package name is now entirely a human action run by hand from a printed command. Nothing
in the orchestrator creates a draft release, watches a workflow run, or removes a dist-tag on the
operator's behalf for that event; the operator uses the ordinary `pnpm release:prepare` /
`pnpm release:publish` flow once the name exists, exactly as for any already-published package.

Every `pnpm release:prepare` and `pnpm release:publish` now runs `npm trust list`, which needs npm
11.15.0 or newer and an npm login with two-factor authentication enabled on the operator's machine.
Before this decision only the minting path needed them. No npm token is involved; publishing still
happens through OIDC inside the `publish` environment.

`docs/release-runbook.md` and `references/release-gates.md` in the release-with-confidence skill
payload describe the new flow. `references/fledgling.md` already framed Fledgling as an optional,
reviewed tool and is unchanged. Fledgling remains an exact-pinned
devDependency and the skill's "pin and review the tool" guidance is unchanged; only the transition
that used to run inside the release is gone.

## Alternatives considered

**Keep minting automated, fail only on a Fledgling major bump, comment on the pull request, and add a
script that updates the pinned literal and commits it.** Rejected. This adds machinery, a comment
step, a literal-rewriting script, and a commit, to service a check that exists only to guard two
subprocess calls the orchestrator still could not exercise end to end. It does not make the untestable
ceremony testable, it only makes the check pass more often. A script-authored commit pushed onto a
Dependabot branch also stops Dependabot from rebasing that branch on its own, trading one piece of
friction for another.

**Derive the expected Fledgling version from `package.json` instead of a literal.** Rejected. An
assertion that reads the version from the same file it is checking against says nothing; it can never
fail, so it stops being a check at all.

**Keep the pinned literal as an explicit review gate, with a clearer failure message.** Rejected. It
still fails on every single bump regardless of whether the bump is safe, and the review it claims to
force already happens on the Dependabot pull request itself, where the diff and changelog are visible.
A clearer message would explain the failure without removing its cause.

## Open questions

None. Whether a Fledgling major version bump deserves its own hard gate, separate from ordinary
Dependabot review, is left open and is not decided here.
