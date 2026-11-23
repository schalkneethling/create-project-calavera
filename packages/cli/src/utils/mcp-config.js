// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { TomlError, parse as parseToml } from "smol-toml";

import { normalizePinnedVersion, normalizeReleasedPin } from "./earlier-guidance.js";
import { fileExists, parseJSON } from "./fs.js";
import { formatGeneratedText } from "./generated-text.js";
import { repeatedKeyProblem } from "./json-rewrite.js";
import { isPlainObject } from "./guards.js";

/**
 * @typedef {() => Promise<import("./project-formatter.js").ProjectFormatter>} LoadFormatter
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
    currentConfig: assertJsonObjectConfig(parseJSON(currentContents, path), path),
    currentContents,
  };
}

/**
 * Writes `nextConfig` as the text the project's formatter produces, so a Vite+ project's
 * `vp check` accepts the file and a second run finds it up to date (#669).
 *
 * @param {string} path
 * @param {Record<string, unknown>} nextConfig
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @param {LoadFormatter} loadFormatter
 * @param {string} [currentContents]
 * @returns {Promise<McpConfigAction>}
 */
async function writeProjectJsonConfig(
  path,
  nextConfig,
  dryRun,
  changes,
  loadFormatter,
  currentContents,
) {
  const targetPath = normalizeConfigPath(path);
  const nextContents = await formatGeneratedText(
    targetPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
    loadFormatter,
  );

  if (currentContents === undefined) {
    changes.push({ type: "write", path: targetPath });

    if (!dryRun) {
      const directory = dirname(targetPath).trim();
      if (directory !== ".") {
        await mkdir(directory, { recursive: true });
      }
      await writeFile(targetPath, nextContents);
    }

    return "write";
  }

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
 * The `calavera` entry in `.cursor/mcp.json`. Cursor's documentation lists `type` as required for
 * a local server, with the value `"stdio"` (https://cursor.com/docs/context/mcp, "STDIO server
 * configuration"). 6.2.1 and earlier releases wrote the launch command alone, which
 * `createMcpServersJsonConfig` still writes for Claude Code (#1089).
 *
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
export function createCursorMcpEntry(launchCommand) {
  return { type: "stdio", ...launchCommand };
}

/**
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
export function createCursorMcpJsonConfig(launchCommand) {
  return {
    mcpServers: {
      calavera: createCursorMcpEntry(launchCommand),
    },
  };
}

/**
 * The value with the version it pins in `create-project-calavera@<version>` replaced by the
 * placeholder `findEarlierGuidance` uses, or undefined when it already holds the placeholder,
 * which no release wrote.
 *
 * @param {unknown} value A value parsed from JSON or TOML.
 */
function withPinNormalized(value) {
  const pinned = normalizePinnedVersion(JSON.stringify(value));
  return pinned === undefined ? undefined : JSON.parse(pinned.normalized);
}

/**
 * The `calavera` entries a Calavera release wrote into the harness file, one for each package
 * manager's launch command, as the file parses. `eject` removes an entry, and `--init` updates
 * one, only when it equals one of them with the pinned version normalized and that version is
 * one Calavera released (ADR-0017, Decision 2 and Amendment 6; #1205, #1219). An entry shape an earlier release wrote belongs here too, so both keep recognizing it.
 *
 * @param {Exclude<McpHarness, "skip">} harness
 * @param {McpLaunchCommand[]} launches The launch command for each supported package manager.
 * @returns {unknown[]}
 */
export function calaveraMcpEntries(harness, launches) {
  switch (harness) {
    case "opencode":
      return launches.map(
        (launch) =>
          /** @type {{ mcp: Record<string, unknown> }} */ (createOpenCodeMcpJsonConfig(launch)).mcp
            .calavera,
      );
    case "codex":
      // The table `createCodexMcpTomlBlock` writes parses to the launch command.
      return launches.map(({ command, args }) => ({ command, args }));
    case "cursor":
      // 6.2.1 and earlier releases wrote the launch command alone, without `type` (#1089).
      return [
        ...launches.map(createCursorMcpEntry),
        ...launches.map(
          (launch) =>
            /** @type {{ mcpServers: Record<string, unknown> }} */ (
              createMcpServersJsonConfig(launch)
            ).mcpServers.calavera,
        ),
      ];
    default:
      return launches.map(
        (launch) =>
          /** @type {{ mcpServers: Record<string, unknown> }} */ (
            createMcpServersJsonConfig(launch)
          ).mcpServers.calavera,
      );
  }
}

/**
 * Whether `entry` is one a Calavera release wrote: it pins a version the release table lists
 * (`normalizeReleasedPin`, #1219),
 * and it equals one of `entries` with the pinned version normalized. Any other entry is a local
 * edit, such as one pinned to an unpublished version, one without a pin, or one that holds the
 * placeholder.
 *
 * @param {unknown} entry
 * @param {unknown[]} entries From `calaveraMcpEntries`.
 */
export function isCalaveraMcpEntry(entry, entries) {
  const released = normalizeReleasedPin(JSON.stringify(entry));
  if (released === undefined) return false;
  const normalized = JSON.parse(released);
  return entries.some((candidate) => isDeepStrictEqual(normalized, withPinNormalized(candidate)));
}

/**
 * Whether `entry` would be one a Calavera release wrote but for its pinned version, which is not
 * one Calavera released (#1219). `--init` and `eject` then name the pin as the reason they keep
 * the entry, without quoting it, because it is text from the person's file.
 *
 * @param {unknown} entry
 * @param {unknown[]} entries From `calaveraMcpEntries`.
 */
export function pinsUnreleasedVersion(entry, entries) {
  if (isCalaveraMcpEntry(entry, entries)) return false;
  // An entry that holds the placeholder normalizes to undefined, which equals no candidate.
  const normalized = withPinNormalized(entry);
  return entries.some((candidate) => isDeepStrictEqual(normalized, withPinNormalized(candidate)));
}

/** How `--init` and `eject` say that an entry pins a version Calavera never released. */
export const UNRELEASED_PIN =
  "pins a version of create-project-calavera that Calavera never released";

/**
 * The change for a harness file whose `calavera` entry is a local edit, which `--init` keeps
 * (brief C8), with what to do to get Calavera's entry instead.
 *
 * @param {string} path
 * @param {string} entry How the entry is named in the file, such as "The calavera entry under mcp".
 * @param {boolean} unreleased Whether the entry differs only in pinning an unreleased version.
 * @returns {McpConfigChange}
 */
function editedEntryChange(path, entry, unreleased) {
  const why = unreleased ? UNRELEASED_PIN : "differs from every entry a Calavera release wrote";
  return {
    type: "skip",
    path,
    reason: `${entry} in ${path} ${why}, so it was left unchanged as a local edit. To use Calavera's entry instead, remove yours, then run --init again.`,
  };
}

/**
 * The change for a JSON harness file that repeats a key in one object, such as a second `calavera`
 * entry: JSON.parse keeps only the last value, so a rewrite would drop the person's entry. The file
 * is kept as a local edit, as `eject` keeps it (`rewriteLossProblem`).
 *
 * @param {string} path
 * @param {string | undefined} currentContents
 * @returns {McpConfigChange | undefined}
 */
function repeatedKeyChange(path, currentContents) {
  const problem = currentContents === undefined ? undefined : repeatedKeyProblem(currentContents);
  return problem === undefined
    ? undefined
    : {
        type: "skip",
        path,
        reason: `${path} ${problem}, so it was left unchanged as a local edit. Remove the repeated key, then run --init again.`,
      };
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} entry The `calavera` entry to write.
 * @param {unknown[]} entries The entries a Calavera release wrote, from `calaveraMcpEntries`.
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @param {LoadFormatter} loadFormatter
 * @returns {Promise<McpConfigAction>}
 */
export async function writeMcpServersJsonConfig(
  path,
  entry,
  entries,
  dryRun,
  changes,
  loadFormatter,
) {
  const targetPath = normalizeConfigPath(path);
  const { currentConfig, currentContents } = await readProjectJsonConfigIfPresent(targetPath);
  const mcpServers = currentConfig.mcpServers;

  if (mcpServers !== undefined && !isPlainObject(mcpServers)) {
    throw new Error(`${targetPath} mcpServers must be an object.`);
  }

  const repeated = repeatedKeyChange(targetPath, currentContents);
  if (repeated) {
    changes.push(repeated);
    return "skip";
  }

  if (
    isPlainObject(mcpServers) &&
    Object.hasOwn(mcpServers, "calavera") &&
    !isCalaveraMcpEntry(mcpServers.calavera, entries)
  ) {
    changes.push(
      editedEntryChange(
        targetPath,
        "The calavera entry under mcpServers",
        pinsUnreleasedVersion(mcpServers.calavera, entries),
      ),
    );
    return "skip";
  }

  return writeProjectJsonConfig(
    targetPath,
    {
      ...currentConfig,
      mcpServers: {
        ...(isPlainObject(mcpServers) ? mcpServers : {}),
        calavera: entry,
      },
    },
    dryRun,
    changes,
    loadFormatter,
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
 * Where smol-toml stopped, as "<prefix>line L, column C", or nothing when the error is not
 * smol-toml's and has no position. Never the parser's message, which quotes the file.
 *
 * @param {unknown} error
 * @param {string} prefix
 */
export function tomlPosition(error, prefix) {
  return error instanceof TomlError ? `${prefix}line ${error.line}, column ${error.column}` : "";
}

const CODEX_TABLE_HEADER = "[mcp_servers.calavera]";

/**
 * The lines of the `calavera` entry in a Codex config when it is one a Calavera release wrote, or
 * undefined when it is a local edit. Calavera's entry starts with exactly the lines
 * `createCodexMcpTomlBlock` writes for one of `entries`, with the pinned version normalized, and
 * the parsed entry holds nothing else, such as a key or a subtable added further down. Any other
 * entry is a local edit, such as one with a comment inside the table, an inline table, or another
 * header spelling: rewriting Calavera's lines would lose it or leave part of it behind. Blank lines
 * and comments after Calavera's lines are not part of the entry, so they stay.
 *
 * @param {string[]} lines The file's lines.
 * @param {unknown} entry The parsed `mcp_servers.calavera` value.
 * @param {unknown[]} entries From `calaveraMcpEntries`.
 * @returns {{ start: number, end: number } | undefined} `end` is exclusive.
 */
function findCalaveraCodexLines(lines, entry, entries) {
  if (!isCalaveraMcpEntry(entry, entries)) return undefined;
  const range = findTomlTableRange(lines.join("\n"), CODEX_TABLE_HEADER);
  if (range === undefined) return undefined;
  // `findTomlTableRange` trims each line, which drops a byte order mark, so it goes here too.
  const bare = lines.map((line, index) =>
    (index === 0 ? line.replace(/^\uFEFF/, "") : line).replace(/\r$/, ""),
  );
  for (const candidate of entries) {
    const written = createCodexMcpTomlBlock(/** @type {McpLaunchCommand} */ (candidate))
      .trimEnd()
      .split("\n");
    const end = range.start + written.length;
    // Past the table's end the lines hold the next header, which no written line equals.
    if (
      normalizePinnedVersion(bare.slice(range.start, end).join("\n"))?.normalized ===
      normalizePinnedVersion(written.join("\n"))?.normalized
    ) {
      return { start: range.start, end };
    }
  }
  return undefined;
}

/**
 * Whether `nextContents` parses to `config` with only `mcp_servers.calavera` set to the launch
 * command.
 *
 * @param {string} nextContents
 * @param {Record<string, unknown>} config The file's settings before the change.
 * @param {McpLaunchCommand} launchCommand
 */
function isCalaveraEntrySetIn(nextContents, config, launchCommand) {
  /** @type {Record<string, unknown>} */
  let next;
  try {
    next = parseToml(nextContents);
  } catch {
    return false;
  }
  const servers = isPlainObject(config.mcp_servers) ? config.mcp_servers : {};
  // smol-toml builds tables without a prototype, which `isDeepStrictEqual` tells apart from a
  // literal, so both sides are compared as JSON. Dates compare by their text.
  /** @param {unknown} value */
  const plain = (value) => JSON.parse(JSON.stringify(value));
  return isDeepStrictEqual(
    plain(next),
    plain({
      ...config,
      mcp_servers: {
        ...servers,
        calavera: { command: launchCommand.command, args: launchCommand.args },
      },
    }),
  );
}

/**
 * @param {string} path
 * @param {McpLaunchCommand} launchCommand
 * @param {unknown[]} entries The entries a Calavera release wrote, from `calaveraMcpEntries`.
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @returns {Promise<McpConfigAction>}
 */
export async function writeCodexMcpConfig(path, launchCommand, entries, dryRun, changes) {
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
  /** @type {Record<string, unknown>} */
  let config;
  try {
    config = parseToml(contents);
  } catch (error) {
    // Never smol-toml's own error: its message carries a code frame of the file's lines, which
    // can hold a token. Without parsing, an edited entry cannot be told from Calavera's.
    throw new Error(`${targetPath} cannot be parsed as TOML${tomlPosition(error, " at ")}.`);
  }
  const servers = config.mcp_servers;

  if (servers !== undefined && !isPlainObject(servers)) {
    throw new Error(`${targetPath} mcp_servers must be a table.`);
  }

  const lines = contents.split("\n");
  /** @type {{ start: number, end: number } | undefined} */
  let written;

  if (isPlainObject(servers) && Object.hasOwn(servers, "calavera")) {
    written = findCalaveraCodexLines(lines, servers.calavera, entries);

    if (written === undefined) {
      changes.push(
        editedEntryChange(
          targetPath,
          `The ${CODEX_TABLE_HEADER} table`,
          pinsUnreleasedVersion(servers.calavera, entries),
        ),
      );
      return "skip";
    }
  }

  // Calavera's lines keep the file's line endings, so a file with Windows line endings keeps them,
  // and a byte order mark before them stays.
  const crlf = written ? lines[written.start]?.endsWith("\r") : contents.includes("\r\n");
  const eol = crlf ? "\r\n" : "\n";
  const blockLines = block.trimEnd().split("\n");
  /** @type {string} */
  let nextContents;
  if (written) {
    const bom = written.start === 0 && contents.startsWith("\uFEFF") ? "\uFEFF" : "";
    nextContents = [
      ...lines.slice(0, written.start),
      ...blockLines.map((line, index) => `${index === 0 ? bom : ""}${line}${crlf ? "\r" : ""}`),
      ...lines.slice(written.end),
    ].join("\n");
  } else {
    // The table goes after one blank line, and the file's own trailing blank lines stay.
    const separator =
      contents === "" || contents.endsWith(`${eol}${eol}`)
        ? ""
        : contents.endsWith(eol)
          ? eol
          : `${eol}${eol}`;
    nextContents = `${contents}${separator}${blockLines.join(eol)}${eol}`;
  }

  // The result must hold the same settings with Calavera's entry set, and nothing else changed.
  // Text that only looks like the table, such as lines inside a multi-line string, or a
  // `mcp_servers` inline table that a new table header cannot extend, fails this check.
  if (!isCalaveraEntrySetIn(nextContents, config, launchCommand)) {
    throw new Error(
      `${targetPath} cannot take Calavera's ${CODEX_TABLE_HEADER} table without changing other settings in the file, so it was left unchanged.`,
    );
  }

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
 * The `$schema` Calavera writes into `opencode.json` when the file has none. `eject` removes a
 * `$schema` with this value once nothing else remains in the file (ADR-0017, Decision 2).
 */
export const OPENCODE_CONFIG_SCHEMA = "https://opencode.ai/config.json";

/**
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
export function createOpenCodeMcpJsonConfig(launchCommand) {
  return {
    $schema: OPENCODE_CONFIG_SCHEMA,
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
 * @param {unknown[]} entries The entries a Calavera release wrote, from `calaveraMcpEntries`.
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @param {LoadFormatter} loadFormatter
 * @returns {Promise<McpConfigAction>}
 */
export async function writeOpenCodeMcpConfig(
  path,
  launchCommand,
  entries,
  dryRun,
  changes,
  loadFormatter,
) {
  const targetPath = normalizeConfigPath(path);
  const { currentConfig, currentContents } = await readProjectJsonConfigIfPresent(targetPath);
  const mcp = currentConfig.mcp;

  if (mcp !== undefined && !isPlainObject(mcp)) {
    throw new Error(`${targetPath} mcp must be an object.`);
  }

  const repeated = repeatedKeyChange(targetPath, currentContents);
  if (repeated) {
    changes.push(repeated);
    return "skip";
  }

  if (
    isPlainObject(mcp) &&
    Object.hasOwn(mcp, "calavera") &&
    !isCalaveraMcpEntry(mcp.calavera, entries)
  ) {
    changes.push(
      editedEntryChange(
        targetPath,
        "The calavera entry under mcp",
        pinsUnreleasedVersion(mcp.calavera, entries),
      ),
    );
    return "skip";
  }

  return writeProjectJsonConfig(
    targetPath,
    {
      ...currentConfig,
      $schema:
        typeof currentConfig.$schema === "string" ? currentConfig.$schema : OPENCODE_CONFIG_SCHEMA,
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
    loadFormatter,
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
