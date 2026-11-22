---
"create-project-calavera": patch
---

Error output no longer hides the value of an environment variable whose name ends in `_SESSION_ID`, such as `CLAUDE_CODE_SESSION_ID`, because a session ID names a session and grants no access. A temporary folder path that contains a session ID now appears unchanged. The rest of the name still decides, so `SESSION_TOKEN`, `SESSION_SECRET`, `SESSION_COOKIE`, `AWS_SESSION_TOKEN`, and `GITHUB_TOKEN_SESSION_ID` keep their values hidden (#1191).
