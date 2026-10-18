---
name: workaround-markers
description: Use when writing or changing code that works around a bug or limitation in a dependency, browser, or runtime, and when asked where a dependency is used in a project. Defines the WORKAROUND marker comment and the dependency map script.
metadata:
  internal: true
---

# Workaround markers and the dependency map

## Marking a workaround

When code compensates for a bug or limitation in a dependency (or a browser or runtime), add a single comment line next to it so tooling can find it later. Use the package name exactly as it appears in package.json. The `upstream` and `remove-when` fields are optional, but include them whenever they are known.

```
// WORKAROUND(package-name): what it compensates for | upstream: <issue or PR URL> | remove-when: >=x.y.z
```

Keep it on one line, and separate the fields with a pipe that has one space on each side, as in the example. Use the comment syntax of the file (`//`, `#`, `/* */`, or `<!-- -->`). The map finds markers in JS and TS files, Vue, Svelte, and Astro files, stylesheets, HTML, shell scripts, YAML, TOML, Python, and Ruby files, Dockerfiles, and `.npmrc`. A marker in any other file is not found, so keep workarounds for other files in one of these, or say in your report that the map cannot see them. When the workaround code is removed, remove the marker with it.

Do not add a marker for ordinary code that merely uses a dependency. A marker means the code exists only because the dependency or platform misbehaves.

## Finding where a dependency is used

Instead of searching the codebase broadly, run the dependency map. It reads the current files on every run and writes nothing, so its output is never stale.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/dependency-map.mjs" --packages <name>[,<name>...]
```

For each package it reports the declared version, the importing files, named symbols with file counts, config files, package.json scripts that mention the package, any `WORKAROUND(package)` markers, and a usage fingerprint. Default, namespace, `require`, and dynamic imports are flagged as opaque because the import line does not show which members are used; grep only those files for the member in question. Add `--json` for untruncated output, `--max-files <n>` to list more file names, and `--root <dir>` to scan another directory.

The map is regex-based, not a full parser, so treat "not found" as strong evidence rather than proof, especially for usage that does not go through an import.
