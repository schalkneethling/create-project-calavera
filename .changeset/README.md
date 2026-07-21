# Changesets

Every pull request that changes a public npm package must include a Changeset describing the user-visible change and selecting its semver impact.

The release-PR workflow collects Changesets into a version pull request. Publishing remains a separate, protected OIDC workflow triggered from an approved GitHub release; the release-PR workflow has no npm publish permission.

Private applications are deployed through their own workflows and do not receive npm Changesets.
