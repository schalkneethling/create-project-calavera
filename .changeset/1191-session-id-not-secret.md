---
"create-project-calavera": patch
---

Error output no longer hides the value of the `CLAUDE_CODE_SESSION_ID` environment variable, because it names a session and grants no access. A temporary folder path that contains that session ID now appears unchanged. Only session identifiers known not to be secret are shown, each listed by its exact name; every other environment variable whose name ends in `_SESSION_ID`, such as `APP_SESSION_ID` or `SESSION_ID`, still has its value hidden, because it can hold a web session cookie. Session tokens, secrets, and cookies stay hidden, and so does a session ID that appears as a keyed value in text, such as `CLAUDE_CODE_SESSION_ID=value` (#1191).
