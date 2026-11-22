---
"create-project-calavera": patch
---

Every error that stops `apply` from updating `.coderabbit.yaml` now starts with `Cannot update .coderabbit.yaml:` (#1083):

- A top-level list or scalar now gives `the top level must be a mapping.` instead of a message from the `yaml` package's document API that did not name the file.
- An alias whose anchor is missing or comes after it now gives the line and column instead of a message from the YAML writer that quoted the alias name. Any other failure of the YAML writer names the file and the error type, without the writer's message, because it can quote anchor names from the file.
- An anchored `reviews` mapping or `path_filters` list now gives the line and column where its value starts instead of the anchor's name.
- A file that cannot be read or written names the file and the error code.
- A YAML syntax error names the line, the column, and the parser's error code for each problem, but no longer quotes the lines around the error, so a secret written in the file cannot reach terminal output or CI logs.

An update now keeps Windows line endings (`\r\n`) in a file that uses them, instead of converting the whole file to Unix line endings (`\n`). A file that uses both kinds gets Windows line endings on every line. An update also keeps a byte order mark at the start of the file. A file that already holds every filter is no longer rewritten, so its line endings, spacing, and byte order mark stay exactly as they were.
