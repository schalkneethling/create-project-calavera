---
"create-project-calavera": major
---

The CLI and the MCP server now require Node.js `^24.15.0 || >=26.0.0`. Node.js 24.11 to 24.14 are no longer supported, because pacote 22 and the npm and Sigstore packages it depends on require Node.js 24.15 or later on the Node.js 24 line. Calavera 5.0.x already depends on pacote 22, so this corrects a range that claimed support those dependencies do not have. On Node.js 24.11 to 24.14, both commands print the required range and exit with a non-zero code. Upgrade to Node.js 24.15 or later before updating Calavera.
