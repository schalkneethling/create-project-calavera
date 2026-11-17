// The Composer registers its WebMCP tools in the browser, so tests cannot list them through a
// client the way they list the MCP server's tools. They read the registrations from the source.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const composerScriptUrl = new URL("../../../apps/composer/script.js", import.meta.url);

/**
 * The tool names that `script` passes to `registerTool`, in registration order. The names are
 * read only when `name` is the first key of the object literal, so a registration written any
 * other way fails the count check instead of disappearing from the result.
 *
 * @param {string} script
 * @returns {string[]}
 */
export function registeredToolNamesIn(script) {
  const names = [...script.matchAll(/registerTool\(\{\s*name: "([^"]+)"/g)].map(
    (match) => match[1],
  );
  const calls = script.match(/registerTool\(/g) ?? [];
  assert.equal(
    names.length,
    calls.length,
    'Every registerTool call must pass an object literal whose first key is name: "<tool>"',
  );
  return names;
}

/**
 * The tool names the Composer passes to `navigator.modelContext.registerTool`, in registration
 * order.
 *
 * @returns {Promise<string[]>}
 */
export async function composerRegisteredToolNames() {
  return registeredToolNamesIn(await readFile(composerScriptUrl, "utf8"));
}
