---
"create-project-calavera": minor
"@schalkneethling/calavera-artifact-core": minor
---

The CLI now tells you when it is older than the version the npm `latest` dist-tag names, which happens when a package manager runs a copy it cached earlier (#675). After the command's own output, and after an error too, it prints a notice on standard error that names both versions and repeats your command pinned to `latest`; when Calavera is a project dependency, the notice also gives the command that updates it. The check asks the registry your npm configuration names, waits at most 1.5 seconds, writes no file, and prints nothing when it fails. It is skipped for `--json`, `--help`, `artifacts status` and `artifacts doctor` without `--check-updates`, and the MCP server. Set `CALAVERA_NO_VERSION_CHECK` to `1` or `true` to turn it off. Artifact-core adds `resolvePackageDistTag`, which resolves a dist-tag with the same registry settings as the artifact commands.
