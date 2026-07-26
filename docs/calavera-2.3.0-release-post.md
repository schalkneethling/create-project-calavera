# Calavera 2.3.0: Baseline guidance, versioned artifacts and a new foundation

Calavera 2.3.0 is now available.

This is much more than a routine feature release. Calavera has moved to a pnpm monorepo with
independent packages and applications, a shared Baseline recommendation engine, package-backed agent
artifacts, and a release model designed for secure, incremental updates.

## A new architecture

The repository now has explicit boundaries for:

- the `create-project-calavera` CLI and MCP server;
- the visual Composer;
- the Baseline Target Explorer;
- the optional macOS menu-bar companion;
- shared Baseline and artifact packages;
- every maintained skill, hook and agent.

Public packages use independent semantic versions. The Composer and Baseline Explorer remain
independently deployable static applications. The menu-bar app has its own release stream. A change no
longer needs to move unrelated surfaces simply because they share a repository.

## Explore CSS Baseline targets

The new [Baseline Target Explorer](https://baseline.calavera.schalkneethling.com/) helps turn a
Baseline choice into something concrete.

You can:

- explain Widely, Newly or a fixed Baseline year;
- see matching Chrome, Edge, Firefox and Safari versions;
- select CSS features and find their earliest compatible target;
- generate a Stylelint rule, Stylelint configuration or Calavera recipe;
- share a selected target or feature set by URL.

The Explorer, CLI, Composer, MCP and WebMCP use the same
`@schalkneethling/calavera-baseline-core` recommendation model. Recipes can now carry explicit
Stylelint Baseline options:

```json
{
  "integrations": ["stylelint", "stylelint-standard", "stylelint-baseline"],
  "integrationOptions": {
    "stylelint-baseline": {
      "available": 2025,
      "severity": "warning"
    }
  }
}
```

## Independently versioned skills, hooks and agents

Calavera's maintained agent artifacts are now separate npm packages. Each package contains one
payload and a validated artifact manifest declaring its identity, supported targets and compatible
CLI range.

Projects select artifacts by stable ID. Calavera resolves and verifies the package without adding it
to the project's `package.json` or `node_modules`, then records the exact version and integrity in
`.calavera/artifacts.lock.json`.

The new lifecycle commands are:

```text
create-project-calavera artifacts install
create-project-calavera artifacts status
create-project-calavera artifacts status --check-updates
create-project-calavera artifacts doctor
create-project-calavera artifacts migrate
create-project-calavera artifacts update <artifact-id>
create-project-calavera artifacts update --all
```

Ordinary `apply` uses exact locked versions. Only an explicit artifact update advances a version.
Status remains offline unless you request an update check. Verified cached packages support locked
offline installation, and existing managed-file protection prevents local edits from being silently
overwritten.

Stable artifacts use npm's `latest` channel. Prereleases require an explicit `next` selection.

## More tools in the catalog

Calavera 2.3.0 also adds:

- optional Knip unused-code analysis;
- HTML Validate configuration and scripts;
- logical CSS Stylelint support;
- Varlock environment schema and validation, contributed by
  [Theo Ephraim](https://github.com/theoephraim);
- minimum CLI compatibility metadata so the hosted Composer does not offer integrations before the
  published CLI can apply them.

When Calavera installs skills, it can also add merge-safe CodeRabbit path exclusions so the first
pull request does not spend review tokens on vendored upstream skill content.

## Safer project changes

This release strengthens the inspect-and-approve workflow throughout the CLI:

- artifact install and update support dry-run and JSON output;
- locks, managed state and multi-output hook installation are handled atomically;
- local edits block unsafe cleanup or replacement;
- human-readable clean output now reports planned deletions and protected skips;
- Baseline data is generated from a pinned cutoff for reproducible results;
- registry, integrity, identity and compatibility failures stop before project files change.

## An optional macOS companion

The repository now includes a Tauri menu-bar companion that watches only projects you explicitly
register. It reads recipe, lock and state files, checks for available CLI, artifact and app updates,
deduplicates notifications, and prepares the exact update command.

It never scans arbitrary directories or updates projects automatically. The macOS app follows a
separate signed and notarized DMG release stream rather than the npm release.

## Secure publication

Calavera's eighteen public packages were rehearsed through four `next` candidates before stable
promotion. The final candidate and stable cohort were published with npm trusted publishing through
GitHub Actions OIDC—without a long-lived npm token—and every package has signed provenance.

The CLI is now `2.3.0`; the new shared and artifact packages begin their stable line at `0.2.0`.

## Get started

Compose a recipe:

```bash
npm create project-calavera init
```

Or inspect the stable CLI:

```bash
pnpm dlx create-project-calavera@2.3.0 --help
```

Existing projects can continue using their current recipes. Legacy artifact source entries remain
readable for the compatibility window and can be converted with:

```bash
create-project-calavera artifacts migrate
```

Try the [visual Composer](https://calavera.schalkneethling.com), explore
[CSS Baseline targets](https://baseline.calavera.schalkneethling.com/), or read the
[full v2.3.0 release](https://github.com/schalkneethling/create-project-calavera/releases/tag/v2.3.0).

Thank you to everyone who reviewed, tested and contributed—especially Theo for the Varlock
integration.
