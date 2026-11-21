---
"create-project-calavera": patch
---

When the recipe, `.calavera/state.json`, `.calavera/artifacts.lock.json`, the artifact transaction journal, or `package.json` is not valid JSON, Calavera now names the file, what is wrong, and the line and column, such as "calavera.config.json cannot be parsed as JSON: InvalidSymbol at line 3, column 14". Before, it passed on the message from `JSON.parse`, which quotes the text around the error, so a secret written in one of those files could reach terminal output, `--json` output, CI logs, and the `inspect_project` finding for an invalid `package.json`. No output quotes the file now, with or without `CALAVERA_DEBUG`. A missing or unreadable file still fails with its own error, such as `ENOENT` or `EISDIR` (#1157).
