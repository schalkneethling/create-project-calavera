---
"create-project-calavera": patch
---

`inspect_project` no longer rejects when `package.json` does not parse, or parses to something other than an object, such as `null` or an array. It returns a `package-json-invalid` finding with severity `error` and `path` set to `package.json`. The message gives the parse error, or says that the file does not contain a JSON object. Inspection still reports findings that do not depend on the manifest, such as multiple lockfiles. Apply is unchanged and still stops on a broken manifest.
