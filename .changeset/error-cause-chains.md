---
"create-project-calavera": minor
---

A CLI or MCP error now shows its underlying cause. The CLI prints the error message, then each cause on a line that starts with `Caused by:`, and leaves out any line a message above it already shows, so a cause is never printed twice. An MCP tool error returns the message and its causes as JSON in the result content, `{ "error": { "name", "message", "code"?, "causes": [...] } }`. Before either is shown, Calavera replaces secrets with `[redacted]`: npm and GitHub tokens, Authorization header values and Bearer or Basic credentials, `.npmrc` keys such as `_authToken=`, URL user information, and the values of environment variables whose names name a secret, such as `NPM_TOKEN`. Each way an artifact transaction is refused now has its own message instead of "Invalid artifact transaction operation."
