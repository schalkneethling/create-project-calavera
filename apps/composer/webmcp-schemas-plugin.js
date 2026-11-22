// #1051, owner decision of 2026-11-22: the Composer registers the WebMCP JSON Schemas that the core
// generates from its shared tool definitions (ADR-0018, Decision 2). They are generated when Vite
// builds or serves the page, in Node.js, so Zod stays out of the browser bundle and no generated
// copy is stored where it could go stale.
import { webMcpToolSchemas } from "../../packages/cli/src/tool-schemas.js";

const WEBMCP_SCHEMAS_MODULE = "virtual:webmcp-tool-schemas";
// The \0 prefix tells Vite and other plugins that the module is virtual, not a file.
const RESOLVED_WEBMCP_SCHEMAS_MODULE = `\0${WEBMCP_SCHEMAS_MODULE}`;

/** @returns {import("vite").Plugin} */
export function webMcpSchemasPlugin() {
  return {
    name: "webmcp-tool-schemas",
    resolveId(source) {
      return source === WEBMCP_SCHEMAS_MODULE ? RESOLVED_WEBMCP_SCHEMAS_MODULE : undefined;
    },
    load(id) {
      return id === RESOLVED_WEBMCP_SCHEMAS_MODULE
        ? `export default ${JSON.stringify(webMcpToolSchemas())};`
        : undefined;
    },
  };
}
