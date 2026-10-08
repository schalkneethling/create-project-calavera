---
"@schalkneethling/calavera-artifact-core": patch
"create-project-calavera": patch
---

Artifact resolution and extraction now honor the npm registry configuration of the project. The registry, scoped registries (`@scope:registry`), and registry credentials are read from the user `.npmrc`, the project `.npmrc`, and `npm_config_*` environment variables, so private and mirrored registries work. Tarball integrity verification is unchanged, and credentials never appear in error messages.
