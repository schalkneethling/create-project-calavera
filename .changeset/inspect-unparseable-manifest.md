---
"create-project-calavera": patch
---

`inspect_project` no longer rejects when `package.json` does not parse. It returns a `package-json-unparseable` finding with severity `error`, `path` set to `package.json`, and the parse error in the message, and it still reports findings that do not depend on the manifest, such as multiple lockfiles. Apply is unchanged and still stops on a broken manifest.
