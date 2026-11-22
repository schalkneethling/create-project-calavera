---
"create-project-calavera": patch
---

Every error that stops `apply` from updating `.coderabbit.yaml` now starts with `Cannot update .coderabbit.yaml:`. A top-level list or scalar now gives `the top level must be a mapping.` instead of a message from the YAML parser that did not name the file, and a file that cannot be read names the file and the error code. A YAML syntax error now names the line, the column, and the parser's error code for each problem, but no longer quotes the lines around the error, so a secret written in the file cannot reach terminal output or CI logs. An update also keeps Windows line endings (`\r\n`) in a file that uses them, instead of converting the whole file to Unix line endings (`\n`), and a file with Windows line endings that already holds every filter is no longer rewritten (#1083).
