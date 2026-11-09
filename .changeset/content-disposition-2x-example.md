---
"@schalkneethling/calavera-skill-frontend-security": patch
---

Update the "Secure File Serving" example in the frontend-security skill to the content-disposition 2.x API. The example now imports the named `create` export and reduces the display name to a bare file name with `path.win32.basename` before the call, because content-disposition 2.x no longer strips path segments.
