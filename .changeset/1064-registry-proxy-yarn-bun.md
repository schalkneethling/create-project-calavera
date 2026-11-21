---
"create-project-calavera": minor
"@schalkneethling/calavera-artifact-core": minor
---

Artifact lookups and the version notice now use the registry and proxy of the package manager that started Calavera. The `proxy`, `https-proxy`, and `noproxy` settings in your user or project `.npmrc` and the matching `npm_config_*` variables now apply, so a proxy set only in `.npmrc` no longer makes lookups fail. A proxy from a project file is not used for an `http` registry. Under Yarn 2 or later, Calavera reads `npmRegistryServer`, `npmScopes`, `httpProxy`, and `httpsProxy` from your `.yarnrc.yml` files and `YARN_*` variables, and uses Yarn's default registry when none is set. Under Bun, it reads `[install] registry` and `[install.scopes]` from `bunfig.toml`, and `BUN_CONFIG_REGISTRY`. Credentials still come from `.npmrc`: Calavera does not read them from `.yarnrc.yml` or `bunfig.toml`, and a failed lookup names the `bunfig.toml` credentials it left out. Warnings and errors name a setting, never its value, because a proxy or registry URL can carry credentials (#1064).
