// @ts-check
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";

import { parse as parseJsonc } from "jsonc-parser";
import { TomlError, parse as parseToml } from "smol-toml";

import { normalizePinnedVersion, normalizePublishedPin } from "./earlier-guidance.js";
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
 * @param {string} [updateReason] The reason of an `update` change.
 * @returns {Promise<McpConfigAction>}
 */
async function writeProjectJsonConfig(
  path,
  nextConfig,
  dryRun,
  changes,
  loadFormatter,
  currentContents,
  updateReason = "Add or update Calavera MCP server.",
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

  changes.push({ type: "update", path: targetPath, reason: updateReason });

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
 * one, only when `isCalaveraMcpEntry` finds it among them (ADR-0017, Decision 2 and Amendment 6;
 * #1205, #1219). An entry shape an earlier release wrote belongs here too, so both keep
 * recognizing it.
 *
 * @param {Exclude<McpHarness, "skip">} harness
 * @param {McpLaunchCommand[]} launches The launch command for each supported package manager.
 * @returns {unknown[]}
 */
export function calaveraMcpEntries(harness, launches) {
  switch (harness) {
    case "opencode":
      // Only the `mcp.servers` entry: the entry 6.2.1 and earlier releases wrote directly under
      // `mcp` comes from `openCodeMcpLocations`, so no writer can obtain it here (ADR-0022).
      return launches.map(createOpenCodeMcpEntry);
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
 * The version `entries` pin, which is the version this checkout writes: every launch command
 * `calaveraMcpEntries` lists pins the same one.
 *
 * @param {unknown[]} entries From `calaveraMcpEntries`.
 * @returns {string | undefined}
 */
export function writtenVersion(entries) {
  return normalizePinnedVersion(JSON.stringify(entries[0]))?.pin;
}

/**
 * Whether `entry` is one a Calavera release wrote: it pins a version npm has
 * (`normalizePublishedPin`, #1219), and it equals one of `entries` with the pinned version
 * normalized. Any other entry is a local edit, such as one pinned to an unpublished version, one
 * without a pin, or one that holds the placeholder.
 *
 * @param {unknown} entry
 * @param {unknown[]} entries From `calaveraMcpEntries`.
 */
export function isCalaveraMcpEntry(entry, entries) {
  const published = normalizePublishedPin(JSON.stringify(entry), writtenVersion(entries));
  if (published === undefined) return false;
  const normalized = JSON.parse(published);
  return entries.some((candidate) => isDeepStrictEqual(normalized, withPinNormalized(candidate)));
}

/**
 * Whether `entry` would be one a Calavera release wrote but for its pinned version, which this
 * CLI does not know as published (#1219). `--init` and `eject` then name the pin as the reason they keep the entry,
 * without quoting it, because it is text from the person's file.
 *
 * @param {unknown} entry
 * @param {unknown[]} entries From `calaveraMcpEntries`.
 */
export function pinsUnpublishedVersion(entry, entries) {
  if (isCalaveraMcpEntry(entry, entries)) return false;
  // An entry that holds the placeholder normalizes to undefined, which equals no candidate.
  const normalized = withPinNormalized(entry);
  return entries.some((candidate) => isDeepStrictEqual(normalized, withPinNormalized(candidate)));
}

/**
 * How `--init` and `eject` say that an entry pins a version this CLI does not know as published:
 * one npm does not have, or one published after this CLI, which its release list cannot name.
 */
export const UNPUBLISHED_PIN =
  "pins a version of create-project-calavera that this release of Calavera does not know as published";

/**
 * The sentence that says a harness file's `calavera` entry is a local edit, which `--init` keeps
 * (brief C8).
 *
 * @param {string} path
 * @param {string} entry How the entry is named in the file, such as "The calavera entry under mcp".
 * @param {boolean} unpublished Whether the entry differs only in pinning an unpublished version.
 */
function editedEntrySentence(path, entry, unpublished) {
  const why = unpublished ? UNPUBLISHED_PIN : "differs from every entry a Calavera release wrote";
  return `${entry} in ${path} ${why}, so it was left unchanged as a local edit.`;
}

const DEFAULT_EDITED_REMEDY =
  "To use Calavera's entry instead, remove yours, then run --init again.";

/**
 * The change for a harness file whose `calavera` entry is a local edit, which `--init` keeps
 * (brief C8), with what to do to get Calavera's entry instead.
 *
 * @param {string} path
 * @param {string} entry How the entry is named in the file, such as "The calavera entry under mcp".
 * @param {boolean} unpublished Whether the entry differs only in pinning an unpublished version.
 * @param {string} [remedy] What to do about it, when the default does not fit the location.
 * @returns {McpConfigChange}
 */
function editedEntryChange(path, entry, unpublished, remedy = DEFAULT_EDITED_REMEDY) {
  return {
    type: "skip",
    path,
    reason: `${editedEntrySentence(path, entry, unpublished)} ${remedy}`,
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
        pinsUnpublishedVersion(mcpServers.calavera, entries),
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
          pinsUnpublishedVersion(servers.calavera, entries),
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
 * The `calavera` entry Calavera writes under `mcp.servers` in `opencode.json`: OpenCode 2 requires
 * `type` and `command` for a local server and connects it unless `disabled` is set, which defaults
 * to `false`, so the entry carries neither `enabled` nor `disabled`
 * (https://opencode.ai/docs/mcp-servers/, "Config" and "Local"; ADR-0022, Decision 1).
 *
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
export function createOpenCodeMcpEntry(launchCommand) {
  return { type: "local", command: [launchCommand.command, ...launchCommand.args] };
}

/**
 * The entry 2.2.0 through 6.2.1 wrote directly under `mcp`, in the layout OpenCode 1.x reads.
 * Calavera never writes it again: only `openCodeMcpLocations` calls this, so `--init` can move the
 * entry and `eject` can remove it (ADR-0022, Decision 8).
 *
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
function createEarlierOpenCodeMcpEntry(launchCommand) {
  return { ...createOpenCodeMcpEntry(launchCommand), enabled: true };
}

/**
 * @param {McpLaunchCommand} launchCommand
 * @returns {Record<string, unknown>}
 */
export function createOpenCodeMcpJsonConfig(launchCommand) {
  return {
    $schema: OPENCODE_CONFIG_SCHEMA,
    mcp: { servers: { calavera: createOpenCodeMcpEntry(launchCommand) } },
  };
}

/**
 * @typedef {object} OpenCodeMcpLocation
 * @property {"mcp.servers" | "mcp"} name How the location is named in messages.
 * @property {string[]} keys The keys that lead to the object that holds the `calavera` entry.
 * @property {unknown[]} entries The entries a Calavera release wrote there, one for each package
 *   manager.
 */

/**
 * Where `opencode.json` can hold Calavera's entry, each with the entries a release wrote there:
 * `mcp.servers` from 7.0.0 on, and directly under `mcp` for 2.2.0 through 6.2.1. `--init` and
 * `eject` both read this list, so a change to an entry updates both (ADR-0022, Decision 7).
 *
 * @param {McpLaunchCommand[]} launches The launch command for each supported package manager.
 * @returns {OpenCodeMcpLocation[]}
 */
export function openCodeMcpLocations(launches) {
  return [
    {
      name: "mcp.servers",
      keys: ["mcp", "servers"],
      entries: calaveraMcpEntries("opencode", launches),
    },
    { name: "mcp", keys: ["mcp"], entries: launches.map(createEarlierOpenCodeMcpEntry) },
  ];
}

/**
 * Whether `value`, the `servers` member of `mcp`, is OpenCode 2's object of servers: an object
 * whose every member is an object. A server of either layout always has a string `type`, so an
 * OpenCode 1.x server named `servers` fails this, while a container that holds a server named
 * `type` passes it (ADR-0022, Decision 3).
 *
 * @param {unknown} value
 */
export function isOpenCodeServerContainer(value) {
  return isPlainObject(value) && Object.values(value).every(isPlainObject);
}

/**
 * Why `--init` leaves `opencode.json` unchanged when its `mcp.servers` is not OpenCode 2's object of
 * servers, or undefined when it is, or when `mcp` has no `servers` (ADR-0022, Decision 3).
 *
 * @param {Record<string, unknown>} mcp
 * @param {string} path
 * @returns {string | undefined}
 */
function openCodeServersProblem(mcp, path) {
  if (!Object.hasOwn(mcp, "servers") || isOpenCodeServerContainer(mcp.servers)) return undefined;
  const servers = mcp.servers;
  const reserved =
    "a name OpenCode 2 reserves for the object that holds servers, so it was left unchanged.";
  if (isPlainObject(servers) && typeof servers.type === "string") {
    return `${path} holds a server named servers directly under mcp, ${reserved} Rename that server, then run --init again.`;
  }
  if (isPlainObject(servers) && Object.keys(servers).join() === "enabled") {
    return `${path} holds an enabled switch for a server named servers directly under mcp, ${reserved} Rename or remove it, then run --init again.`;
  }
  return `${path} holds an mcp.servers member that is not an object of servers, so it was left unchanged. Correct it as OpenCode's MCP documentation describes, then run --init again.`;
}

/**
 * The `calavera` entries a parsed `opencode.json` holds, in the order of the file. `mcp.servers` is
 * searched only when it is OpenCode 2's object of servers, so a server named `servers` is never
 * read as one (ADR-0022, Decision 3).
 *
 * @param {unknown} config
 * @param {OpenCodeMcpLocation[]} locations From `openCodeMcpLocations`.
 * @returns {{ location: OpenCodeMcpLocation, entry: unknown }[]}
 */
export function openCodeEntriesIn(config, locations) {
  if (!isPlainObject(config) || !isPlainObject(config.mcp)) return [];
  const mcp = config.mcp;
  const order = Object.keys(mcp);
  /** @param {OpenCodeMcpLocation} location */
  const positionOf = (location) => order.indexOf(location.name === "mcp" ? "calavera" : "servers");
  return locations
    .flatMap((location) => {
      const holder =
        location.name === "mcp" ? mcp : isOpenCodeServerContainer(mcp.servers) ? mcp.servers : {};
      return isPlainObject(holder) && Object.hasOwn(holder, "calavera")
        ? [{ location, entry: holder.calavera }]
        : [];
    })
    .toSorted((a, b) => positionOf(a.location) - positionOf(b.location));
}

const OPENCODE_2_REMEDY =
  "OpenCode 2 reads servers from mcp.servers: move the entry there and replace enabled with disabled, as OpenCode's migration guide describes, or remove it, then run --init again.";
const ENABLED_SWITCH_REMEDY =
  'That entry holds only enabled, which OpenCode 1.x uses to switch off a server configured elsewhere: remove it, or set "disabled": true on a full calavera entry under mcp.servers, then run --init again.';
const TWO_ENTRIES_REMEDY =
  "Keep the one you mean to use: OpenCode 2 reads servers from mcp.servers, so move yours there and replace enabled with disabled, as OpenCode's migration guide describes, then remove the other, or remove yours to use Calavera's entry. Then run --init again.";

const TWO_ENTRIES_SWITCH_REMEDY =
  'The entry under mcp holds only enabled, which OpenCode 1.x uses to switch off a server configured elsewhere: remove it, or set "disabled": true on the calavera entry under mcp.servers, then run --init again.';

/**
 * Whether `entry` holds only `enabled`, the OpenCode 1.x way to switch off a server configured
 * elsewhere.
 *
 * @param {unknown} entry
 */
function isEnabledSwitch(entry) {
  return isPlainObject(entry) && Object.keys(entry).join() === "enabled";
}

/**
 * The kept-file change for an `opencode.json` that holds an edited `calavera` entry: the file stays
 * as it is, because C8 forbids rewriting the edited entry, and a partial write would rewrite the
 * file while the conflict remains (ADR-0022, Decision 2).
 *
 * @param {string} path
 * @param {{ location: OpenCodeMcpLocation, entry: unknown, edited: boolean }[]} found
 * @returns {McpConfigChange}
 */
function editedOpenCodeChange(path, found) {
  /** @param {OpenCodeMcpLocation} location */
  const named = (location) => `The calavera entry under ${location.name}`;
  if (found.length === 1) {
    const [{ location, entry }] = /** @type {[(typeof found)[number]]} */ (found);
    const unpublished = pinsUnpublishedVersion(entry, location.entries);
    if (location.name === "mcp.servers") {
      return editedEntryChange(path, named(location), unpublished);
    }
    return editedEntryChange(
      path,
      named(location),
      unpublished,
      isEnabledSwitch(entry) ? ENABLED_SWITCH_REMEDY : OPENCODE_2_REMEDY,
    );
  }
  // An edited switch under `mcp` cannot move to `mcp.servers` as it is, so it gets its own remedy.
  const editedSwitch = found.some(
    ({ location, entry, edited }) => edited && location.name === "mcp" && isEnabledSwitch(entry),
  );
  const sentences = found.map(({ location, entry, edited }) =>
    edited
      ? editedEntrySentence(path, named(location), pinsUnpublishedVersion(entry, location.entries))
      : `${named(location)} is one a Calavera release wrote.`,
  );
  return {
    type: "skip",
    path,
    reason: [
      ...sentences,
      `The file holds two calavera servers, so it was left unchanged.`,
      editedSwitch ? TWO_ENTRIES_SWITCH_REMEDY : TWO_ENTRIES_REMEDY,
    ].join(" "),
  };
}

const COMMENTS = "has comments or trailing commas, which Calavera would lose by rewriting it, so";

/**
 * What to do about each `calavera` entry in an `opencode.json` with comments, which `--init` never
 * rewrites (ADR-0022, Decision 2).
 *
 * @param {OpenCodeMcpLocation} location
 */
function commentedEntrySentence(location) {
  return location.name === "mcp"
    ? "Move the calavera entry under mcp.servers yourself, as the setup notes in .agents/calavera/mcp.md show, and remove enabled."
    : "Calavera does not update the version its calavera entry pins in a file with comments. To update it, change the create-project-calavera@<version> in the entry's command to the version the setup notes in .agents/calavera/mcp.md show.";
}

/**
 * The text of `opencode.json` read as JSON with comments (JSONC), which OpenCode's schema allows,
 * or undefined when it is not JSONC either. Empty text is neither, so it keeps the message for JSON
 * that does not parse (ADR-0022, Decision 2).
 *
 * @param {string} text
 * @returns {{ value: unknown } | undefined}
 */
function parseOpenCodeJsonc(text) {
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const value = parseJsonc(text, errors, { allowTrailingComma: true, allowEmptyContent: false });
  return errors.length === 0 ? { value } : undefined;
}

/**
 * Writes Calavera's entry under `mcp.servers` in `opencode.json`, moving an unedited entry an
 * earlier release wrote directly under `mcp`. The file stays unchanged, as a kept file with a
 * remedy, when it holds an edited entry, an `mcp.servers` that is not OpenCode 2's object of
 * servers, or comments with a `calavera` entry. A shape Calavera cannot read throws, which the
 * caller turns into a manual setup (ADR-0022, Decisions 2 and 3).
 *
 * @param {string} path
 * @param {McpLaunchCommand} launchCommand
 * @param {OpenCodeMcpLocation[]} locations From `openCodeMcpLocations`.
 * @param {boolean} dryRun
 * @param {McpConfigChange[]} changes
 * @param {LoadFormatter} loadFormatter
 * @returns {Promise<McpConfigAction>}
 */
export async function writeOpenCodeMcpConfig(
  path,
  launchCommand,
  locations,
  dryRun,
  changes,
  loadFormatter,
) {
  const targetPath = normalizeConfigPath(path);
  if (!(await fileExists(targetPath))) {
    return writeProjectJsonConfig(
      targetPath,
      createOpenCodeMcpJsonConfig(launchCommand),
      dryRun,
      changes,
      loadFormatter,
    );
  }

  const currentContents = await readFile(targetPath, "utf8");
  /** @type {unknown} */
  let parsed;
  let commented = false;
  try {
    parsed = parseJSON(currentContents, targetPath);
  } catch (error) {
    const jsonc = parseOpenCodeJsonc(currentContents);
    if (jsonc === undefined) throw error;
    parsed = jsonc.value;
    commented = true;
  }
  const currentConfig = assertJsonObjectConfig(parsed, targetPath);
  const mcp = currentConfig.mcp;

  if (mcp !== undefined && !isPlainObject(mcp)) {
    throw new Error(`${targetPath} mcp must be an object.`);
  }

  /** @param {string[]} sentences */
  const kept = (sentences) => {
    changes.push({ type: "skip", path: targetPath, reason: sentences.join(" ") });
    return /** @type {const} */ ("skip");
  };
  const found = openCodeEntriesIn(currentConfig, locations);
  const serversProblem = isPlainObject(mcp) ? openCodeServersProblem(mcp, targetPath) : undefined;

  if (commented) {
    if (serversProblem !== undefined) {
      return kept([`${targetPath} ${COMMENTS} it was left unchanged.`, serversProblem]);
    }
    if (found.length === 0) {
      // Nothing of Calavera's to keep, and the person needs the entry to add: a manual setup.
      throw new Error(
        `${targetPath} ${COMMENTS} Calavera did not add its entry. Add the calavera entry from .agents/calavera/mcp.md under mcp.servers yourself.`,
      );
    }
    return kept([
      `${targetPath} ${COMMENTS} it was left unchanged.`,
      ...found.map(({ location }) => commentedEntrySentence(location)),
    ]);
  }

  const repeated = repeatedKeyChange(targetPath, currentContents);
  if (repeated) {
    changes.push(repeated);
    return "skip";
  }

  const judged = found.map((each) => ({
    ...each,
    edited: !isCalaveraMcpEntry(each.entry, each.location.entries),
  }));
  if (serversProblem !== undefined) {
    // `mcp.servers` is not searched, so only an entry directly under `mcp` can be named; the
    // person corrects `mcp.servers` before any entry can be placed (ADR-0022, Decision 2).
    return kept([
      serversProblem,
      ...judged.map(({ location, entry, edited }) =>
        edited
          ? editedEntrySentence(
              targetPath,
              `The calavera entry under ${location.name}`,
              pinsUnpublishedVersion(entry, location.entries),
            )
          : `The calavera entry under ${location.name} is one a Calavera release wrote.`,
      ),
    ]);
  }
  if (judged.some(({ edited }) => edited)) {
    changes.push(editedOpenCodeChange(targetPath, judged));
    return "skip";
  }

  const moved = found.some(({ location }) => location.name === "mcp");
  const servers = isPlainObject(mcp) && isPlainObject(mcp.servers) ? mcp.servers : {};
  const restOfMcp = isPlainObject(mcp)
    ? Object.fromEntries(Object.entries(mcp).filter(([name]) => name !== "calavera"))
    : {};
  return writeProjectJsonConfig(
    targetPath,
    {
      ...currentConfig,
      $schema:
        typeof currentConfig.$schema === "string" ? currentConfig.$schema : OPENCODE_CONFIG_SCHEMA,
      mcp: {
        ...restOfMcp,
        servers: { ...servers, calavera: createOpenCodeMcpEntry(launchCommand) },
      },
    },
    dryRun,
    changes,
    loadFormatter,
    currentContents,
    moved ? openCodeMoveReason(dryRun) : undefined,
  );
}

/**
 * The reason of the `update` change that moves the entry an earlier release wrote directly under
 * `mcp` to `mcp.servers` (ADR-0022, Decision 5). It names the file only through the change's path,
 * so the summary names `opencode.json` once.
 *
 * @param {boolean} dryRun
 */
export function openCodeMoveReason(dryRun) {
  return `${dryRun ? "Would move" : "Moved"} the calavera entry from mcp to mcp.servers, the layout OpenCode 2 reads. OpenCode's migration guide says not to point OpenCode 1.x at files in this layout: install OpenCode 2, or restore the file from version control.`;
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
