---
"@schalkneethling/calavera-artifact-core": patch
"create-project-calavera": patch
---

Artifact resolution and extraction now honor the npm registry configuration. The registry, the registry of the artifact scope (`@scope:registry`), and registry credentials are read from the user `.npmrc`, the project `.npmrc` in the current directory, and `npm_config_*` environment variables, so private and mirrored registries work. `${VAR}` is expanded only in the user `.npmrc` and the environment; a project `.npmrc` entry that contains it is ignored with a warning. A registry URL with a username or password is rejected. The dry run of `apply`, `artifacts install`, and `artifacts update`, and the `dry_run_apply` MCP tool, now report the registry host (`artifactRegistries`) and configuration warnings (`artifactWarnings`). Proxy, CA, and `strict-ssl` settings from an `.npmrc` are not read; `HTTPS_PROXY`, `NO_PROXY`, and `NODE_EXTRA_CA_CERTS` apply. Credentials never appear in error messages.
