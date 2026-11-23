---
"create-project-calavera": patch
"@schalkneethling/calavera-artifact-core": patch
---

Repository content can no longer put an environment value into a proxy URL, or change which package manager's settings Calavera reads for artifact lookups, artifact downloads, and the version notice (#1186). Calavera now expands `${VAR}` in a proxy value only in your own `~/.npmrc` or `~/.yarnrc.yml`, in your operating system account's home folder, and in environment variables. A user `.npmrc` that `npm_config_userconfig` names elsewhere, which a project `.npmrc` `userconfig` key can choose, and a `~/.yarnrc.yml` in a `HOME` that a Yarn 4 `.env.yarn` sets, still apply, but their proxy entries that contain `${...}` are ignored with a warning that names the key, never a value. When `npm_execpath` names npm or pnpm, Calavera reads the npm settings even when the user agent names Yarn or Bun, because npm exports a project `.npmrc` `user-agent`, and pnpm its `userAgent` setting, as `npm_config_user_agent`.
