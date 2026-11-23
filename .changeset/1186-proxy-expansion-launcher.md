---
"create-project-calavera": major
"@schalkneethling/calavera-artifact-core": major
---

A proxy setting that uses `${VAR}` in a user `.npmrc` outside your operating system account's home folder stops expanding (#1186). This includes a user `.npmrc` that `npm_config_userconfig` names, for example in CI. Calavera now ignores such a proxy entry with a warning that names the key, never the value. To keep the proxy, write its URL without a variable, move it to `~/.npmrc` in your account's home folder, or set it as an environment variable, such as `npm_config_https_proxy`. The same rule applies to a `~/.yarnrc.yml` in a `HOME` that is not your account's home folder, such as one that a Yarn 4 `.env.yarn` sets. Calavera still reads the registry and the literal proxy settings of such a file.

A project file can no longer change which package manager's settings Calavera reads for artifact lookups, artifact downloads, and the version notice. When `npm_execpath` names npm or pnpm, Calavera reads the npm settings even when the user agent names Yarn or Bun. npm exports a project `.npmrc` `user-agent`, and pnpm its `userAgent` setting, as `npm_config_user_agent`, so that variable alone can come from the repository.

Under `npx`, `npm exec`, and `npm run`, Calavera now recognizes two more kinds of values that npm passes on from a configuration file. One is a proxy that a chosen user `.npmrc` spells differently, such as `https_proxy`, which is no longer trusted as an environment variable. The other is a project `.npmrc` key with a variable in it, such as `registry${UNSET?}`, which npm expands and which now follows the project rules. A registry, proxy, or `HTTPS_PROXY` value that a repository's Yarn 4 `.env.yarn` sets is accepted as the repository's choice and applies as an environment variable.
