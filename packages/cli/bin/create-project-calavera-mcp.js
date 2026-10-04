#!/usr/bin/env node
// @ts-check
// Static imports load before any module code runs, so the MCP server is
// imported only after the Node.js version check passes. There is no top-level
// await, so the check also runs on Node.js versions that do not support it.
import { startOnSupportedNode } from "../src/node-engine.js";

startOnSupportedNode("create-project-calavera-mcp", () =>
  import("../src/mcp.js").then(({ runMcpEntrypoint }) => runMcpEntrypoint()),
);
