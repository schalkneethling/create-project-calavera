# Optional Fledgling workflow for npm trust bootstrapping

Use [Fledgling](https://github.com/dmno-dev/fledgling) when an npm release introduces new public
package names or when trusted-publisher configuration may have drifted across a single package or
monorepo. It can claim missing names with minimal placeholder packages and reconcile npm trusted
publishers through npm's trust interface.

Do not use Fledgling as a substitute for version planning, changelog generation, package validation,
packing, release publication, provenance checks, or registry verification.

## Decision boundary

Use Fledgling when:

- one or more intended public npm names do not exist yet;
- many new monorepo packages need the same trusted publisher;
- a workflow filename, provider, repository, protected environment, or publish permission changed;
- maintainers need an idempotent report of missing or mismatched trust configuration.

Skip it when:

- no npm packages are involved;
- every package already has verified, matching trust configuration and no new names were added;
- the registry or CI provider is unsupported;
- the project's security policy forbids local registry-management tools;
- the required Node, npm, authentication, or 2FA prerequisites are unavailable.

At the time this reference was written, Fledgling requires Node 18 or newer and npm 11.15.0 or newer.
Verify current requirements and review the selected release before every use.

## Configure once

Prefer checked-in root configuration so every reconciliation compares npm with the same intended
state:

```json
{
  "fledgling": {
    "provider": "github",
    "workflow": "publish.yml",
    "environment": "publish",
    "permissions": "publish"
  }
}
```

Adapt the provider and workflow to the project. Tie the publisher to a protected environment when the
CI provider supports it. Request only `publish` unless the project deliberately uses npm staged
publishing.

Install the reviewed version as a local development dependency and invoke that pinned binary. If its
package includes an unrelated install hook, explicitly disable that build script only after verifying
the published CLI is already built and functional; do not enable arbitrary dependency lifecycle
scripts merely to install release tooling.

Fledgling skips packages marked `private: true`. Add explicit ignore patterns for public workspace
packages that must never be claimed or managed.

## Pin and review the tool

Use an exact, reviewed Fledgling version rather than an unversioned package runner:

```text
<package-runner> fledgling@<reviewed-version> ...
```

Inspect the selected release notes, package integrity, supported providers, and npm requirements. A
new tool version is a release-pipeline change and requires review.

## Plan before claiming

Run Fledgling's non-mutating plan for the intended package set. In a monorepo, compare its targets
with the release inventory and verify that private or ignored packages are absent.

Fledgling can publish a minimal placeholder for an unclaimed name. That is an irreversible public
registry mutation even though it contains no project code. Its default placeholder version is
`0.0.0`. npm may create `latest` for the first version even when a non-stable placeholder tag was
requested. Follow the claim promptly with the real reviewed initial stable package through the
project's OIDC workflow, verify that `latest` points to it, and remove the temporary placeholder tag.

### Package-name safety and npm policy

Fledgling's documented plan checks the exact requested package names. It does not claim to search for
confusingly similar names or to perform a typosquatting review. Treat that as a separate registry and
maintainer check.

Before claiming a name:

- search npm for the exact name and likely misspellings, separators and scope variants;
- check whether the name could confuse users about authorship or an existing project;
- prefer an organization-owned scope when that establishes clear ownership and avoids dependency
  confusion;
- review trademarks and npm's
  [package name guidelines](https://docs.npmjs.com/package-name-guidelines/);
- do not rely on npm's
  [automated typosquat detection](https://docs.npmjs.com/threats-and-mitigations/) as the only review.

npm's [package-name dispute policy](https://docs.npmjs.com/policies/disputes/) says names are
first-come, first-served for immediate active use and that a package with no genuine function may be
treated as squatting. Use a Fledgling placeholder only as a short bootstrap step for an imminent,
real package release—not to reserve speculative future names. If the functional package is not ready
to follow promptly, stop and resolve the naming and policy question before claiming it.

Before approval, decide:

- whether the organization owns the intended npm scope;
- whether each name and access level are correct;
- whether `0.0.0` is compatible with project policy;
- whether the placeholder should use a non-stable tag such as `next`;
- whether package creation quotas or registry policy apply;
- who is authorized to authenticate and approve 2FA.

Do not let a bootstrap placeholder move a consumer-facing stable channel unintentionally.

## Apply with a human checkpoint

Pause after reviewing the plan. Require explicit approval before Fledgling:

- claims a name;
- publishes a placeholder;
- creates a trusted publisher;
- replaces existing trust configuration.

Prefer an interactive authenticated session with npm 2FA. Never place an OTP or TOTP secret directly
in a committed file, command shown in a report, shell history, or process list. If non-interactive
authentication is unavoidable, source the secret from an approved secret manager through an
environment variable and remove it immediately after the bootstrap.

Never use Fledgling's force-replacement option without reviewing the exact trust difference and
obtaining explicit approval. Replacing trust revokes the existing publisher before creating the new
one.

## Verify npm state directly

Run the pinned `fledgling sync` command:

- after adding a public package;
- after changing the CI provider, repository, workflow filename, environment, or permission;
- before the first candidate release;
- during periodic release-security reviews.

Use interactive mode so Fledgling reads npm state, reports exact differences, and pauses before
applying them. Record the plan without credentials. Apply only reviewed differences.

Treat npm itself as the authority after mutation. Verify each publisher with `npm trust list`, and
verify exact versions and dist-tags with `npm view`. A tool's reconciliation command is useful
advisory feedback, but registry propagation or a tool defect can produce a false mismatch; do not
replace a publisher merely because the wrapper reports drift. Compare the exact npm trust record
first. A duplicate trust creation conflict is evidence to inspect, not permission to force-replace
the existing publisher.

Keep independent evidence that:

- the workflow grants `id-token: write` only to the publish job;
- the configured workflow and environment actually match the repository;
- the candidate package publishes with provenance;
- no long-lived registry token remains;
- expected stable and candidate tags resolve correctly.

Trust reconciliation proves only that npm accepts the configured CI identity. It does not prove the
workflow is safe or that a release is correct.
