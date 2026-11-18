// @ts-check

// ADR-0017: `eject` removes the files and the text Calavera keeps in a project to manage it, its
// footprint, and keeps the tooling Calavera installed. This module plans and carries out the
// removal of the items Calavera records itself: the state, the recipe, the artifact lock and the
// extracted package folders, the artifact cache and the transient folders, the base Calavera
// skill, and the `artifact-cache` block in `.gitignore`. The guidance, the MCP entries, and
// `.coderabbit.yaml` follow in later layers of #678, and the command is registered last, so nothing
// offers `eject` before it removes the whole footprint.
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
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { hashArtifactPayload } from "@schalkneethling/calavera-artifact-core/registry";

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
import { findBlock } from "./utils/marked-block.js";

const CALAVERA_ROOT = ".calavera";
// Where `eject` moves a package folder before it deletes it, so a delete that stops part way
// leaves the folder either whole in `.calavera/packages/` or here, never half removed. An earlier
// run's leftovers here are transient, so the next run removes them (ADR-0017, Decision 7).
const STAGING_ROOT = ".calavera/.staging";
// The path the bootstrap installs the base Calavera skill to, and that `skill-calavera` installs to
// when a recipe selects it.
const BASE_SKILL_PATH = ".agents/skills/calavera";

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
 * @typedef {"state" | "lock" | "recipe" | "cache" | "transient" | "base-skill" | "artifact-cache-block" | "package-folder"} EjectItemKind
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
 * @property {string} [seen] What the item's check read when the plan was made: the file's text for
 *   an edit, the installed hash for the base skill, and the payload hash for a package folder.
 *   `executeEject` reads it again and removes nothing when any item changed since the plan.
 *
 * @typedef {object} EjectOutcome What `executeEject` did with each item it was given.
 * @property {EjectItem[]} removed
 * @property {{ item: EjectItem, error: Error }[]} failed Items whose removal failed, with the cause.
 * @property {{ item: EjectItem, reason: string }[]} skipped Items left because an item they depend
 *   on failed: the record a failed item still needs, or the `.gitignore` block of a cache that
 *   could not be deleted.
 *
 * @typedef {object} EjectPlan
 * @property {EjectItem[]} items Every footprint item that exists, in no particular order.
 * @property {string[]} kept Files in `.calavera/` that `eject` does not name, so it keeps them and
 *   the folders that hold them.
 * @property {boolean} nothingToDo Whether no footprint item exists.
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

/** The base skill's hash as `hashAiInstall` computes it, or why it could not be computed. */
async function baseSkillHash() {
  try {
    return await hashAiInstall("skill", BASE_SKILL_PATH);
  } catch (error) {
    return `unreadable: ${messageOf(error)}`;
  }
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
  if (!record) {
    return [
      {
        ...base,
        edits: "edited",
        matchesRecords: false,
        reason:
          stateProblem ??
          `${STATE_PATH} holds no record of the base Calavera skill, so eject cannot tell whether you edited it.`,
      },
    ];
  }
  const installed = await baseSkillHash();
  return installed === record.hash
    ? [{ ...base, edits: "unedited", matchesRecords: true, seen: installed }]
    : [
        {
          ...base,
          edits: "edited",
          matchesRecords: false,
          seen: installed,
          reason: `The base Calavera skill has local edits (installed=${installed}, state=${record.hash}).`,
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
    seen: text,
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
      if (!entry || !artifact) {
        item.reason = !entry
          ? `${lockProblem ?? `No entry in ${LOCK_PATH} names this package folder`}; ${CANNOT_DETECT}.`
          : `The catalog no longer has ${id}, so there is no payload path to check; ${CANNOT_DETECT}.`;
        items.push(item);
        continue;
      }
      const payloadPath = `${path}/${artifact.payload}`;
      const payloadHash = await payloadHashOf(payloadPath);
      item.seen = payloadHash ?? "missing";
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
 * Plans the removal of the footprint items Calavera records itself (ADR-0017, Decision 2). Unless
 * this is a dry run, a pending artifact transaction is recovered first, so the plan describes the
 * project as the rollback left it. Nothing else is written.
 *
 * @param {{ dryRun: boolean, config?: string }} options `config` is the recipe's path.
 * @returns {Promise<EjectPlan>}
 */
export async function planEject({ dryRun, config = CONFIG_FILE }) {
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
    if (await present(path)) {
      items.push({
        kind,
        path,
        action: "delete",
        edits: "not-checked",
        matchesRecords: true,
        ...extra,
      });
    }
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
      reason: `The project's recipe; ${CANNOT_DETECT}.`,
    });
  }
  items.push(...(await planBaseSkill(state, stateProblem)));
  items.push(...(await planCacheBlock(state, stateProblem)));
  const packages = await planPackageFolders(lock?.artifacts, lockProblem);
  items.push(...packages.items);

  // Every path is checked before anything is removed, so a link that leads out of the project
  // stops the plan, not a later delete.
  for (const { path } of items) {
    await assertWorkspacePath(path, process.cwd(), "Eject path");
  }

  const kept = [...(await unnamedCalaveraEntries()), ...packages.kept].sort();
  return { items, kept, nothingToDo: items.length === 0 };
}

/**
 * Splits the plan into what this run removes and what it leaves. An approved run removes every
 * item. A `--yes` run removes only the items that match Calavera's records, and keeps a record while
 * an item it leaves still needs that record for its check: the state while it leaves the base skill
 * or the `artifact-cache` block, and the lock while it leaves a package folder (ADR-0017,
 * Decision 5).
 *
 * @param {EjectPlan} plan
 * @param {{ assumeYes: boolean }} options `assumeYes` for a `--yes` run, false for an approved one.
 * @returns {{ remove: EjectItem[], leave: EjectItem[] }}
 */
export function selectEjectItems(plan, { assumeYes }) {
  if (!assumeYes) return { remove: plan.items, leave: [] };
  const unapproved = plan.items.filter(({ matchesRecords }) => !matchesRecords);
  const leftKinds = new Set(unapproved.map(({ kind }) => kind));
  const keepState = leftKinds.has("base-skill") || leftKinds.has("artifact-cache-block");
  const keepLock = leftKinds.has("package-folder");
  const leaves = (/** @type {EjectItem} */ item) =>
    !item.matchesRecords ||
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
  if (item.kind === "artifact-cache-block") {
    return (await present(item.path)) ? readFile(item.path, "utf8") : "missing";
  }
  if (item.kind === "base-skill") return baseSkillHash();
  if (item.payload) return (await payloadHashOf(item.payload.path)) ?? "missing";
  return undefined;
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
 * `.calavera/`, when they are empty (ADR-0017, Decision 2). A folder that still holds anything
 * stays.
 *
 * @param {EjectItem[]} items
 * @returns {Promise<EjectOutcome>}
 */
export async function executeEject(items) {
  const changed = [];
  for (const item of items) {
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
    try {
      const target = await assertWorkspacePath(item.path, process.cwd(), "Eject path");
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
  return outcome;
}
