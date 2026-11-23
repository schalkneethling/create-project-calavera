// @ts-check

// ADR-0017: `eject` removes the files and the text Calavera keeps in a project to manage it, its
// footprint, and keeps the tooling Calavera installed. This module plans and carries out the
// removal of the items Calavera records itself: the state, the recipe, the artifact lock and the
// extracted package folders, the artifact cache and the transient folders, the base Calavera
// skill, and the `artifact-cache` block in `.gitignore`. It also plans the bootstrap's guidance,
// which has no record and is checked against the texts Calavera writes: `AGENTS.md` written as a
// whole file, the marked section in an existing `AGENTS.md`, `AGENTS.calavera.md`, and
// `.agents/calavera/mcp.md`. It also plans the `calavera` MCP entry in the four harness files the
// bootstrap writes, checked against the launch command for each package manager, and a
// `.coderabbit.yaml` that Calavera created whole, checked against the texts every release wrote.
// The CLI's `eject` command calls `ejectProject` in `index.js`, which decides how the person
// approves the list (#678).
//
// The plan looks for each item directly, not only through the state file, because a project whose
// state file is gone still holds the rest of the footprint (ADR-0017, Decision 2). Nothing here
// writes before the plan is complete, except the recovery of a pending artifact transaction in a
// run that is not a dry run (Decision 7).

import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

import {
  createScanner,
  findNodeAtLocation,
  parse as parseJsonc,
  parseTree,
  printParseErrorCode,
} from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { hashArtifactPayload } from "@schalkneethling/calavera-artifact-core/registry";

import {
  AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE,
  AGENT_BOOTSTRAP_GUIDANCE_FILE,
  AGENT_BOOTSTRAP_MARKER,
  AGENT_BOOTSTRAP_MCP_FILE,
  AGENT_BOOTSTRAP_SECTION_END,
  AGENT_BOOTSTRAP_SECTION_START,
} from "./agent-bootstrap-files.js";
import {
  CODE_RABBIT_CONFIG_FIRST_LINE,
  CODE_RABBIT_CONFIG_PATH,
  CODE_RABBIT_PACKAGES_FILTER,
  hashAiInstall,
} from "./ai/artifacts.js";
import {
  ARTIFACT_CACHE_BLOCK,
  CACHE_ROOT,
  LOCK_PATH,
  PACKAGE_PATH,
  STATE_PATH,
  TRANSACTION_PATH,
  TRANSACTION_ROOT,
  readLock,
  readState,
  recoverArtifactTransaction,
} from "./artifact-lifecycle.js";
import { GITIGNORE_PATH, withoutGitignoreBlock } from "./ignore-lines.js";
import { CONFIG_FILE } from "./project-local-commands.js";
import { assertWorkspacePath } from "./utils/fs.js";
import { positionOf } from "./utils/parse-position.js";
import { isCodeRabbitTextCalaveraWrote } from "./utils/earlier-coderabbit.js";
import {
  findEarlierGuidance,
  normalizePinnedVersion,
  normalizePublishedPin,
} from "./utils/earlier-guidance.js";
import { isPlainObject } from "./utils/guards.js";
import { rewriteLossProblem, toJSONText, writeJSON } from "./utils/json-rewrite.js";
import { findBlock, findMarkedBlock } from "./utils/marked-block.js";
import {
  OPENCODE_CONFIG_SCHEMA,
  calaveraMcpEntries,
  createCodexMcpTomlBlock,
  UNPUBLISHED_PIN,
  isCalaveraMcpEntry,
  openCodeEntriesIn,
  openCodeMcpLocations,
  pinsUnpublishedVersion,
  projectMcpConfigPath,
  tomlPosition,
  writtenVersion,
} from "./utils/mcp-config.js";
// `STAGING_ROOT` is where `eject` moves a package folder before it deletes it, so a delete that
// stops part way leaves the folder either whole in `.calavera/packages/` or here, never half
// removed. An earlier run's leftovers here are transient, so the next run removes them (ADR-0017,
// Decision 7). Apply removes only the old copies of locked packages that releases before #988 left
// here (ADR-0017, Amendment 4).
import { STAGING_ROOT } from "./staging-leftovers.js";

const CALAVERA_ROOT = ".calavera";
// The path the bootstrap installs the base Calavera skill to, and that `skill-calavera` installs to
// when a recipe selects it.
const BASE_SKILL_PATH = ".agents/skills/calavera";
// The folder that holds the MCP setup notes. `eject` removes it once removing the notes has left
// it empty (ADR-0017, Decision 2).
const MCP_NOTES_ROOT = dirname(AGENT_BOOTSTRAP_MCP_FILE);

/** The entries of `.calavera/` that belong to the footprint; any other entry is the person's. */
const CALAVERA_ENTRIES = new Set(
  [
    STATE_PATH,
    LOCK_PATH,
    CACHE_ROOT,
    PACKAGE_PATH,
    STAGING_ROOT,
    TRANSACTION_ROOT,
    TRANSACTION_PATH,
  ].map((path) => path.slice(`${CALAVERA_ROOT}/`.length)),
);

const CANNOT_DETECT = "edits cannot be detected";

/**
 * @typedef {"state" | "lock" | "recipe" | "cache" | "transient" | "base-skill" | "artifact-cache-block" | "package-folder" | "guidance-file" | "guidance-section" | "fallback-guidance" | "mcp-notes" | "mcp-entry" | "coderabbit-config"} EjectItemKind
 *   `guidance-file` is `AGENTS.md` written as a whole file, `guidance-section` the marked section
 *   in an existing `AGENTS.md`, `fallback-guidance` is `AGENTS.calavera.md`, `mcp-notes` is
 *   `.agents/calavera/mcp.md`, `mcp-entry` is the `calavera` entry in an MCP harness file, and
 *   `coderabbit-config` is a `.coderabbit.yaml` that Calavera created whole.
 *
 * @typedef {object} EjectItem One footprint item `eject` removes.
 * @property {EjectItemKind} kind
 * @property {string} path The file or folder to delete, or the file to edit.
 * @property {"delete" | "edit"} action An edit removes only Calavera's text from a file that stays.
 * @property {"unedited" | "edited" | "cannot-detect" | "not-checked"} edits What the item's check
 *   found. `not-checked` is Calavera's own record, cache, or transient folder, which has no check.
 * @property {boolean} matchesRecords Whether the item matches Calavera's records exactly, so
 *   `--yes` may remove it without an interactive approval (ADR-0017, Decision 5).
 * @property {string} [reason] Why the item is edited, or why its edits cannot be detected.
 * @property {string} [note] What the change does besides removing Calavera's text, which the
 *   person approves with it: for an MCP entry in a JSON harness file, that the formatter also
 *   changes the layout of the rest of the file. An item with a note never matches Calavera's
 *   records, so `--yes` leaves it.
 * @property {{ path: string, edits: "unedited" | "edited" }} [payload] For a package folder that a
 *   lock entry names, the payload checked against the entry's `payloadHash`.
 * @property {string[]} [removedLines] For an edit, the lines it removes, markers excluded. For a
 *   JSON harness file, which eject rewrites whole, each removed member as JSON: the `calavera`
 *   entry, or the `mcpServers` or `mcp` object it empties, and the `$schema` it removes.
 * @property {string} [contents] For an edit, the file's text afterward. For an MCP entry, it stays
 *   internal: the command shows `around` instead (ADR-0017, Amendment 3).
 * @property {{ line: number, before?: string, after?: string }} [around] For an MCP entry, where
 *   Calavera's text starts in the file, and the nearest line that is not blank before it and after
 *   it, with their values hidden, so the person's other servers and their `env` or `headers`
 *   tokens never reach a terminal log or `--json` (ADR-0017, Amendment 3).
 * @property {string} [seen] What the item's check read when the plan was made. For every kind
 *   but the base skill, it holds the entry identity from `entryIdentity`: a file, a folder, or a
 *   symbolic link, its target, and the path its chain of links resolves to. The `artifact-cache`
 *   block, the guidance kinds, the MCP entries, and `.coderabbit.yaml` record the identity and the file's text as a JSON array, through
 *   `textSeen`, and a package folder that a lock entry names adds its payload hash. The base skill records its installed hash and the entries that hash does not cover.
 *   `executeEject` reads it again and removes nothing when any item changed since the plan.
 *
 * @typedef {object} EjectOutcome What `executeEject` did with each item it was given.
 * @property {EjectItem[]} removed
 * @property {{ item: EjectItem, error: Error }[]} failed Items whose removal failed, with the cause.
 * @property {{ item: EjectItem, reason: string }[]} skipped Items left because an item they depend
 *   on failed: the record a failed item still needs, or the `.gitignore` block of a cache that
 *   could not be deleted.
 *
 * @typedef {object} EjectReport Footprint text `eject` keeps, for the person to act on
 *   (ADR-0017, Decision 4). It does not count as work for `eject` (Decision 8).
 * @property {string} path
 * @property {string} reason What `eject` found, why it keeps it, and what the person can do.
 *
 * @typedef {object} EjectPlan
 * @property {EjectItem[]} items Every footprint item that exists, in no particular order.
 * @property {EjectReport[]} reported Footprint text that `eject` keeps and reports.
 * @property {string[]} kept Files in `.calavera/` and `.agents/calavera/` that `eject` does not
 *   name, so it keeps them and the folders that hold them.
 * @property {boolean} nothingToDo Whether no footprint item exists. Reported text does not count.
 *
 * @typedef {object} AgentGuidanceTexts The texts the bootstrap writes now, formatted by the
 *   project's formatter, from `agentBootstrapTexts` in `index.js`.
 * @property {string} file `AGENTS.md` written as a whole file.
 * @property {string} section The marked section appended to an existing `AGENTS.md`.
 * @property {string} fallback `AGENTS.calavera.md`.
 * @property {string[]} mcp `.agents/calavera/mcp.md`, one text for each package manager.
 * @property {{ command: string, args: string[] }[]} mcpLaunchCommands The MCP launch command for
 *   each package manager, which the `calavera` entry in each harness file is checked against.
 */

/**
 * Whether anything exists at `path`, a broken symbolic link included.
 *
 * @param {string} path
 */
async function present(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return false;
    throw error;
  }
}

/** @param {string} path */
async function isRealDirectory(path) {
  return (await lstat(path)).isDirectory();
}

/** @param {unknown} error */
function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

const LINK_PREFIX = "link:";

/**
 * What identifies the entry at `path`: whether it is a file, a folder, or a symbolic link and the
 * target it points to, and the real path it resolves to, through every symbolic link on the way,
 * whether the link is the entry itself, one further along a chain, or a parent folder. An entry
 * that changes type after the plan, such as a folder replaced by a file or by a link, a link that
 * points elsewhere, or an entry whose parent folder now leads elsewhere, gives another value, so
 * `executeEject` sees the change and removes nothing, rather than deleting what the plan never
 * listed.
 *
 * @param {string} path
 */
async function entryIdentity(path) {
  const stats = await lstat(path);
  // A chain of links that leads nowhere records null.
  const resolved = await realpath(path).catch(() => null);
  // The type is one of four fixed words, and the rest is JSON, so the value holds no raw line break
  // and splits only one way.
  if (stats.isSymbolicLink()) {
    return `${LINK_PREFIX}${JSON.stringify([await readlink(path), resolved])}`;
  }
  const type = stats.isDirectory() ? "folder" : stats.isFile() ? "file" : "other";
  return `${type}:${JSON.stringify([resolved])}`;
}

/**
 * What a file's check reads: its entry identity, and its text when the path leads to a file,
 * through a symbolic link too. Encoded as a JSON array, so no text, whatever it holds, can make two
 * different reads look the same.
 *
 * @param {string} identity From `entryIdentity`.
 * @param {string | undefined} text Undefined when the path does not lead to a file.
 */
function textSeen(identity, text) {
  // JSON writes an undefined text as null, which no text read from a file can equal.
  return JSON.stringify([identity, text]);
}

/**
 * Reads the entry at `path` for a check of its text: its identity, and its text when the path
 * leads to a file. Nothing when no entry exists.
 *
 * @param {string} path
 * @returns {Promise<{ identity: string, text: string | undefined } | undefined>}
 */
async function readTextEntry(path) {
  if (!(await present(path))) return undefined;
  const identity = await entryIdentity(path);
  const leadsToFile = await stat(path).then(
    (stats) => stats.isFile(),
    () => false,
  );
  return { identity, text: leadsToFile ? await readFile(path, "utf8") : undefined };
}

/**
 * Whether two texts are the same, with a Windows line ending (`\r\n`) counting as the Unix one
 * (`\n`), as `findEarlierGuidance` counts it.
 *
 * @param {string} text
 * @param {string} written
 */
function sameText(text, written) {
  return text.replaceAll("\r\n", "\n") === written.replaceAll("\r\n", "\n");
}

/**
 * Whether the item is already gone, which ADR-0017 Decision 2 counts as removed: its file or
 * folder no longer exists. For the `artifact-cache` block, that is a `.gitignore` the person
 * deleted, which no longer holds the block either.
 *
 * @param {EjectItem} item
 */
async function alreadyGone(item) {
  return !(await present(item.path));
}

/**
 * What a package folder's check reads: its entry identity (a folder, a file, or a link and its
 * target), and its payload hash.
 *
 * @param {string} identity From `entryIdentity`.
 * @param {string | undefined} payloadHash
 */
function packageFolderSeen(identity, payloadHash) {
  return `${identity}\n${payloadHash ?? "missing"}`;
}

/**
 * Returns the absolute path of an item `eject` may remove or edit, or throws when the path leads
 * out of the project. A deleted symbolic link is removed as a link, because `rm` never follows it,
 * so only the folder that holds the link must be inside the project, wherever the link points. An
 * edit writes through a link, so its whole path must stay inside.
 *
 * @param {EjectItem} item
 */
async function assertEjectPath(item) {
  if (item.action === "delete" && (await lstat(item.path)).isSymbolicLink()) {
    await assertWorkspacePath(dirname(item.path), process.cwd(), "Eject path");
    return resolve(item.path);
  }
  return assertWorkspacePath(item.path, process.cwd(), "Eject path");
}

/**
 * Recovers a pending artifact transaction, the way every `artifacts` command does, unless this is
 * a dry run: recovery writes files, so a dry run refuses instead, as `apply --dry-run` does
 * (ADR-0017, Decision 7).
 *
 * @param {boolean} dryRun
 */
async function recoverPendingTransaction(dryRun) {
  try {
    await recoverArtifactTransaction({ readOnly: dryRun });
  } catch (error) {
    throw new Error(
      dryRun
        ? `eject --dry-run stopped, because ${TRANSACTION_PATH} records a pending artifact transaction, and recovering it writes files. Run eject without --dry-run, or any artifacts command, to recover it first, then run eject --dry-run again.`
        : `eject stopped before removing anything, because recovering the pending artifact transaction in ${TRANSACTION_PATH} failed: ${messageOf(error)}. Fix the cause, then run eject again.`,
      { cause: error },
    );
  }
}

/**
 * The artifact lock, with every entry an object that names an ID and a version, so the package
 * folders can be matched against it.
 */
async function readCheckedLock() {
  const lock = await readLock();
  const malformed = lock.artifacts.findIndex(
    (entry) =>
      entry === null ||
      typeof entry !== "object" ||
      typeof entry.id !== "string" ||
      typeof entry.version !== "string",
  );
  if (malformed !== -1) {
    throw new Error(`artifact entry ${malformed} does not name a string id and version`);
  }
  return lock;
}

/**
 * Reads a record a check needs. A record that cannot be read is treated as missing, so the items it
 * checks are listed as edited, as ADR-0017 Decision 2 treats a missing record, and the reason says
 * why.
 *
 * @template T
 * @param {string} path
 * @param {() => Promise<T>} read
 * @returns {Promise<{ value: T | undefined, problem?: string }>}
 */
async function readRecord(path, read) {
  try {
    return { value: await read() };
  } catch (error) {
    return {
      value: undefined,
      problem: `Calavera could not read ${path} (${messageOf(error)}), so the items it checks are listed as edited or as unknown.`,
    };
  }
}

/**
 * The entries of the base skill that its record's hash does not cover: `hashAiInstall` hashes only
 * regular files, so it skips symbolic links and empty folders. A skill folder that is itself a
 * symbolic link is listed too, because the hash then describes the folder the link leads to.
 *
 * @param {string} [path]
 * @returns {Promise<string[]>}
 */
async function uncoveredSkillEntries(path = BASE_SKILL_PATH) {
  if ((await lstat(path)).isSymbolicLink()) return [path];
  /** @type {string[]} */
  const uncovered = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const entryPath = `${path}/${entry.name}`;
    if (entry.isSymbolicLink()) {
      uncovered.push(entryPath);
    } else if (entry.isDirectory()) {
      const inside = await uncoveredSkillEntries(entryPath);
      if ((await readdir(entryPath)).length === 0) uncovered.push(entryPath);
      uncovered.push(...inside);
    }
  }
  return uncovered.sort();
}

/** @param {string} text */
const capitalized = (text) => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/**
 * The base skill's hash as `hashAiInstall` computes it, or why it could not be computed, with what
 * the hash does not cover (ADR-0017, Amendment 1). `uncoveredNote` names the symbolic links and
 * empty folders, and any folder eject could not list, as a clause that starts in lowercase; it is
 * empty when the hash covers everything. `seen` combines all of it, so a change to any part after
 * the plan stops `executeEject`.
 */
async function baseSkillCheck() {
  let hash;
  try {
    hash = await hashAiInstall("skill", BASE_SKILL_PATH);
  } catch (error) {
    hash = `unreadable: ${messageOf(error)}`;
  }
  /** @type {string[]} */
  let uncovered = [];
  let listProblem = "";
  try {
    uncovered = await uncoveredSkillEntries();
  } catch (error) {
    // A folder eject cannot list may hold anything, so it never counts as covered.
    listProblem = messageOf(error);
  }
  const notes = [
    uncovered.length > 0
      ? `the record's hash does not cover symbolic links or empty folders, so ${CANNOT_DETECT} for: ${uncovered.join(", ")}.`
      : "",
    listProblem === ""
      ? ""
      : `Calavera could not list every entry of ${BASE_SKILL_PATH} (${listProblem}), so ${CANNOT_DETECT} for what it could not list.`,
  ].filter((note) => note !== "");
  // The identity records where the skill folder resolves, so a parent folder such as
  // `.agents/skills` that leads elsewhere after the plan counts as a change. A skill gone between
  // two reads records "missing", which no plan records.
  const identity = await entryIdentity(BASE_SKILL_PATH).catch(() => "missing");
  return {
    hash,
    uncoveredNote: notes.join(" "),
    // Encoded as JSON, so an entry whose name holds a line break never reads as two entries.
    seen: JSON.stringify([identity, hash, uncovered, listProblem]),
  };
}

/**
 * The payload's hash as apply computes it, or undefined when it cannot be computed, such as when
 * the payload is missing.
 *
 * @param {string} payloadPath
 */
async function payloadHashOf(payloadPath) {
  try {
    return await hashArtifactPayload(payloadPath);
  } catch {
    return undefined;
  }
}

/**
 * @param {import("./state.js").CalaveraState | undefined} state
 * @param {string | undefined} stateProblem
 * @returns {Promise<EjectItem[]>}
 */
async function planBaseSkill(state, stateProblem) {
  if (!(await present(BASE_SKILL_PATH))) return [];
  const record = state?.aiArtifacts.find(({ path }) => path === BASE_SKILL_PATH);
  const base = {
    kind: /** @type {const} */ ("base-skill"),
    path: BASE_SKILL_PATH,
    action: /** @type {const} */ ("delete"),
  };
  const { hash: installed, uncoveredNote, seen } = await baseSkillCheck();
  /** @param {string} reason */
  const withNote = (reason) =>
    uncoveredNote === "" ? reason : `${reason} ${capitalized(uncoveredNote)}`;
  if (!record) {
    return [
      {
        ...base,
        edits: "edited",
        matchesRecords: false,
        seen,
        reason: withNote(
          stateProblem ??
            `${STATE_PATH} holds no record of the base Calavera skill, so eject cannot tell whether you edited it.`,
        ),
      },
    ];
  }
  if (installed !== record.hash) {
    return [
      {
        ...base,
        edits: "edited",
        matchesRecords: false,
        seen,
        reason: withNote(
          `The base Calavera skill has local edits (installed=${installed}, state=${record.hash}).`,
        ),
      },
    ];
  }
  // Content no record covers is unknown, so `--yes` leaves it for an interactive approval
  // (ADR-0017, Amendment 1).
  return uncoveredNote === ""
    ? [{ ...base, edits: "unedited", matchesRecords: true, seen }]
    : [
        {
          ...base,
          edits: "cannot-detect",
          matchesRecords: false,
          seen,
          reason: `The base Calavera skill matches its record, but ${uncoveredNote}`,
        },
      ];
}

/**
 * Plans the removal of the `artifact-cache` block from `.gitignore`. A block that differs from its
 * record, or has none, is listed as edited, not a hard stop as in apply (owner decision of
 * 2026-11-17). A broken or changed marker is a hard stop, because `eject` then cannot tell where
 * the block ends (ADR-0017, Decision 7). A `.gitignore` that leads to a file outside the project
 * is one `eject` never changes, so its block is kept and reported, with no hard stop, as the
 * guidance section in such an `AGENTS.md` is (owner decision of 2026-11-19 on #678).
 *
 * @param {import("./state.js").CalaveraState | undefined} state
 * @param {string | undefined} stateProblem
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planCacheBlock(state, stateProblem) {
  if (!(await present(GITIGNORE_PATH))) return { items: [], reported: [] };
  const identity = await entryIdentity(GITIGNORE_PATH);
  const text = await readFile(GITIGNORE_PATH, "utf8");
  const found = findBlock(GITIGNORE_PATH, text, ARTIFACT_CACHE_BLOCK, "eject");
  const outside = !(await insideProject(GITIGNORE_PATH));
  const keptOutside = {
    items: [],
    reported: [
      {
        path: GITIGNORE_PATH,
        reason: `${GITIGNORE_PATH} leads to a file outside the project, which eject never changes, so it leaves the ${ARTIFACT_CACHE_BLOCK} block there. Remove the block, both markers included, yourself if you no longer want it.`,
      },
    ],
  };
  if ("reason" in found) {
    // The block stays either way, so a broken marker in a file eject never changes is no stop.
    if (outside) return keptOutside;
    throw new Error(`eject stopped before removing anything: ${found.reason}`);
  }
  if (found.startIndex === -1) return { items: [], reported: [] };
  if (outside) return keptOutside;
  const record = state?.gitignoreBlocks.find(
    ({ integration }) => integration === ARTIFACT_CACHE_BLOCK,
  );
  const unedited = record !== undefined && record.lines.join("\n") === found.current;
  /** @type {EjectItem} */
  const item = {
    kind: "artifact-cache-block",
    path: GITIGNORE_PATH,
    action: "edit",
    edits: unedited ? "unedited" : "edited",
    matchesRecords: unedited,
    removedLines: found.current === "" ? [] : found.current.split("\n"),
    contents: withoutGitignoreBlock(found),
    seen: textSeen(identity, text),
  };
  if (!unedited) {
    item.reason =
      record === undefined
        ? (stateProblem ??
          `${STATE_PATH} holds no record of the ${ARTIFACT_CACHE_BLOCK} block, so eject cannot tell whether you edited it.`)
        : "The artifact-cache block was edited since Calavera wrote it.";
  }
  return { items: [item], reported: [] };
}

/**
 * Plans a file that `eject` deletes whole when its text is one Calavera wrote: a guidance file or a
 * `.coderabbit.yaml` that Calavera created. A symbolic link in its place leads to content no record
 * covers, so it needs an interactive approval, and approval removes only the link, as for a link
 * where Calavera keeps its own files.
 *
 * @param {"guidance-file" | "fallback-guidance" | "mcp-notes" | "coderabbit-config"} kind
 * @param {string} path
 * @param {{ identity: string, text: string }} entry
 * @param {boolean} written Whether the text is one Calavera wrote.
 * @param {string} [editedReason] Why the text counts as edited; needed only when `written` is
 *   false.
 * @returns {EjectItem}
 */
function textFileItem(kind, path, { identity, text }, written, editedReason) {
  /** @type {EjectItem} */
  const item = {
    kind,
    path,
    action: "delete",
    edits: written ? "unedited" : "edited",
    matchesRecords: written,
    seen: textSeen(identity, text),
  };
  if (identity.startsWith(LINK_PREFIX)) {
    return {
      ...item,
      edits: written ? "cannot-detect" : "edited",
      matchesRecords: false,
      reason: `${path} is a symbolic link, which no record covers; ${CANNOT_DETECT}.${written ? "" : ` ${editedReason}`} eject removes only the link, not what it leads to.`,
    };
  }
  return written ? item : { ...item, reason: editedReason };
}

const MARKER_ONLY_REASON = `${AGENT_BOOTSTRAP_GUIDANCE_FILE} holds guidance marked ${AGENT_BOOTSTRAP_MARKER}, such as guidance merged by hand from ${AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE}. eject cannot tell where it ends, so it leaves it; remove it yourself if you no longer want it.`;

/**
 * Whether `path`, followed through any symbolic link, stays inside the project.
 *
 * @param {string} path
 */
async function insideProject(path) {
  return assertWorkspacePath(path, process.cwd(), "Eject path").then(
    () => true,
    () => false,
  );
}

/**
 * The text once the lines from `startIndex` to `endIndex` are removed, with the blank line Calavera
 * added before them; every other line stays. The bootstrap appends both the guidance section and
 * the Codex table after one blank line.
 *
 * @param {string[]} lines The text split on `\n`, so a line may end with `\r`.
 * @param {number} startIndex
 * @param {number} endIndex
 */
function withoutLines(lines, startIndex, endIndex) {
  const before = lines.slice(0, startIndex);
  const after = lines.slice(endIndex + 1);
  // The bootstrap appends the text after one blank line (`upsertAgentBootstrapGuidanceSection` in
  // index.js, `writeCodexMcpConfig` in mcp-config.js). That line goes only when a blank line or the
  // end of the file follows the text, so what the person wrote right after it stays separate.
  const blank = (/** @type {string | undefined} */ line) => line?.replace(/\r$/, "") === "";
  if (blank(before.at(-1)) && (after.length === 0 || blank(after[0]))) before.pop();
  // When the removed text ends the file without a line break, the line before it still owns the
  // line break that separated the two, so it keeps it. With no line before it, the pushed line
  // joins to the same empty text.
  if (after.length === 0) after.push("");
  return [...before, ...after].join("\n");
}

/**
 * The text of `AGENTS.md` once the guidance section is removed: the markers, the lines between
 * them, and the blank line Calavera added before the start marker go, and every other line stays.
 *
 * @param {import("./utils/marked-block.js").FoundBlock} found
 */
function withoutGuidanceSection(found) {
  return withoutLines(found.lines, found.startIndex, found.endIndex);
}

/**
 * Plans the guidance in `AGENTS.md` (ADR-0017, Decision 2). A marked section that equals the
 * current section text is removed from the file; any other section, edited or written by an
 * earlier release, is kept and reported. Without section markers, a file that holds a text
 * Calavera wrote as a whole file is deleted, an edited one is kept and reported, and guidance that
 * carries only the marker elsewhere in the file, such as a hand merge, is reported. A broken or
 * changed section marker is a hard stop (Decision 7).
 *
 * @param {AgentGuidanceTexts} guidance
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planAgentsGuidance(guidance) {
  const path = AGENT_BOOTSTRAP_GUIDANCE_FILE;
  const entry = await readTextEntry(path);
  // `AGENTS.md` is the project's file, so anything there that is not a file holds no guidance.
  if (entry?.text === undefined) return { items: [], reported: [] };
  const { identity, text } = entry;
  const found = findMarkedBlock(
    path,
    text,
    {
      start: AGENT_BOOTSTRAP_SECTION_START,
      end: AGENT_BOOTSTRAP_SECTION_END,
      names: ["calavera-agent-bootstrap:start", "calavera-agent-bootstrap:end"],
      label: "the Calavera guidance section",
    },
    "eject",
  );
  if ("reason" in found) {
    throw new Error(`eject stopped before removing anything: ${found.reason}`);
  }

  if (found.startIndex === -1) {
    if (!text.includes(AGENT_BOOTSTRAP_MARKER)) return { items: [], reported: [] };
    if (sameText(text, guidance.file) || findEarlierGuidance("guidance", text) !== undefined) {
      return {
        items: [textFileItem("guidance-file", path, { identity, text }, true)],
        reported: [],
      };
    }
    const wholeFile = text.split(/\r?\n/, 1)[0] === AGENT_BOOTSTRAP_MARKER;
    return {
      items: [],
      reported: [
        {
          path,
          reason: wholeFile
            ? `${path} holds Calavera's guidance with changes, and it has no section markers, so eject cannot separate Calavera's text from yours. eject leaves the file; remove Calavera's guidance from it yourself if you no longer want it.`
            : MARKER_ONLY_REASON,
        },
      ],
    };
  }

  const bare = found.lines.map((line) => line.replace(/\r$/, ""));
  const section = bare.slice(found.startIndex, found.endIndex + 1).join("\n");
  const contents = withoutGuidanceSection(found);
  /** @type {EjectItem[]} */
  const items = [];
  /** @type {EjectReport[]} */
  const reported = [];
  const unedited = section === guidance.section.replaceAll("\r\n", "\n").trimEnd();
  if (unedited && !(await insideProject(path))) {
    // The edit would write through a link to a file outside the project, which eject never
    // changes. The file belongs to the person, so it is kept and reported, not a hard stop.
    reported.push({
      path,
      reason: `${path} leads to a file outside the project, which eject never changes, so it leaves the Calavera guidance section there. Remove the section, both markers included, yourself if you no longer want it.`,
    });
  } else if (unedited) {
    items.push({
      kind: "guidance-section",
      path,
      action: "edit",
      edits: "unedited",
      matchesRecords: true,
      // The section equals the current one, so it is never empty.
      removedLines: found.current.split("\n"),
      contents,
      seen: textSeen(identity, text),
    });
  } else {
    // Without a table of earlier section texts, a section an earlier release wrote and one the
    // person edited look the same, so both are kept (ADR-0017, Decision 2).
    reported.push({
      path,
      reason: `The Calavera guidance section in ${path} differs from the section Calavera writes now, because it was edited or an earlier release wrote it. eject leaves it; remove the section, both markers included, yourself if you no longer want it.`,
    });
  }
  if (contents.includes(AGENT_BOOTSTRAP_MARKER)) {
    reported.push({ path, reason: MARKER_ONLY_REASON });
  }
  return { items, reported };
}

/**
 * Plans a guidance file that only Calavera writes, `AGENTS.calavera.md` or
 * `.agents/calavera/mcp.md`. Its text is checked against the current texts and the texts every
 * release wrote. An edited file is listed as edited and removed after approval (ADR-0017,
 * Decision 6). Anything other than a file at its path is reported and left.
 *
 * @param {"fallback-guidance" | "mcp-notes"} kind
 * @param {string} path
 * @param {(text: string) => boolean} written Whether a text is one Calavera wrote.
 * @param {string} editedReason
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planCalaveraGuidanceFile(kind, path, written, editedReason) {
  const entry = await readTextEntry(path);
  if (entry === undefined) return { items: [], reported: [] };
  if (entry.text === undefined) {
    return {
      items: [],
      reported: [
        {
          path,
          reason: `${path} is not a file, so eject cannot check it against the text Calavera writes, and leaves it. Remove it yourself if Calavera's guidance is all it holds.`,
        },
      ],
    };
  }
  const { identity, text } = entry;
  return {
    items: [textFileItem(kind, path, { identity, text }, written(text), editedReason)],
    reported: [],
  };
}

/**
 * Plans every guidance item of the footprint (ADR-0017, Decision 2).
 *
 * @param {AgentGuidanceTexts} guidance
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planGuidance(guidance) {
  const parts = [
    await planAgentsGuidance(guidance),
    await planCalaveraGuidanceFile(
      "fallback-guidance",
      AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE,
      (text) =>
        sameText(text, guidance.fallback) || findEarlierGuidance("guidance", text) !== undefined,
      `${AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE} differs from the guidance every Calavera release wrote, so it holds edits.`,
    ),
    await planCalaveraGuidanceFile(
      "mcp-notes",
      AGENT_BOOTSTRAP_MCP_FILE,
      (text) =>
        guidance.mcp.some((notes) => sameText(text, notes)) ||
        findEarlierGuidance("mcp", text) !== undefined,
      `${AGENT_BOOTSTRAP_MCP_FILE} differs from the MCP setup notes every Calavera release wrote, so it holds edits.`,
    ),
  ];
  return {
    items: parts.flatMap(({ items }) => items),
    reported: parts.flatMap(({ reported }) => reported),
  };
}

/**
 * Plans `.coderabbit.yaml` (ADR-0017, Decision 2). Calavera records nothing about the file, so
 * `eject` decides by its first line: Calavera writes it when it creates the file whole and never
 * when it adds its filters to an existing file (owner confirmation of 2026-11-17 on #678). A file
 * that starts with that line is Calavera's: it is unedited when its text is one a release wrote,
 * created or updated, and otherwise it is listed as edited and removed after approval (Decision
 * 6). Any other file existed before Calavera added its filters, so `eject` leaves it and reports
 * each line that holds the `!.calavera/packages/**` filter, for the person to remove (Decision 4).
 * Anything other than a file at the path is reported and left, because `eject` cannot read it.
 *
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planCodeRabbitConfig() {
  const path = CODE_RABBIT_CONFIG_PATH;
  const entry = await readTextEntry(path);
  if (entry === undefined) return { items: [], reported: [] };
  const { identity, text } = entry;
  if (text === undefined) {
    return {
      items: [],
      reported: [
        {
          path,
          reason: `${path} is not a file, so eject cannot tell whether Calavera created it, and leaves it.`,
        },
      ],
    };
  }
  const lines = text.split("\n");
  const [firstLine] = lines;
  // `split` always returns at least one line, even for an empty text.
  if (firstLine?.replace(/\r$/, "") === CODE_RABBIT_CONFIG_FIRST_LINE) {
    return {
      items: [
        textFileItem(
          "coderabbit-config",
          path,
          { identity, text },
          isCodeRabbitTextCalaveraWrote(text),
          `${path} starts with the line Calavera writes when it creates the file, but its text differs from every text a Calavera release wrote, so it holds edits.`,
        ),
      ],
      reported: [],
    };
  }
  const filterLines = lines.flatMap((line, index) =>
    line.includes(CODE_RABBIT_PACKAGES_FILTER) ? [index + 1] : [],
  );
  if (filterLines.length === 0) return { items: [], reported: [] };
  const where =
    filterLines.length === 1
      ? `Line ${filterLines[0]} holds`
      : `Lines ${filterLines.slice(0, -1).join(", ")} and ${filterLines.at(-1)} hold`;
  return {
    items: [],
    reported: [
      {
        path,
        reason: `${path} existed before Calavera added its review filters, so eject leaves the file as it is. ${where} the "${CODE_RABBIT_PACKAGES_FILTER}" filter Calavera added; remove it yourself if you no longer want it.`,
      },
    ],
  };
}

/** The MCP harness files the bootstrap writes (ADR-0017, Decision 2). */
const MCP_HARNESSES = /** @type {const} */ (["claude-code", "cursor", "opencode", "codex"]);
const CODEX_TABLE_HEADER = "[mcp_servers.calavera]";
const NO_MCP_ENTRY = { items: [], reported: [] };

/**
 * The report for a harness file that leads outside the project: `eject` never changes such a
 * file, so it keeps the entry, as it keeps the guidance section in such an `AGENTS.md`.
 *
 * @param {string} path
 * @returns {{ items: EjectItem[], reported: EjectReport[] }}
 */
function mcpEntryOutside(path) {
  return {
    items: [],
    reported: [
      {
        path,
        reason: `${path} leads to a file outside the project, which eject never changes, so it leaves any calavera MCP entry the file may hold. Remove the entry yourself if you no longer want it.`,
      },
    ],
  };
}

/**
 * @param {string} path
 * @param {string} reason
 * @returns {{ items: EjectItem[], reported: EjectReport[] }}
 */
function mcpEntryKept(path, reason) {
  return { items: [], reported: [{ path, reason }] };
}

/**
 * The `key` object of a parsed harness file when it holds a `calavera` entry, or undefined.
 *
 * @param {unknown} config
 * @param {string} key
 */
function serversWithEntry(config, key) {
  if (!isPlainObject(config)) return undefined;
  const servers = config[key];
  return isPlainObject(servers) && Object.hasOwn(servers, "calavera") ? servers : undefined;
}

/**
 * Where a JSON harness file can hold the `calavera` entry, as `openCodeMcpLocations` lists them for
 * `opencode.json`.
 *
 * @typedef {import("./utils/mcp-config.js").OpenCodeMcpLocation | { name: "mcpServers", keys: string[], entries: unknown[] }} JsonMcpLocation
 */

/**
 * The `calavera` entries a parsed JSON harness file holds, in the order of the file, each with its
 * location. In `opencode.json`, `mcp.servers` counts only when it is OpenCode 2's object of servers,
 * so a server named `servers` is never read as one (ADR-0022, Decision 3).
 *
 * @param {unknown} config
 * @param {JsonMcpLocation[]} locations
 * @returns {{ location: JsonMcpLocation, entry: unknown }[]}
 */
function jsonMcpEntriesIn(config, locations) {
  const [first] = locations;
  if (first?.name !== "mcpServers") {
    return openCodeEntriesIn(
      config,
      /** @type {import("./utils/mcp-config.js").OpenCodeMcpLocation[]} */ (locations),
    );
  }
  const servers = serversWithEntry(config, "mcpServers");
  return servers === undefined ? [] : [{ location: first, entry: servers.calavera }];
}

/**
 * Plans the `calavera` entry in a JSON harness file: `.mcp.json` and `.cursor/mcp.json` under
 * `mcpServers`, and `opencode.json` under `mcp.servers`, or directly under `mcp`, where 2.2.0
 * through 6.2.1 wrote it (ADR-0022, Decision 4). An entry is unedited when it equals an entry a
 * release wrote at its location for some package manager, with the pinned version normalized
 * (owner decision of 2026-11-17), and it pins a version published on npm (ADR-0017, Amendment 6).
 * Each entry is judged on its own: an unedited one is removed, and an edited one is kept and
 * reported, naming its location. Removing an entry can empty the object that holds it, which then
 * goes too, and so on up to the top of the file, and in `opencode.json` the `$schema` Calavera
 * writes goes once nothing else remains. The file stays, even when it is left empty. JSON has no
 * comments, and `eject` rewrites the whole file through the project's formatter, as the bootstrap
 * writes it, so the note says when that changes the layout of the rest of the file. A rewrite that
 * would lose what the person wrote, as `rewriteLossProblem` finds it, keeps every entry and reports
 * it.
 *
 * A file that is not plain JSON is read as JSON with comments (JSONC), which OpenCode documents
 * for `opencode.json`. Its `calavera` entries are kept and reported, because a rewrite would lose
 * the comments, so `eject` never rewrites such a file. Only a file that is neither JSON nor JSONC
 * is a hard stop (ADR-0017, Decision 7; owner decision of 2026-11-19 on #678).
 *
 * @param {string} path
 * @param {JsonMcpLocation[]} locations
 * @param {() => Promise<import("./utils/project-formatter.js").ProjectFormatter>} loadFormatter
 * @param {string} [schema] The `$schema` Calavera writes into this file, if any.
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planJsonMcpEntry(path, locations, loadFormatter, schema) {
  const entry = await readTextEntry(path);
  if (entry?.text === undefined) return NO_MCP_ENTRY;
  const { identity, text } = entry;
  const inside = await insideProject(path);
  /**
   * The entries, named by location, and what to do about them.
   *
   * @param {{ location: JsonMcpLocation }[]} found
   */
  const named = (found) => {
    const names = found.map(({ location }) => location.name).join(" and ");
    const [entries, them] = found.length === 1 ? ["entry", "it"] : ["entries", "them"];
    return {
      entries: `the calavera MCP ${entries} under ${names}`,
      remedy: `Remove ${them} yourself if you no longer want ${them}.`,
    };
  };
  /** @type {unknown} */
  let config;
  try {
    config = JSON.parse(text);
  } catch {
    /** @type {import("jsonc-parser").ParseError[]} */
    const errors = [];
    // An empty or whitespace-only file holds no entry, as it did before JSONC was read, so it is
    // left untouched rather than a stop.
    const jsonc = parseJsonc(text, errors, { allowTrailingComma: true, allowEmptyContent: true });
    // eject never changes a file outside the project, so it has no need to read it.
    if (!inside) return mcpEntryOutside(path);
    const [problem] = errors;
    if (problem !== undefined) {
      throw new Error(
        `eject stopped before removing anything: ${path} cannot be parsed as JSON, nor as JSON with comments (JSONC): ${printParseErrorCode(problem.error)} at offset ${problem.offset}. Correct the file, or remove the calavera MCP entry from it yourself, then run eject again.`,
        // Never JSON.parse's own error: its message quotes the text around the error, which can
        // hold a token. This cause says only what went wrong and where.
        {
          cause: new Error(
            `JSON with comments (JSONC) parse error ${printParseErrorCode(problem.error)} at ${positionOf(text, problem.offset)}`,
          ),
        },
      );
    }
    const found = jsonMcpEntriesIn(jsonc, locations);
    if (found.length === 0) return NO_MCP_ENTRY;
    const { entries, remedy } = named(found);
    return mcpEntryKept(
      path,
      `${path} is JSON with comments (JSONC), not plain JSON. eject would rewrite the whole file to remove ${entries} and lose the comments, so it never rewrites this file. ${remedy}`,
    );
  }
  const found = jsonMcpEntriesIn(config, locations);
  if (found.length === 0) return NO_MCP_ENTRY;
  if (!inside) return mcpEntryOutside(path);
  const edited = found.filter(
    ({ location, entry: calavera }) => !isCalaveraMcpEntry(calavera, location.entries),
  );
  const unedited = found.filter((each) => !edited.includes(each));
  /** @type {EjectReport[]} */
  const reported = edited.map(({ location, entry: calavera }) => ({
    path,
    reason: `The calavera entry under ${location.name} in ${path} ${pinsUnpublishedVersion(calavera, location.entries) ? UNPUBLISHED_PIN : "differs from the launch command Calavera writes for every package manager"}, so eject treats it as edited and leaves it. Remove it yourself if you no longer want it.`,
  }));
  if (unedited.length === 0) return { items: [], reported };
  const formatter = await loadFormatter();
  // A harness file can hold tokens, so the problem names the line of a number, not the number.
  const loss = await rewriteLossProblem(text, path, formatter, { withoutValues: true });
  if (loss !== undefined) {
    const { entries, remedy } = named(unedited);
    return mcpEntryKept(
      path,
      `${path} ${loss}. eject rewrites the whole file to remove ${entries}, so it leaves the file as it is rather than change that. ${remedy}`,
    );
  }

  // `jsonMcpEntriesIn` found an object in `config`, so `config` is an object too.
  const next = structuredClone(/** @type {Record<string, unknown>} */ (config));
  /** @param {unknown} root @param {string[]} keys @returns {unknown} */
  const valueAt = (root, keys) =>
    keys.reduce((value, key) => (isPlainObject(value) ? value[key] : undefined), root);
  /** @param {string[]} keys */
  const objectAt = (keys) => {
    const value = valueAt(next, keys);
    return isPlainObject(value) ? value : undefined;
  };
  for (const { location } of unedited) delete objectAt(location.keys)?.calavera;
  // The keys of each member that goes: the entry, or the outermost object its removal emptied. An
  // object already gone was emptied by the removal of another entry inside it.
  const removedPaths = unedited.map(({ location }) => {
    let removedKeys = [...location.keys, "calavera"];
    for (let keys = location.keys; keys.length > 0; keys = keys.slice(0, -1)) {
      const object = objectAt(keys);
      if (object !== undefined && Object.keys(object).length > 0) break;
      delete objectAt(keys.slice(0, -1))?.[/** @type {string} */ (keys.at(-1))];
      removedKeys = keys;
    }
    return removedKeys;
  });
  // Every entry is deleted before any object is checked for emptiness, so two entries whose
  // removal empties the same object both end at it, and it is listed once. The saved patch for
  // #1204 listed it once for each entry.
  const removed = [...new Map(removedPaths.map((keys) => [JSON.stringify(keys), keys])).values()];
  // Calavera keeps no record of adding `$schema`, so a `$schema` with the value it writes, in a
  // file that holds nothing else, counts as Calavera's (ADR-0017, Decision 2).
  if (schema !== undefined && Object.keys(next).length === 1 && next.$schema === schema) {
    delete next.$schema;
    removed.push(["$schema"]);
  }
  const contents = await writeJSON(next, path, formatter);
  const tree = /** @type {import("jsonc-parser").Node} */ (parseTree(text));
  // `JSON.parse` read the file, so the tree has every removed member. They are listed in the order
  // the file holds them.
  const members = removed
    .map((keys) => ({
      keys,
      node: /** @type {import("jsonc-parser").Node} */ (
        /** @type {import("jsonc-parser").Node} */ (findNodeAtLocation(tree, keys)).parent
      ),
    }))
    .toSorted((a, b) => a.node.offset - b.node.offset);
  const lineAt = (/** @type {number} */ offset) => text.slice(0, offset).split("\n").length - 1;
  const around = aroundLines(
    text.split("\n"),
    lineAt(Math.min(...members.map(({ node }) => node.offset))),
    lineAt(Math.max(...members.map(({ node }) => node.offset + node.length))),
    jsonValuesHidden,
  );
  /** @type {EjectItem} */
  const item = {
    kind: "mcp-entry",
    path,
    action: "edit",
    edits: "unedited",
    matchesRecords: true,
    removedLines: members.flatMap(({ keys }) =>
      `${JSON.stringify(keys.at(-1))}: ${toJSONText(valueAt(config, keys))}`.split("\n"),
    ),
    contents,
    around,
    seen: textSeen(identity, text),
  };
  if ((await writeJSON(config, path, formatter)) !== text) {
    // The rewrite changes text Calavera did not write, which only an approval of the text
    // afterward covers, so `--yes` leaves it (ADR-0017, Decision 5).
    item.matchesRecords = false;
    item.note = `eject rewrites the whole of ${path} through the project's formatter (${formatter.description}), which also changes the layout of the rest of the file. eject does not print the rest of the file, because it can hold other servers' settings and tokens; review it with git diff after eject.`;
  }
  return { items: [item], reported };
}

/**
 * Whether `contents`, the Codex file once Calavera's table is removed, holds exactly what `text`
 * holds without the `calavera` entry: the same settings, and nothing else gone. An explicit
 * `[mcp_servers]` header the person wrote may stay as an empty table.
 *
 * @param {string} text
 * @param {string} contents
 */
function removesOnlyTheEntry(text, contents) {
  /** @type {Record<string, unknown>} */
  let after;
  try {
    after = parseToml(contents);
  } catch {
    // The result can fail to parse: a key the person added after Calavera's lines moves into the
    // table above once those lines go, and that table may already hold the key. Removing the
    // lines would then break the file, so the entry is not Calavera's text alone.
    return false;
  }
  const expected = parseToml(text);
  delete (/** @type {Record<string, unknown>} */ (expected.mcp_servers).calavera);
  if (isDeepStrictEqual(after, expected)) return true;
  // Without an explicit `[mcp_servers]` header, the table goes once `calavera` is its only entry.
  // When it holds other servers, `after` still holds them, so this comparison fails as it should.
  delete expected.mcp_servers;
  return isDeepStrictEqual(after, expected);
}

/**
 * Plans the `[mcp_servers.calavera]` table in `.codex/config.toml`. The file is parsed as TOML with
 * `smol-toml`, and a file that is not TOML is a hard stop, with the line and column where the
 * parser stopped, and never its message, which quotes the file's lines, as the cause
 * (ADR-0017, Decision 7). The entry is unedited when the file holds the table Calavera writes
 * for some package manager, with the pinned version normalized (owner decision of 2026-11-17)
 * and published on npm (ADR-0017, Amendment 6), and removing that text removes the whole entry
 * and nothing else, which parsing the result shows. Any other entry is kept and reported as edited, such as one with another key, a
 * subtable, a comment inside the table, or another layout or header spelling: removing Calavera's
 * lines would then leave part of the entry behind, or the lines are not there to remove. Text that
 * only looks like the table, such as lines inside a multi-line string, is never removed either.
 *
 * `eject` removes the table's lines, and the blank line Calavera added before them, so every other
 * line, comments included, stays.
 *
 * @param {string} path
 * @param {import("./utils/mcp-config.js").McpLaunchCommand[]} entries The launch command for
 *   each package manager, from `calaveraMcpEntries`.
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planCodexMcpEntry(path, entries) {
  const entry = await readTextEntry(path);
  if (entry?.text === undefined) return NO_MCP_ENTRY;
  const { identity, text } = entry;
  const inside = await insideProject(path);
  /** @type {Record<string, unknown>} */
  let config;
  try {
    config = parseToml(text);
  } catch (error) {
    // eject never changes a file outside the project, so it has no need to read it.
    if (!inside) return mcpEntryOutside(path);
    throw new Error(
      `eject stopped before removing anything: ${path} cannot be parsed as TOML${tomlPosition(error, " at ")}. Correct the file, then run eject again.`,
      // Never smol-toml's own error: its message carries a code frame of the file's lines, which
      // can hold a token. This cause says only where the parser stopped.
      { cause: new Error(`TOML parse error${tomlPosition(error, " at ")}`) },
    );
  }
  const servers = serversWithEntry(config, "mcp_servers");
  if (servers === undefined) return NO_MCP_ENTRY;
  if (!inside) return mcpEntryOutside(path);
  const why = pinsUnpublishedVersion(servers.calavera, entries)
    ? UNPUBLISHED_PIN
    : "differs from the table Calavera writes for every package manager";
  const edited = mcpEntryKept(
    path,
    `The ${CODEX_TABLE_HEADER} table in ${path} ${why}, so eject treats it as edited and leaves it. Remove it yourself if you no longer want it.`,
  );
  const expected = entries.map(createCodexMcpTomlBlock);
  const writtenPin = writtenVersion(entries);
  const lines = text.split("\n");
  const bare = lines.map((line) => line.replace(/\r$/, ""));
  for (const start of bare.keys()) {
    for (const block of expected) {
      const written = block.trimEnd().split("\n");
      const end = start + written.length - 1;
      const table = bare.slice(start, end + 1);
      // A table that pins a version npm does not have, or holds the placeholder, normalizes to
      // undefined, which equals no written table (#1219).
      if (
        normalizePublishedPin(table.join("\n"), writtenPin) !==
        normalizePinnedVersion(written.join("\n"))?.normalized
      ) {
        continue;
      }
      const contents = withoutLines(lines, start, end);
      if (!removesOnlyTheEntry(text, contents)) continue;
      return {
        items: [
          {
            kind: "mcp-entry",
            path,
            action: "edit",
            edits: "unedited",
            matchesRecords: true,
            removedLines: table,
            contents,
            around: aroundLines(bare, start, end, tomlNeighborHidden(bare)),
            seen: textSeen(identity, text),
          },
        ],
        reported: [],
      };
    }
  }
  return edited;
}

/**
 * Where an MCP entry sits in its file, for the list a person approves: the first line of
 * Calavera's text, and the nearest line that is not blank before it and after it, each with its
 * values hidden by `hide`. The rest of the file is never shown, because it can hold the person's
 * other servers and the tokens in their `env` or `headers` (ADR-0017, Amendment 3).
 *
 * @param {string[]} lines The file's lines.
 * @param {number} start The index of the first line of Calavera's text.
 * @param {number} end The index of its last line.
 * @param {(line: string, index: number) => string} hide Hides a line, given its index.
 * @returns {{ line: number, before?: string, after?: string }}
 */
function aroundLines(lines, start, end, hide) {
  /** @param {number} from @param {number} step */
  const nearest = (from, step) => {
    for (let index = from; index >= 0 && index < lines.length; index += step) {
      const line = (lines[index] ?? "").replace(/\r$/, "").trim();
      if (line !== "") return hide(line, index);
    }
    return undefined;
  };
  const before = nearest(start - 1, -1);
  const after = nearest(end + 1, 1);
  return {
    line: start + 1,
    ...(before === undefined ? {} : { before }),
    ...(after === undefined ? {} : { after }),
  };
}

// The token kinds of `jsonc-parser`'s scanner. Its `SyntaxKind` is a TypeScript `const enum`,
// which does not exist at run time, so the values from its type declarations are written here.
const JSON_TOKEN = Object.freeze({
  openBrace: 1,
  closeBrace: 2,
  openBracket: 3,
  closeBracket: 4,
  comma: 5,
  colon: 6,
  string: 10,
  unknown: 16,
  end: 17,
});
/** @type {Map<number, string>} */
const JSON_PUNCTUATION = new Map([
  [JSON_TOKEN.openBrace, "{ "],
  [JSON_TOKEN.closeBrace, " }"],
  [JSON_TOKEN.openBracket, "["],
  [JSON_TOKEN.closeBracket, "]"],
  [JSON_TOKEN.comma, ", "],
  [JSON_TOKEN.colon, ": "],
]);

/**
 * A line of a JSON file with every value hidden: the scanner splits the line into tokens, a
 * string the next token's colon makes a key stays, punctuation stays, and every other string,
 * number, `true`, `false`, and `null` becomes `…`. A line the scanner cannot read is hidden whole.
 * eject edits only a file that parsed as plain JSON, so a line holds no comments.
 *
 * @param {string} line
 */
function jsonValuesHidden(line) {
  const scanner = createScanner(line, true);
  /** @type {{ kind: number, value: string }[]} */
  const tokens = [];
  for (let kind = scanner.scan(); kind !== JSON_TOKEN.end; kind = scanner.scan()) {
    if (kind === JSON_TOKEN.unknown || scanner.getTokenError() !== 0) return "…";
    tokens.push({ kind, value: scanner.getTokenValue() });
  }
  const text = tokens
    .map(({ kind, value }, index) => {
      const punctuation = JSON_PUNCTUATION.get(kind);
      if (punctuation !== undefined) return punctuation;
      const isKey = kind === JSON_TOKEN.string && tokens[index + 1]?.kind === JSON_TOKEN.colon;
      return isKey ? JSON.stringify(value) : "…";
    })
    .join("")
    // An empty object, where the closing brace follows the opening one, needs no double space.
    .replaceAll("{  }", "{}")
    .trim();
  return text === "" ? "…" : text;
}

// A complete TOML table header, `[table]` or `[[array.of.tables]]`, whose keys are bare, basic, or
// literal, followed by nothing or a comment. Group 1 is the header without the comment.
const TOML_KEY = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\\n]|\\.)*"|'[^'\n]*')`;
const TOML_HEADER = new RegExp(
  String.raw`^(\[\s*${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*\s*\]|\[\[\s*${TOML_KEY}(?:\s*\.\s*${TOML_KEY})*\s*\]\])\s*(?:#.*)?$`,
);

/**
 * Hides a TOML line around Calavera's table, for the file whose lines are `lines`. Only a complete
 * table header prints, without its comment; every other line is hidden whole. A line that only
 * looks like a header, inside a multi-line string or array, is hidden too: the text before it
 * then does not parse as TOML on its own.
 *
 * @param {string[]} lines
 * @returns {(line: string, index: number) => string}
 */
function tomlNeighborHidden(lines) {
  return (line, index) => {
    const header = TOML_HEADER.exec(line)?.[1];
    if (header === undefined) return "…";
    try {
      parseToml(header);
      parseToml(lines.slice(0, index).join("\n"));
    } catch {
      return "…";
    }
    return header;
  };
}

/**
 * Plans the `calavera` entry in each MCP harness file (ADR-0017, Decision 2).
 *
 * @param {AgentGuidanceTexts} guidance
 * @param {() => Promise<import("./utils/project-formatter.js").ProjectFormatter>} loadFormatter
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function planMcpEntries(guidance, loadFormatter) {
  const launches = guidance.mcpLaunchCommands;
  /** @type {Promise<import("./utils/project-formatter.js").ProjectFormatter> | undefined} */
  let formatter;
  // Loaded once, and only when a JSON harness file holds an entry to remove.
  const loadOnce = () => (formatter ??= loadFormatter());
  const parts = [];
  for (const harness of MCP_HARNESSES) {
    const path = /** @type {string} */ (projectMcpConfigPath(harness));
    if (harness === "codex") {
      const entries = /** @type {import("./utils/mcp-config.js").McpLaunchCommand[]} */ (
        calaveraMcpEntries(harness, launches)
      );
      parts.push(await planCodexMcpEntry(path, entries));
    } else if (harness === "opencode") {
      parts.push(
        await planJsonMcpEntry(
          path,
          openCodeMcpLocations(launches),
          loadOnce,
          OPENCODE_CONFIG_SCHEMA,
        ),
      );
    } else {
      /** @type {JsonMcpLocation} */
      const location = {
        name: "mcpServers",
        keys: ["mcpServers"],
        entries: calaveraMcpEntries(harness, launches),
      };
      parts.push(await planJsonMcpEntry(path, [location], loadOnce));
    }
  }
  return {
    items: parts.flatMap(({ items }) => items),
    reported: parts.flatMap(({ reported }) => reported),
  };
}

/**
 * Splits off the items that change one file through two or more paths, such as `opencode.json`
 * linked to `.mcp.json`. Each edit is built from the file's text at plan time and writes the whole
 * file, so a second write would put back what the first removed, and a delete would remove what
 * an edit keeps. `eject` keeps every such item and reports it, naming each path, rather than merge
 * the changes, because the person decides how the paths should share one file. The real path is
 * where `entryIdentity` resolves the entry. A deleted symbolic link is removed as a link, so it
 * changes no file it leads to and is never grouped.
 *
 * @param {EjectItem[]} items
 * @returns {Promise<{ items: EjectItem[], reported: EjectReport[] }>}
 */
async function withoutSharedFiles(items) {
  /** @type {Map<string, EjectItem[]>} */
  const byFile = new Map();
  for (const item of items) {
    if (item.action === "delete" && (await lstat(item.path)).isSymbolicLink()) continue;
    const real = await realpath(item.path);
    byFile.set(real, [...(byFile.get(real) ?? []), item]);
  }
  const shared = [...byFile.values()].filter(
    (group) => group.length > 1 && group.some(({ action }) => action === "edit"),
  );
  const conflicted = new Set(shared.flat());
  return {
    items: items.filter((item) => !conflicted.has(item)),
    reported: shared.flatMap((group) => {
      const names = group.map(({ path }) => path);
      const both = `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
      return group.map(({ path }) => ({
        path,
        reason: `${both} lead to the same file, so changing it through one path would undo or lose the change through the other. eject leaves ${path} as it is; remove Calavera's text from that file yourself if you no longer want it.`,
      }));
    }),
  };
}

/**
 * The entries of `.agents/calavera/` other than the MCP setup notes. `eject` keeps them, so it
 * keeps the folder too. Listed only when `eject` removes the notes, because otherwise it does not
 * touch the folder.
 *
 * @param {EjectItem[]} items
 * @returns {Promise<string[]>}
 */
async function unnamedMcpNotesEntries(items) {
  if (!items.some(({ kind }) => kind === "mcp-notes")) return [];
  return (await readdir(MCP_NOTES_ROOT))
    .map((name) => `${MCP_NOTES_ROOT}/${name}`)
    .filter((path) => path !== AGENT_BOOTSTRAP_MCP_FILE);
}

/**
 * Plans each extracted package folder, `.calavera/packages/<id>/<version>/`, as one unit. No record
 * checks a whole folder, so every folder needs an interactive approval. For a folder a lock entry
 * names, the payload is checked against the entry's `payloadHash`, with the payload path from the
 * catalog, as apply finds it, not from the folder's editable manifest (ADR-0017, Decision 2). A
 * symbolic link or a file where a folder would be is not a package folder: `eject` keeps it and
 * lists it, and never follows it.
 *
 * @param {import("./artifact-lifecycle.js").ArtifactLockEntry[] | undefined} lockEntries
 * @param {string | undefined} lockProblem
 * @returns {Promise<{ items: EjectItem[], kept: string[] }>}
 */
async function planPackageFolders(lockEntries, lockProblem) {
  /** @type {EjectItem[]} */
  const items = [];
  /** @type {string[]} */
  const kept = [];
  if (!(await present(PACKAGE_PATH))) return { items, kept };
  if (!(await isRealDirectory(PACKAGE_PATH))) {
    kept.push(PACKAGE_PATH);
    return { items, kept };
  }
  for (const id of await readdir(PACKAGE_PATH)) {
    const idPath = `${PACKAGE_PATH}/${id}`;
    if (!(await isRealDirectory(idPath))) {
      kept.push(idPath);
      continue;
    }
    const versions = await readdir(idPath);
    // An empty folder holds no package, so no item names it; it is listed, because it keeps
    // `.calavera/` from becoming empty.
    if (versions.length === 0) kept.push(idPath);
    for (const version of versions) {
      const path = `${idPath}/${version}`;
      if (!(await isRealDirectory(path))) {
        kept.push(path);
        continue;
      }
      const entry = lockEntries?.find(
        (candidate) => candidate.id === id && candidate.version === version,
      );
      const artifact = artifactForId(id);
      /** @type {EjectItem} */
      const item = {
        kind: "package-folder",
        path,
        action: "delete",
        edits: "cannot-detect",
        matchesRecords: false,
      };
      // The plan keeps a link or a file in a package folder's place, so a folder that becomes
      // either after the plan counts as changed, whether or not a lock entry names it.
      const identity = await entryIdentity(path);
      item.seen = identity;
      if (!entry || !artifact) {
        item.reason = !entry
          ? `${lockProblem ?? `No entry in ${LOCK_PATH} names this package folder`}; ${CANNOT_DETECT}.`
          : `The catalog no longer has ${id}, so there is no payload path to check; ${CANNOT_DETECT}.`;
        items.push(item);
        continue;
      }
      const payloadPath = `${path}/${artifact.payload}`;
      const payloadHash = await payloadHashOf(payloadPath);
      item.seen = packageFolderSeen(identity, payloadHash);
      item.payload = {
        path: payloadPath,
        // A missing payload, or an entry without a hash, never counts as unedited.
        edits:
          payloadHash !== undefined && payloadHash === entry.payloadHash ? "unedited" : "edited",
      };
      item.reason = `The payload at ${payloadPath} is ${item.payload.edits}; for the rest of the folder, and for symbolic links under the payload, ${CANNOT_DETECT}.`;
      items.push(item);
    }
  }
  return { items, kept };
}

/**
 * The entries of `.calavera/` that are not part of the footprint. `eject` keeps them, so it keeps
 * `.calavera/` too.
 *
 * @returns {Promise<string[]>}
 */
async function unnamedCalaveraEntries() {
  if (!(await present(CALAVERA_ROOT)) || !(await isRealDirectory(CALAVERA_ROOT))) return [];
  return (await readdir(CALAVERA_ROOT))
    .filter((name) => !CALAVERA_ENTRIES.has(name))
    .map((name) => `${CALAVERA_ROOT}/${name}`);
}

/**
 * Stops `eject` when the recipe path names a `package.json`: eject never writes `package.json`
 * (ADR-0017, Decision 4), so it refuses rather than list one for deletion. It runs before anything
 * else, the recovery of a pending transaction included.
 *
 * @param {string} config The recipe's path.
 */
export function assertEjectConfig(config) {
  if (basename(config) === "package.json") {
    throw new Error(
      `eject stopped before removing anything, because the recipe path ${config} names a package.json, which eject never changes. Pass the path of the Calavera recipe, or leave --config out to use ${CONFIG_FILE}.`,
    );
  }
}

/**
 * Plans the removal of the footprint items Calavera records itself, of the bootstrap's guidance and
 * MCP entries, and of a `.coderabbit.yaml` that Calavera created (ADR-0017, Decision 2). Unless this is a dry run, a pending artifact transaction is
 * recovered first, so the plan describes the project as the rollback left it. Nothing else is
 * written.
 *
 * @param {{ dryRun: boolean, config?: string, guidance: AgentGuidanceTexts, loadFormatter: () => Promise<import("./utils/project-formatter.js").ProjectFormatter> }} options
 *   `config` is the recipe's path. `guidance` holds the texts the bootstrap writes now, from
 *   `agentBootstrapTexts`, which the guidance files and the MCP entries are checked against.
 *   `loadFormatter` gives the project's formatter, which writes a JSON harness file's text once
 *   its entry is removed; it is called only when there is such an entry.
 * @returns {Promise<EjectPlan>}
 */
export async function planEject({ dryRun, config = CONFIG_FILE, guidance, loadFormatter }) {
  assertEjectConfig(config);
  await recoverPendingTransaction(dryRun);

  const hasState = await present(STATE_PATH);
  const hasLock = await present(LOCK_PATH);
  const { value: state, problem: stateProblem } = hasState
    ? await readRecord(STATE_PATH, readState)
    : { value: undefined, problem: undefined };
  const { value: lock, problem: lockProblem } = hasLock
    ? await readRecord(LOCK_PATH, readCheckedLock)
    : { value: undefined, problem: undefined };

  /** @type {EjectItem[]} */
  const items = [];
  /**
   * @param {EjectItemKind} kind
   * @param {string} path
   * @param {Partial<EjectItem>} [extra]
   */
  const own = async (kind, path, extra = {}) => {
    if (!(await present(path))) return;
    // A symbolic link where Calavera keeps its own file or folder leads to content no record
    // covers, wherever it points, so it needs an interactive approval, as a link in place of a
    // package folder or of the base skill does. Approval removes only the link.
    if ((await lstat(path)).isSymbolicLink()) {
      items.push({
        kind,
        path,
        action: "delete",
        ...extra,
        edits: "cannot-detect",
        matchesRecords: false,
        seen: await entryIdentity(path),
        reason: `${path} is a symbolic link, which no record covers; ${CANNOT_DETECT}. eject removes only the link, not what it leads to.`,
      });
      return;
    }
    items.push({
      kind,
      path,
      action: "delete",
      edits: "not-checked",
      matchesRecords: true,
      // Recorded so an entry that changes type after the plan counts as changed: `--yes` never
      // removes a link the person did not approve (ADR-0017, Amendment 2), and no run deletes a
      // folder where the plan saw a file, or the reverse.
      seen: await entryIdentity(path),
      ...extra,
    });
  };

  await own("state", STATE_PATH, stateProblem ? { reason: stateProblem } : {});
  await own("lock", LOCK_PATH, lockProblem ? { reason: lockProblem } : {});
  await own("cache", CACHE_ROOT);
  await own("transient", STAGING_ROOT);
  await own("transient", TRANSACTION_ROOT);
  if (await present(config)) {
    items.push({
      kind: "recipe",
      path: config,
      action: "delete",
      edits: "cannot-detect",
      matchesRecords: false,
      seen: await entryIdentity(config),
      reason: `The project's recipe; ${CANNOT_DETECT}.`,
    });
  }
  items.push(...(await planBaseSkill(state, stateProblem)));
  const cacheBlock = await planCacheBlock(state, stateProblem);
  items.push(...cacheBlock.items);
  const packages = await planPackageFolders(lock?.artifacts, lockProblem);
  items.push(...packages.items);
  const guidanceItems = await planGuidance(guidance);
  items.push(...guidanceItems.items);
  const mcpEntries = await planMcpEntries(guidance, loadFormatter);
  items.push(...mcpEntries.items);
  const codeRabbit = await planCodeRabbitConfig();
  items.push(...codeRabbit.items);
  const separate = await withoutSharedFiles(items);
  items.splice(0, items.length, ...separate.items);

  // Every path is checked before anything is removed, so a link that leads out of the project
  // stops the plan, not a later delete.
  for (const item of items) {
    await assertEjectPath(item);
  }

  const kept = [
    ...(await unnamedCalaveraEntries()),
    ...packages.kept,
    ...(await unnamedMcpNotesEntries(items)),
  ].sort();
  return {
    items,
    reported: [
      ...guidanceItems.reported,
      ...cacheBlock.reported,
      ...mcpEntries.reported,
      ...codeRabbit.reported,
      ...separate.reported,
    ],
    kept,
    nothingToDo: items.length === 0,
  };
}

/**
 * Splits the plan into what this run removes and what it leaves. An approved run removes every
 * item. A `--yes` run removes only the items that match Calavera's records, and keeps a record while
 * an item it leaves still needs that record for its check: the state while it leaves the base skill
 * or the `artifact-cache` block, and the lock while it leaves a package folder (ADR-0017,
 * Decision 5). While it leaves the cache, which it does only when the cache is a symbolic link, it
 * also keeps the cache's `.gitignore` block, so the cache never shows in `git status`, and it keeps
 * the state only while that block is kept (ADR-0017, Amendment 2).
 *
 * @param {EjectPlan} plan
 * @param {{ assumeYes: boolean }} options `assumeYes` for a `--yes` run, false for an approved one.
 * @returns {{ remove: EjectItem[], leave: EjectItem[] }}
 */
export function selectEjectItems(plan, { assumeYes }) {
  if (!assumeYes) return { remove: plan.items, leave: [] };
  const unapproved = plan.items.filter(({ matchesRecords }) => !matchesRecords);
  const leftKinds = new Set(unapproved.map(({ kind }) => kind));
  // ADR-0017 Amendment 2: the block keeps the cache out of `git status`, so it stays while a
  // linked cache does. The state stays while a block that it records stays.
  const keepBlock = leftKinds.has("cache");
  const blockStays = plan.items.some(
    ({ kind, matchesRecords }) => kind === "artifact-cache-block" && (!matchesRecords || keepBlock),
  );
  const keepState = leftKinds.has("base-skill") || blockStays;
  const keepLock = leftKinds.has("package-folder");
  const leaves = (/** @type {EjectItem} */ item) =>
    !item.matchesRecords ||
    (item.kind === "artifact-cache-block" && keepBlock) ||
    (item.kind === "state" && keepState) ||
    (item.kind === "lock" && keepLock);
  return {
    remove: plan.items.filter((item) => !leaves(item)),
    leave: plan.items.filter(leaves),
  };
}

/**
 * The order `eject` removes items in (ADR-0017, Decision 7). The cache goes before its `.gitignore`
 * block, so a run that stops between the two never shows the cache in `git status`. The package
 * folders go before the lock that checks them, and the state goes last, so a run that stops part
 * way leaves every record a remaining item needs, and the next run continues.
 *
 * @type {Record<EjectItemKind, number>}
 */
const STEP_ORDER = {
  cache: 0,
  "artifact-cache-block": 1,
  recipe: 2,
  "base-skill": 2,
  transient: 2,
  "guidance-file": 2,
  "guidance-section": 2,
  "fallback-guidance": 2,
  "mcp-notes": 2,
  "mcp-entry": 2,
  "coderabbit-config": 2,
  "package-folder": 3,
  lock: 4,
  state: 5,
};

/**
 * The items in the order `executeEject` removes them.
 *
 * @param {EjectItem[]} items
 * @returns {EjectItem[]}
 */
export function ejectSteps(items) {
  return [...items].sort((a, b) => STEP_ORDER[a.kind] - STEP_ORDER[b.kind]);
}

/**
 * Removes a folder only when it is empty, and leaves it, with what it holds, otherwise.
 *
 * @param {string} path
 */
async function removeIfEmpty(path) {
  try {
    await rmdir(path);
  } catch (error) {
    const { code } = /** @type {NodeJS.ErrnoException} */ (error);
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOTDIR") {
      throw error;
    }
  }
}

/**
 * Deletes a package folder through `.calavera/.staging/`: the folder is moved there first, which
 * is one rename, and deleted there, so a delete that stops part way leaves a transient folder the
 * next run removes, not a half-removed package folder that its lock entry still names.
 *
 * @param {string} path
 */
async function removePackageFolder(path) {
  await mkdir(STAGING_ROOT, { recursive: true });
  const holder = await mkdtemp(join(STAGING_ROOT, "eject-"));
  const staged = join(holder, "package");
  await rename(path, staged);
  await rm(holder, { recursive: true, force: true });
}

/**
 * What the item's check reads now, to compare with what it read when the plan was made.
 *
 * @param {EjectItem} item
 * @returns {Promise<string | undefined>}
 */
async function currentlySeen(item) {
  // The check depends on the item's kind, never on the text it recorded: the cache block's
  // `seen` is the whole `.gitignore`, which may hold any text.
  switch (item.kind) {
    case "state":
    case "lock":
    case "cache":
    case "transient":
    case "recipe":
      return entryIdentity(item.path);
    case "artifact-cache-block":
    case "guidance-file":
    case "guidance-section":
    case "fallback-guidance":
    case "mcp-notes":
    case "mcp-entry":
    case "coderabbit-config": {
      // The plan read the text through a link too, so the text is read whenever the path leads
      // to a file. A path that no longer leads to a file is reported as changed, not read.
      const entry = await readTextEntry(item.path);
      // Gone since `alreadyGone` looked: a value no plan records, so it counts as changed.
      return entry === undefined
        ? textSeen("missing", undefined)
        : textSeen(entry.identity, entry.text);
    }
    case "base-skill":
      return (await baseSkillCheck()).seen;
    case "package-folder": {
      const identity = await entryIdentity(item.path);
      return item.payload
        ? packageFolderSeen(identity, await payloadHashOf(item.payload.path))
        : identity;
    }
  }
}

/**
 * The items `item` depends on: removing it while one of them failed would break Decision 7's
 * guarantees. The `.gitignore` block stays while the cache it hides stays, the lock stays while a
 * package folder it checks stays, and the state stays while the base skill or the block it
 * checks stays.
 *
 * @param {EjectItem} item
 * @returns {EjectItemKind[]}
 */
function dependsOn(item) {
  if (item.kind === "artifact-cache-block") return ["cache"];
  if (item.kind === "lock") return ["package-folder"];
  if (item.kind === "state") return ["base-skill", "artifact-cache-block"];
  return [];
}

/**
 * Removes `items`, which the person approved or which match Calavera's records, in the order
 * `ejectSteps` gives. First it reads each item's check again, and removes nothing when an item
 * changed since the plan, so it never removes text the approved list did not show. An item whose
 * removal fails does not stop the others; only the items that depend on it are skipped. Then it
 * removes the package ID folders it emptied, `.calavera/packages/`, `.calavera/.staging/`, and
 * `.calavera/`, when they are empty, and `.agents/calavera/` when it removed the MCP setup notes
 * from it and nothing else remains (ADR-0017, Decision 2). A folder that still holds anything
 * stays.
 *
 * @param {EjectItem[]} items
 * @returns {Promise<EjectOutcome>}
 */
export async function executeEject(items) {
  const changed = [];
  for (const item of items) {
    // An item already gone counts as removed, so its check has nothing left to compare.
    if (await alreadyGone(item)) continue;
    // An item without a check has no `seen`, and `currentlySeen` returns undefined for it too.
    if ((await currentlySeen(item)) !== item.seen) {
      changed.push(item.path);
    }
  }
  if (changed.length > 0) {
    throw new Error(
      `eject stopped before removing anything, because ${changed.join(", ")} changed since eject listed what it would remove. Run eject again to see the new list.`,
    );
  }

  /** @type {EjectOutcome} */
  const outcome = { removed: [], failed: [], skipped: [] };
  /** @type {Set<EjectItemKind>} */
  const leftKinds = new Set();
  for (const item of ejectSteps(items)) {
    const blocker = dependsOn(item).find((kind) => leftKinds.has(kind));
    if (blocker !== undefined) {
      leftKinds.add(item.kind);
      outcome.skipped.push({
        item,
        reason: `Kept, because removing the ${blocker} item it depends on failed. Run eject again once that is fixed.`,
      });
      continue;
    }
    // ADR-0017 Decision 2: a footprint item that is already gone counts as removed, so an item the
    // person deleted after the plan is not a failure, and the items that depend on it go too.
    if (await alreadyGone(item)) {
      outcome.removed.push(item);
      continue;
    }
    try {
      const target = await assertEjectPath(item);
      if (item.action === "edit") {
        await writeFile(target, /** @type {string} */ (item.contents));
      } else if (item.kind === "package-folder") {
        await removePackageFolder(item.path);
      } else {
        await rm(target, { recursive: true, force: true });
      }
      outcome.removed.push(item);
    } catch (error) {
      leftKinds.add(item.kind);
      outcome.failed.push({
        item,
        error: error instanceof Error ? error : new Error(String(error)),
      });
    }
  }
  if (items.length === 0) return outcome;

  const idFolders = new Set(
    outcome.removed
      .filter(({ kind }) => kind === "package-folder")
      .map(({ path }) => path.slice(0, path.lastIndexOf("/"))),
  );
  for (const folder of idFolders) await removeIfEmpty(folder);
  await removeIfEmpty(PACKAGE_PATH);
  await removeIfEmpty(STAGING_ROOT);
  await removeIfEmpty(CALAVERA_ROOT);
  if (outcome.removed.some(({ kind }) => kind === "mcp-notes")) {
    await removeIfEmpty(MCP_NOTES_ROOT);
  }
  return outcome;
}

/**
 * Whether a `package.json` script runs Calavera: either of the package's two executables,
 * `create-project-calavera` and `create-project-calavera-mcp`, directly or through a package
 * runner such as `npx` or `pnpm dlx`, or the package through `npm create`, `npm init`, `yarn
 * create`, `pnpm create`, or `bun create`, which run `create-project-calavera`. `eject` reports such
 * a script and never changes it (ADR-0017, Decision 4). A scoped package of the same name, such as
 * `@someone/create-project-calavera`, is another package, and a longer name, or a folder of that
 * name in a path, is another file. A bare word such as `cd create-project-calavera` still counts,
 * which only adds a report the person can ignore.
 *
 * @param {string} value The script's command.
 */
export function scriptRunsCalavera(value) {
  return (
    CALAVERA_EXECUTABLE.test(value) || CALAVERA_INSTALLED.test(value) || CALAVERA_CREATE.test(value)
  );
}

// Not after a name character or a scope, and not followed by a longer name, a file extension, or a
// path separator, so a folder of that name in a path does not count.
const CALAVERA_EXECUTABLE =
  /(?<![\w.@-])(?<!@[\w.-]+\/)create-project-calavera(?:-mcp)?(?![\w/-]|\.\w)/;
// The installed package's folder, which a script runs a file from, such as
// `node node_modules/create-project-calavera/bin/create-project-calavera.js`.
const CALAVERA_INSTALLED = /(?<![\w.@-])node_modules\/create-project-calavera\//;
const CALAVERA_CREATE = /(?<![\w.@/-])(?:create|init)\s+project-calavera(?![\w-]|\.\w)/;

/** The executable every MCP registration Calavera writes launches, in each harness file. */
const MCP_EXECUTABLE = "create-project-calavera-mcp";

/**
 * The footprint paths of ADR-0017 Decision 2 that exist in `directory`, relative to it, for a
 * directory `eject` does not run in: the repository root seen from a workspace package, or a
 * workspace package seen from the root (Decision 8). `eject` only names them, so the person can
 * run `eject` there too; it removes nothing there, so this check needs no record. A path counts
 * when it is one only Calavera writes, or when the file holds what Calavera writes into it: a
 * guidance marker in `AGENTS.md`, the `artifact-cache` block marker in `.gitignore`, the MCP
 * executable in a harness file, and Calavera's first line in `.coderabbit.yaml`.
 *
 * @param {string} directory
 * @returns {Promise<string[]>}
 */
export async function footprintIn(directory) {
  /** @param {string} path */
  const at = (path) => join(directory, path);
  /** @param {string} path */
  const textOf = (path) => readFile(at(path), "utf8").catch(() => undefined);
  /** @type {string[]} */
  const found = [];
  for (const path of [
    STATE_PATH,
    LOCK_PATH,
    CACHE_ROOT,
    PACKAGE_PATH,
    STAGING_ROOT,
    TRANSACTION_ROOT,
    TRANSACTION_PATH,
    CONFIG_FILE,
    BASE_SKILL_PATH,
    AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE,
    AGENT_BOOTSTRAP_MCP_FILE,
  ]) {
    if (await present(at(path))) found.push(path);
  }
  const guidanceText = await textOf(AGENT_BOOTSTRAP_GUIDANCE_FILE);
  if (
    guidanceText?.includes(AGENT_BOOTSTRAP_MARKER) ||
    guidanceText?.includes(AGENT_BOOTSTRAP_SECTION_START)
  ) {
    found.push(AGENT_BOOTSTRAP_GUIDANCE_FILE);
  }
  if ((await textOf(GITIGNORE_PATH))?.includes(`calavera:${ARTIFACT_CACHE_BLOCK}:`)) {
    found.push(GITIGNORE_PATH);
  }
  for (const harness of MCP_HARNESSES) {
    const path = /** @type {string} */ (projectMcpConfigPath(harness));
    if ((await textOf(path))?.includes(MCP_EXECUTABLE)) found.push(path);
  }
  const codeRabbit = await textOf(CODE_RABBIT_CONFIG_PATH);
  if (codeRabbit?.split("\n", 1)[0]?.replace(/\r$/, "") === CODE_RABBIT_CONFIG_FIRST_LINE) {
    found.push(CODE_RABBIT_CONFIG_PATH);
  }
  return found;
}
