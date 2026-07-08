// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { fileExists, writeJSON } from "./fs.js";
import { isPlainObject } from "./guards.js";

/**
 * @typedef {{ command: string, args: string[] }} McpLaunchCommand
 * @typedef {"claude-code" | "codex" | "cursor" | "opencode" | "skip"} McpHarness
 * @typedef {"write" | "update" | "skip"} McpConfigAction
 * @typedef {{ type: string, path: string, reason?: string }} McpConfigChange
 */

/**
 * @param {unknown} value
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function assertJsonObjectConfig(value, path) {
  if (!isPlainObject(value)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  return /** @type {Record<string, unknown>} */ (value);
}

/**
 * @param {string} path
 * @returns {string}
 */
function normalizeConfigPath(path) {
  const targetPath = path.trim();

  if (!targetPath) {
    throw new Error("MCP config path must be a non-empty string.");
  }

  return targetPath;
}

/**
 * @param {string} path
 * @returns {Promise<{ currentConfig: Record<string, unknown>, currentContents?: string }>}
 */
async function readProjectJsonConfigIfPresent(path) {
  if (!(await fileExists(path))) {
    return { currentConfig: {} };
  }

  const currentContents = await readFile(path, "utf8");
  return {
    currentConfig: assertJsonObjectConfig(JSON.parse(currentContents), path),
    currentContents,
  };
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} nextConfig
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @param {string} [currentContents]
 * @returns {Promise<McpConfigAction>}
 */
async function writeProjectJsonConfig(path, nextConfig, dryRun, changes, currentContents) {
  const targetPath = normalizeConfigPath(path);

  if (currentContents === undefined) {
    changes.push({ type: "write", path: targetPath });

    if (!dryRun) {
      const directory = dirname(targetPath).trim();
      if (directory !== ".") {
        await mkdir(directory, { recursive: true });
      }
      await writeJSON(targetPath, nextConfig, false);
    }

    return "write";
  }

  const nextContents = `${JSON.stringify(nextConfig, null, 2)}\n`;

  if (currentContents === nextContents) {
    changes.push({ type: "skip", path: targetPath, reason: "Already up to date." });
    return "skip";
  }

  changes.push({ type: "update", path: targetPath, reason: "Add or update Calavera MCP server." });

  if (!dryRun) {
    await writeFile(targetPath, nextContents);
  }

  return "update";
}

/**
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
export function createMcpServersJsonConfig(launchCommand) {
  return {
    mcpServers: {
      calavera: launchCommand,
    },
  };
}

/**
 * @param {string} path
 * @param {McpLaunchCommand} launchCommand
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @returns {Promise<McpConfigAction>}
 */
export async function writeMcpServersJsonConfig(path, launchCommand, dryRun, changes) {
  const targetPath = normalizeConfigPath(path);
  const { currentConfig, currentContents } = await readProjectJsonConfigIfPresent(targetPath);
  const mcpServers = currentConfig.mcpServers;

  if (mcpServers !== undefined && !isPlainObject(mcpServers)) {
    throw new Error(`${targetPath} mcpServers must be an object.`);
  }

  return writeProjectJsonConfig(
    targetPath,
    {
      ...currentConfig,
      mcpServers: {
        ...(isPlainObject(mcpServers) ? mcpServers : {}),
        calavera: launchCommand,
      },
    },
    dryRun,
    changes,
    currentContents,
  );
}

/**
 * @param {string} value
 * @returns {string}
 */
function tomlString(value) {
  return JSON.stringify(value);
}

/**
 * @param {string[]} values
 * @returns {string}
 */
function tomlStringArray(values) {
  return `[${values.map(tomlString).join(", ")}]`;
}

/**
 * @param {McpLaunchCommand} launchCommand
 * @returns {string}
 */
export function createCodexMcpTomlBlock(launchCommand) {
  return [
    "[mcp_servers.calavera]",
    `command = ${tomlString(launchCommand.command)}`,
    `args = ${tomlStringArray(launchCommand.args)}`,
    "",
  ].join("\n");
}

/**
 * @param {string} contents
 * @param {string} header
 * @returns {{ start: number, end: number } | undefined}
 */
function findTomlTableRange(contents, header) {
  const lines = contents.split("\n");
  const start = lines.findIndex((line) => line.trim() === header);

  if (start === -1) {
    return undefined;
  }

  const nextHeaderOffset = lines
    .slice(start + 1)
    .findIndex((line) => line.trim().startsWith("[") && line.trim().endsWith("]"));

  return {
    start,
    end: nextHeaderOffset === -1 ? lines.length : start + 1 + nextHeaderOffset,
  };
}

/**
 * @param {string} path
 * @param {McpLaunchCommand} launchCommand
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @returns {Promise<McpConfigAction>}
 */
export async function writeCodexMcpConfig(path, launchCommand, dryRun, changes) {
  const targetPath = normalizeConfigPath(path);
  const block = createCodexMcpTomlBlock(launchCommand);

  if (!(await fileExists(targetPath))) {
    changes.push({ type: "write", path: targetPath });

    if (!dryRun) {
      const directory = dirname(targetPath).trim();
      if (directory !== ".") {
        await mkdir(directory, { recursive: true });
      }
      await writeFile(targetPath, block);
    }

    return "write";
  }

  const contents = await readFile(targetPath, "utf8");
  const range = findTomlTableRange(contents, "[mcp_servers.calavera]");
  const nextContents = range
    ? [
        ...contents.split("\n").slice(0, range.start),
        block.trimEnd(),
        ...contents.split("\n").slice(range.end),
      ].join("\n")
    : `${contents.trimEnd()}\n\n${block}`;

  if (nextContents === contents) {
    changes.push({ type: "skip", path: targetPath, reason: "Already up to date." });
    return "skip";
  }

  changes.push({ type: "update", path: targetPath, reason: "Add or update Calavera MCP server." });

  if (!dryRun) {
    await writeFile(targetPath, nextContents.endsWith("\n") ? nextContents : `${nextContents}\n`);
  }

  return "update";
}

/**
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
export function createOpenCodeMcpJsonConfig(launchCommand) {
  return {
    $schema: "https://opencode.ai/config.json",
    mcp: {
      calavera: {
        type: "local",
        command: [launchCommand.command, ...launchCommand.args],
        enabled: true,
      },
    },
  };
}

/**
 * @param {string} path
 * @param {McpLaunchCommand} launchCommand
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @returns {Promise<McpConfigAction>}
 */
export async function writeOpenCodeMcpConfig(path, launchCommand, dryRun, changes) {
  const targetPath = normalizeConfigPath(path);
  const { currentConfig, currentContents } = await readProjectJsonConfigIfPresent(targetPath);
  const mcp = currentConfig.mcp;

  if (mcp !== undefined && !isPlainObject(mcp)) {
    throw new Error(`${targetPath} mcp must be an object.`);
  }

  return writeProjectJsonConfig(
    targetPath,
    {
      ...currentConfig,
      $schema:
        typeof currentConfig.$schema === "string"
          ? currentConfig.$schema
          : "https://opencode.ai/config.json",
      mcp: {
        ...(isPlainObject(mcp) ? mcp : {}),
        calavera: {
          type: "local",
          command: [launchCommand.command, ...launchCommand.args],
          enabled: true,
        },
      },
    },
    dryRun,
    changes,
    currentContents,
  );
}

/**
 * @param {McpHarness} harness
 * @returns {string | undefined}
 */
export function projectMcpConfigPath(harness) {
  switch (harness) {
    case "claude-code":
      return ".mcp.json";
    case "codex":
      return ".codex/config.toml";
    case "cursor":
      return ".cursor/mcp.json";
    case "opencode":
      return "opencode.json";
    default:
      return undefined;
  }
}
