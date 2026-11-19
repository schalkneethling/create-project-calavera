// @ts-check

// ADR-0017: `eject` removes the files and the text Calavera keeps in a project to manage it, its
// footprint, and keeps the tooling Calavera installed. This module plans and carries out the
// removal of the items Calavera records itself: the state, the recipe, the artifact lock and the
// extracted package folders, the artifact cache and the transient folders, the base Calavera
// skill, and the `artifact-cache` block in `.gitignore`. It also plans the bootstrap's guidance,
// which has no record and is checked against the texts Calavera writes: `AGENTS.md` written as a
// whole file, the marked section in an existing `AGENTS.md`, `AGENTS.calavera.md`, and
// `.agents/calavera/mcp.md`. The MCP entries and `.coderabbit.yaml` follow in later layers of #678,
// and the command is registered last, so nothing offers `eject` before it removes the whole
// footprint.
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
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

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
import { hashAiInstall } from "./ai/artifacts.js";
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
import { findEarlierGuidance } from "./utils/earlier-guidance.js";
import { findBlock, findMarkedBlock } from "./utils/marked-block.js";

const CALAVERA_ROOT = ".calavera";
// Where `eject` moves a package folder before it deletes it, so a delete that stops part way
// leaves the folder either whole in `.calavera/packages/` or here, never half removed. An earlier
// run's leftovers here are transient, so the next run removes them (ADR-0017, Decision 7).
const STAGING_ROOT = ".calavera/.staging";
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
 * @typedef {"state" | "lock" | "recipe" | "cache" | "transient" | "base-skill" | "artifact-cache-block" | "package-folder" | "guidance-file" | "guidance-section" | "fallback-guidance" | "mcp-notes"} EjectItemKind
 *   `guidance-file` is `AGENTS.md` written as a whole file, `guidance-section` the marked section
 *   in an existing `AGENTS.md`, `fallback-guidance` is `AGENTS.calavera.md`, and `mcp-notes` is
 *   `.agents/calavera/mcp.md`.
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
 * @property {{ path: string, edits: "unedited" | "edited" }} [payload] For a package folder that a
 *   lock entry names, the payload checked against the entry's `payloadHash`.
 * @property {string[]} [removedLines] For an edit, the lines it removes, markers excluded.
 * @property {string} [contents] For an edit, the file's text afterward.
 * @property {string} [seen] What the item's check read when the plan was made. For every kind
 *   but the base skill, it starts with the entry identity from `entryIdentity`: a file, a folder,
 *   or a symbolic link and its target. The `artifact-cache` block and the guidance kinds add the
 *   file's text, through `textSeen`, and a package folder that a lock entry names adds its payload
 *   hash. The base skill records its installed hash and the entries that hash does not cover.
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
 * target it points to. An entry that changes type after the plan, such as a folder replaced by a
 * file or by a link, or a link that points elsewhere, gives another value, so `executeEject` sees
 * the change and removes nothing, rather than deleting what the person put there.
 *
 * @param {string} path
 */
async function entryIdentity(path) {
  const stats = await lstat(path);
  // The target is JSON-encoded, so it holds no raw line break and can never run into a value that
  // follows it in a `seen` string.
  if (stats.isSymbolicLink()) return `${LINK_PREFIX}${JSON.stringify(await readlink(path))}`;
  if (stats.isDirectory()) return "folder";
  return stats.isFile() ? "file" : "other";
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
  return {
    hash,
    uncoveredNote: notes.join(" "),
    // Encoded as JSON, so an entry whose name holds a line break never reads as two entries.
    seen: JSON.stringify([hash, uncovered, listProblem]),
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
 * the block ends (ADR-0017, Decision 7).
 *
 * @param {import("./state.js").CalaveraState | undefined} state
 * @param {string | undefined} stateProblem
 * @returns {Promise<EjectItem[]>}
 */
async function planCacheBlock(state, stateProblem) {
  if (!(await present(GITIGNORE_PATH))) return [];
  const identity = await entryIdentity(GITIGNORE_PATH);
  const text = await readFile(GITIGNORE_PATH, "utf8");
  const found = findBlock(GITIGNORE_PATH, text, ARTIFACT_CACHE_BLOCK, "eject");
  if ("reason" in found) {
    throw new Error(`eject stopped before removing anything: ${found.reason}`);
  }
  if (found.startIndex === -1) return [];
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
  return [item];
}

/**
 * Plans a guidance file that `eject` deletes whole when its text is one Calavera wrote. A symbolic
 * link in its place leads to content no record covers, so it needs an interactive approval, and
 * approval removes only the link, as for a link where Calavera keeps its own files.
 *
 * @param {"guidance-file" | "fallback-guidance" | "mcp-notes"} kind
 * @param {string} path
 * @param {{ identity: string, text: string }} entry
 * @param {boolean} written Whether the text is one Calavera wrote.
 * @param {string} [editedReason] Why the text counts as edited; needed only when `written` is
 *   false.
 * @returns {EjectItem}
 */
function guidanceFileItem(kind, path, { identity, text }, written, editedReason) {
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
 * The text of `AGENTS.md` once the guidance section is removed: the markers, the lines between
 * them, and the blank line Calavera added before the start marker go, and every other line stays.
 *
 * @param {import("./utils/marked-block.js").FoundBlock} found
 */
function withoutGuidanceSection(found) {
  const before = found.lines.slice(0, found.startIndex);
  // The bootstrap appends the section after one blank line (`upsertAgentBootstrapGuidanceSection`
  // in index.js).
  if (before.at(-1)?.replace(/\r$/, "") === "") before.pop();
  const after = found.lines.slice(found.endIndex + 1);
  // When the end marker is the file's last line and has no line break, the line before the
  // section still owns the line break that separated the two, so it keeps it. With no line
  // before the section, the pushed line joins to the same empty text.
  if (after.length === 0) after.push("");
  return [...before, ...after].join("\n");
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
        items: [guidanceFileItem("guidance-file", path, { identity, text }, true)],
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
  if (section === guidance.section.replaceAll("\r\n", "\n").trimEnd()) {
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
    items: [guidanceFileItem(kind, path, { identity, text }, written(text), editedReason)],
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
 * Plans the removal of the footprint items Calavera records itself, and of the bootstrap's
 * guidance (ADR-0017, Decision 2). Unless this is a dry run, a pending artifact transaction is
 * recovered first, so the plan describes the project as the rollback left it. Nothing else is
 * written.
 *
 * @param {{ dryRun: boolean, config?: string, guidance: AgentGuidanceTexts }} options `config` is
 *   the recipe's path. `guidance` holds the texts the bootstrap writes now, from
 *   `agentBootstrapTexts`, which the guidance files are checked against.
 * @returns {Promise<EjectPlan>}
 */
export async function planEject({ dryRun, config = CONFIG_FILE, guidance }) {
  // eject never writes package.json (ADR-0017, Decision 4), so a recipe path that names it is
  // refused rather than listed for deletion.
  if (basename(config) === "package.json") {
    throw new Error(
      `eject stopped before removing anything, because the recipe path ${config} names a package.json, which eject never changes. Pass the path of the Calavera recipe, or leave --config out to use ${CONFIG_FILE}.`,
    );
  }
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
  items.push(...(await planCacheBlock(state, stateProblem)));
  const packages = await planPackageFolders(lock?.artifacts, lockProblem);
  items.push(...packages.items);
  const guidanceItems = await planGuidance(guidance);
  items.push(...guidanceItems.items);

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
  return { items, reported: guidanceItems.reported, kept, nothingToDo: items.length === 0 };
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
    case "mcp-notes": {
      // The plan read the text through a link too, so the text is read whenever the path leads
      // to a file. A path that no longer leads to a file is reported as changed, not read.
      const entry = /** @type {{ identity: string, text: string | undefined }} */ (
        await readTextEntry(item.path)
      );
      return textSeen(entry.identity, entry.text);
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
