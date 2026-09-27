---
"create-project-calavera": major
---

Collapse the `modern` and `classic` profiles, whose defaults became identical after the JavaScript and TypeScript toolchain removals, into one profile with the id `default`; `minimal` is unchanged. A `calavera.config.json`, `--profile` flag, or MCP call that names `modern` or `classic` now fails validation with a message naming `default` as the replacement: change the value to `default`, and the recipe produces the same files, scripts, and dependencies as before. `explain_recipe`, `compose_recipe`, `dry_run_apply`, and `apply --dry-run` now report the Vite+ detection result (`managed`, `unmanaged`, `unknown`, or a signal conflict), and for a `vp`-managed project state that JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera. See [ADR-0011](../docs/adr/0011-collapse-profiles-to-minimal-and-default.md).
