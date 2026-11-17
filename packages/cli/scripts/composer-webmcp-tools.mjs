// The Composer registers its WebMCP tools in the browser, so tests cannot list them through a
// client the way they list the MCP server's tools. They read the registrations from the source.
import { readFile } from "node:fs/promises";

const composerScriptUrl = new URL("../../../apps/composer/script.js", import.meta.url);

/**
 * The tool names the Composer passes to `navigator.modelContext.registerTool`, in registration
 * order.
 *
 * @returns {Promise<string[]>}
 */
export async function composerRegisteredToolNames() {
  const script = await readFile(composerScriptUrl, "utf8");
  return [...script.matchAll(/registerTool\(\{\s*name: "([^"]+)"/g)].map((match) => match[1]);
}
