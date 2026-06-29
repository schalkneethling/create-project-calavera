# Vite+ Awareness And Delta Scripts

Calavera remains a tooling composer, not an application scaffold. Vite+ awareness
should therefore live in catalog metadata and doctor guidance rather than in
generated scripts that assume a specific app starter.

## Vite+ Awareness

Vite+ detection belongs in two places:

- Catalog metadata should describe framework-specific integrations, including
  whether an integration is useful for Vite, Vite+, React, Vue, Svelte, or another
  project shape.
- `doctor` can surface advisory messages when a recipe and detected project files
  appear mismatched.

Generated package scripts should stay ordinary package-manager scripts. Calavera
should not replace them with `vp` commands or assume that a Vite+ project wants a
different lint, format, or typecheck command. If Vite+-specific behavior becomes
useful later, it should be modeled as an explicit catalog integration so the CLI
and composer can expose it consistently.

## Delta Scripts

Full-project scripts remain the default. Delta scripts are opt-in recipe flags
for local review loops and pull request checks that only need to inspect changed
files:

```json
{
  "scripts": {
    "lint": true,
    "format:check": true,
    "quality": true,
    "lint:changed": true,
    "format:check:changed": true,
    "quality:changed": true
  }
}
```

When a changed-file script is enabled, Calavera writes
`.calavera/run-changed-files.mjs`. The helper requires a Git working tree and
collects:

- files changed from the comparison base to `HEAD`;
- unstaged changes;
- staged changes;
- untracked files.

The default comparison base is the remote default branch from `origin/HEAD`, or
`HEAD` when that is unavailable. Set `CALAVERA_CHANGED_BASE` to compare against a
specific branch or ref:

```bash
CALAVERA_CHANGED_BASE=origin/main npm run lint:changed
```

The helper filters files by extension, ignores common generated directories, and
then appends the matching file list to the configured tool command. If no
matching files changed, it exits successfully.

## Generated Scripts

The optional flags are:

- `lint:changed`
- `lint:fix:changed`
- `format:changed`
- `format:check:changed`
- `quality:changed`

`quality:changed` composes the generated package-manager commands explicitly,
for example `pnpm lint:changed && pnpm format:check:changed`. It does not replace
the full `quality` script and does not run TypeScript in a partial mode because
TypeScript project checking is not reliably file-local.
