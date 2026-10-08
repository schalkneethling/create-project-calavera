---
"create-project-calavera": minor
---

A CLI or MCP error now shows its underlying cause. The CLI prints the error message, then each cause on a line that starts with `Caused by:`, with the error's name in front when it is not plain `Error`, and no stack trace. A cause whose whole message an earlier message already contains is left out, and so is any line of a cause that equals a line already shown, so text is not printed twice. A failed child process contributes its command and exit code, not its captured output again, and a cause shows at most ten lines.

An error thrown by an MCP tool handler now returns the message and its causes as JSON in the result content: `{ "error": { "name", "message", "code"?, "causes": [...] } }`. Errors the MCP SDK reports itself, such as invalid tool input or an unknown tool, stay plain text.

Before either is shown, and in the MCP server's startup error on stderr, Calavera replaces secrets with `[redacted]`: npm and GitHub tokens; Authorization, Proxy-Authorization, X-Api-Key, Cookie, and Set-Cookie header values; Bearer credentials and Basic credentials; the value after a key, query parameter, or flag that names a secret, such as `NPM_TOKEN=`, `_authToken=`, `?token=`, `"password":`, or `--token`; URL user information; and the values of environment variables whose names name a secret, such as `NPM_TOKEN` or `GH_PAT`. A secret in a variable with an innocent name cannot be recognized by its name and is redacted only when its shape is one of these.

Each way an artifact transaction is refused now has its own message instead of "Invalid artifact transaction operation."
