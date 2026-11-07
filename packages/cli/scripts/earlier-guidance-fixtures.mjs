// Shared by the tests for issue #830: the texts earlier Calavera releases wrote, committed as
// fixtures in fixtures/agent-guidance, and the text this checkout writes.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { agentBootstrap } from "../src/index.js";

export const fixtureDirectory = fileURLToPath(
  new URL("../fixtures/agent-guidance/", import.meta.url),
);
/** @type {{ guidance: { id: string, releases: string[] }[], mcp: { id: string, releases: string[], pinned: boolean }[] }} */
export const epochs = JSON.parse(await readFile(join(fixtureDirectory, "epochs.json"), "utf8"));
export const packageManagers = /** @type {const} */ (["npm", "pnpm", "yarn", "bun"]);

export const MCP_FILE = ".agents/calavera/mcp.md";
export const FALLBACK_FILE = "AGENTS.calavera.md";
export const EXISTING_AGENTS = "# Project guidance\n\nKeep it small.\n";

/** Text of a release's `AGENTS.md`, which is also its `AGENTS.calavera.md`. */
export async function guidanceText(id) {
  return readFile(join(fixtureDirectory, "guidance", `${id}.md`), "utf8");
}

/** Text of a release's `.agents/calavera/mcp.md`, written with the version `release` where it pins one. */
export async function mcpText(id, packageManager, release) {
  const text = await readFile(join(fixtureDirectory, "mcp", `${id}.${packageManager}.md`), "utf8");
  return text.replaceAll("{{version}}", release);
}

/** The epochs before the last one, which is the text this checkout writes. */
export const olderGuidanceEpochs = epochs.guidance.slice(0, -1);

/**
 * Runs `callback` in a fresh temporary project that names its package manager.
 *
 * @template T
 * @param {string} packageManager
 * @param {(directory: string) => Promise<T>} callback
 * @returns {Promise<T>}
 */
export async function inTemporaryProject(packageManager, callback) {
  const previous = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "calavera-earlier-guidance-"));
  await writeFile(
    join(directory, "package.json"),
    `${JSON.stringify({ name: "project", packageManager: `${packageManager}@1.0.0` })}\n`,
  );
  process.chdir(directory);
  try {
    return await callback(directory);
  } finally {
    process.chdir(previous);
    await rm(directory, { recursive: true, force: true });
  }
}

/** Writes `files` into the project directory, creating folders. */
export async function writeFiles(directory, files) {
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), contents);
  }
}

/**
 * The text this checkout writes for each guidance file in a project that does not use Vite+, taken
 * from real runs so the tests do not restate the template.
 *
 * @param {string} packageManager
 */
export async function currentText(packageManager) {
  return inTemporaryProject(packageManager, async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager });
    const agents = await readFile("AGENTS.md", "utf8");
    const mcp = await readFile(MCP_FILE, "utf8");
    await rm("AGENTS.md");
    await writeFile("AGENTS.md", EXISTING_AGENTS);
    await agentBootstrap({ mcpHarness: "skip", packageManager, agentsMd: "fallback" });
    return { agents, mcp, fallback: await readFile(FALLBACK_FILE, "utf8") };
  });
}
