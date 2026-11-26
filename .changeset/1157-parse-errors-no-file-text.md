---
"create-project-calavera": patch
---

When a JSON file a person writes is not valid JSON, Calavera now names the file, what is wrong, and the line and column, such as "calavera.config.json cannot be parsed as JSON: InvalidSymbol at line 3, column 14". Some commands name the file by its full path. When the text nests too deeply to locate the error, the message still names the file and says the position is unknown. Before, it passed on the message from `JSON.parse`, which quotes the text around the error, so a secret written in one of those files could reach terminal output, `--json` output, CI logs, and agents. This covers:

- the recipe, `.calavera/state.json`, `.calavera/artifacts.lock.json`, the artifact transaction journal, and `package.json`, in `doctor`, the `artifacts` commands, `apply` and `update` with a recipe inside or outside the project, `--new --config`, and the `inspect_project` finding for an invalid `package.json`;
- `.claude/settings.json`, in the `doctor` warning and the `apply` conflict;
- `.mcp.json`, `.cursor/mcp.json`, and `opencode.json`, when the `--init` bootstrap writes the Calavera MCP entry;
- `.github/repository-controls.json`, in the generated `scripts/repository-controls.mjs`, which also no longer prints the parser's error as the cause.

When the project's `vp fmt` fails or returns text that does not hold what Calavera sent, the error no longer quotes `vp fmt`'s output, the formatted text, or the line Calavera sent, and no longer keeps the raw process result as its cause. `vp fmt` quotes the file it cannot parse, and `vite.config.ts` can print anything, such as values from `.env`. Each error now names the file, the kind of failure, and a remedy that fits it: an exit code, a signal, output that outgrew the buffer, or a process that did not start (check that `vite.config.ts` loads, which `vp fmt --check` reports); a timeout; formatted Markdown that does not start with the first line Calavera sent, or formatted JSON that is not JSON (something such as `vite.config.ts` printed into it); and formatted Markdown that ends after the first line, or formatted JSON that holds other values (the formatter lost or changed what Calavera sent).

None of these messages quotes the file, with or without `CALAVERA_DEBUG`. A missing or unreadable file still fails with its own error, such as `ENOENT` or `EISDIR`, and `--new --config` now reports a recipe that is not valid JSON separately from one that is not a valid recipe (#1157).
