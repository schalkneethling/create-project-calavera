---
"create-project-calavera": minor
---

`create-project-calavera` now declares the Node.js versions it supports in `engines.node`: `^22.18.0 || ^24.11.0 || >=26.0.0`, the same range Vite+ 1.0.0 requires and `--new` already relies on. On a Node.js version outside that range, `create-project-calavera` and `create-project-calavera-mcp` print one line that names the required range and exit with a non-zero code. This refuses Node.js 22.0 to 22.17, 23, 24.0 to 24.10, and 25, some of which ran the CLI before, for example `--help` on Node.js 22.16. Older versions, such as Node.js 20, previously crashed while loading the CLI with an error that did not name the cause. Prereleases, such as nightlies and release candidates, of a supported line are accepted.

The package's bin entries now point at `bin/create-project-calavera.js` and `bin/create-project-calavera-mcp.js`, which check the version before they load the CLI; the commands keep their names. The `--new` confirmation no longer lists the Vite+ Node.js requirement, and its hard stop no longer explains a Node.js below that requirement, because the bin now refuses such a Node.js before `--new` runs.

In the package's `src/index.js` module export, `nodeMeetsVitePlusFloor` is removed, and `runCli`, which runs the CLI with the process arguments, is added.
