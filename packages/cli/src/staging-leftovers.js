// @ts-check
// Releases before #988 restored a locked artifact package through `.calavera/.staging/<id>/` and
// left that folder behind, where Git does not ignore it. Apply removes such a folder only when its
// contents match the package the lock records for `<id>`, and reports every other entry of
// `.calavera/.staging/` without removing it (#1034, owner decision of 2026-11-18). `eject` uses the
// same folder for the package folders it removes, and removes the whole folder as transient
// (ADR-0017, Decision 7, and Amendment 4).
import { createHash } from "node:crypto";
import { lstat, mkdtemp, readFile, readdir, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { artifactRegistry, readLock, rebuildLockedPackage } from "./artifact-lifecycle.js";

const CALAVERA_ROOT = ".calavera";
export const STAGING_ROOT = `${CALAVERA_ROOT}/.staging`;

const REMEDY = "Remove it yourself if you no longer need it.";

/**
 * An entry of `.calavera/.staging/`, or the folder itself when apply cannot look inside it, and
 * what apply does with it. `remove` is a copy of the locked package `package` names, which apply
 * removes; `keep` is anything else, which apply leaves in place. `reason` says why, and for an
 * entry apply keeps, what the person can do.
 *
 * @typedef {{ path: string, action: "remove" | "keep", package?: string, reason: string }} StagingLeftover
 * @typedef {{ items: StagingLeftover[], expected: Map<string, Map<string, string>> }} StagingLeftoverPlan
 *   `expected` maps the path of each entry apply removes to the contents it must still hold just
 *   before the removal, as `contentsOf` reads them.
 */

/**
 * Lists the entries of `.calavera/.staging/` and decides, for each, whether apply removes it. An
 * entry is removed only when it is a real folder, not a symbolic link, inside a real `.calavera`
 * folder, named after an artifact the lock records, and holding exactly the files and folders of
 * that locked package as Calavera rebuilds it from the artifact cache, which checks the payload
 * against the lock's `payloadHash`. Nothing in the project is written; a dry run rebuilds through
 * a copy of the cache. It never throws: an entry it cannot read is kept and reported with the
 * error's code, so a cleanup step never stops apply.
 *
 * @param {{ dryRun: boolean, services?: import("./artifact-lifecycle.js").ArtifactServices, installedIds?: Set<string> }} options
 *   `installedIds` are the artifacts the same apply run installs and locks before this plan. Their
 *   lock entries are left out, so a dry run, whose lock does not hold them yet, and the real run
 *   decide the same: a staging folder named after one is kept.
 * @returns {Promise<StagingLeftoverPlan>}
 */
export async function planStagingLeftovers({ dryRun, services = {}, installedIds = new Set() }) {
  /** @type {StagingLeftoverPlan} */
  const plan = { items: [], expected: new Map() };
  let names;
  /** @type {Map<string, import("./artifact-lifecycle.js").ArtifactLockEntry>} */
  let lockedById;
  try {
    const root = await entryType(STAGING_ROOT);
    if (root === undefined) return plan;
    const parent = await entryType(CALAVERA_ROOT);
    if (parent !== "folder") {
      plan.items.push(
        keep(
          STAGING_ROOT,
          `${CALAVERA_ROOT} is ${describe(parent)}, so apply does not look inside it.`,
        ),
      );
      return plan;
    }
    if (root !== "folder") {
      plan.items.push(
        keep(STAGING_ROOT, `It is ${describe(root)}, so apply does not look inside it.`),
      );
      return plan;
    }
    lockedById = new Map(
      (await readLock()).artifacts
        .filter(({ id }) => !installedIds.has(id))
        .map((entry) => [entry.id, entry]),
    );
    // Sorted, so the dry run and apply list the entries in the same order on every file system.
    names = (await readdir(STAGING_ROOT)).sort();
  } catch (error) {
    plan.items.push(keep(STAGING_ROOT, `Calavera could not read it${codeOf(error)}.`));
    return plan;
  }

  const registry = artifactRegistry(services);
  for (const name of names) {
    const path = `${STAGING_ROOT}/${name}`;
    try {
      await planEntry(plan, path, lockedById.get(name), dryRun, registry);
    } catch (error) {
      plan.items.push(keep(path, `Calavera could not read it${codeOf(error)}.`));
    }
  }
  return plan;
}

/**
 * Adds the item for one entry of `.calavera/.staging/` to `plan`.
 *
 * @param {StagingLeftoverPlan} plan
 * @param {string} path
 * @param {import("./artifact-lifecycle.js").ArtifactLockEntry | undefined} entry The lock entry
 *   named like the entry, if any.
 * @param {boolean} dryRun
 * @param {import("./artifact-lifecycle.js").ArtifactRegistry} registry
 */
async function planEntry(plan, path, entry, dryRun, registry) {
  const type = await entryType(path);
  if (type !== "folder") {
    plan.items.push(keep(path, `It is ${describe(type)}, not a folder an earlier apply left.`));
    return;
  }
  if (!entry) {
    plan.items.push(
      keep(
        path,
        `No package the lock recorded before this run is named ${path.slice(STAGING_ROOT.length + 1)}, so nothing shows Calavera wrote it.`,
      ),
    );
    return;
  }
  const lockedPackage = `${entry.package}@${entry.version}`;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "calavera-staging-check-"));
  try {
    let rebuilt;
    try {
      rebuilt = await contentsOf(
        (await rebuildLockedPackage(entry, temporaryRoot, dryRun, registry)).stage,
      );
    } catch (error) {
      plan.items.push(
        keep(
          path,
          `Calavera could not rebuild ${lockedPackage}, which the lock records, from the artifact cache to compare it with${codeOf(error)}.`,
        ),
      );
      return;
    }
    const difference = firstDifference(await contentsOf(path), rebuilt);
    if (difference !== undefined) {
      plan.items.push(
        keep(
          path,
          `Its contents differ from ${lockedPackage}, which the lock records, starting at ${path}/${difference}.`,
        ),
      );
      return;
    }
    plan.items.push({
      path,
      action: "remove",
      package: lockedPackage,
      reason: `A copy of ${lockedPackage}, which the lock records, that an earlier release of Calavera left after restoring the package.`,
    });
    plan.expected.set(path, rebuilt);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}

/**
 * Removes each entry `plan` marks for removal, after reading it again: an entry that is no longer a
 * real folder inside real `.calavera` and `.calavera/.staging` folders, or whose contents changed
 * after the plan, is kept. Like the plan, it never throws: a check or a removal that fails keeps
 * the entry, reports the error's code, and does not stop the others. `.calavera/.staging/` itself
 * is removed when nothing is left in it. Returns the plan's items with what apply did.
 *
 * @param {StagingLeftoverPlan} plan
 * @returns {Promise<StagingLeftover[]>}
 */
export async function removeStagingLeftovers(plan) {
  /** @type {StagingLeftover[]} */
  const items = [];
  let removed = false;
  for (const item of plan.items) {
    const expected = plan.expected.get(item.path);
    // Only an entry the plan removes has expected contents.
    if (expected === undefined) {
      items.push(item);
      continue;
    }
    let unchanged;
    try {
      unchanged =
        (await entryType(CALAVERA_ROOT)) === "folder" &&
        (await entryType(STAGING_ROOT)) === "folder" &&
        (await entryType(item.path)) === "folder" &&
        firstDifference(await contentsOf(item.path), expected) === undefined;
    } catch (error) {
      items.push(
        keep(item.path, `Calavera could not read it again before removing it${codeOf(error)}.`),
      );
      continue;
    }
    if (!unchanged) {
      items.push(keep(item.path, "It changed after apply planned to remove it."));
      continue;
    }
    try {
      await rm(item.path, { recursive: true });
      removed = true;
      items.push(item);
    } catch (error) {
      items.push({
        path: item.path,
        action: "keep",
        reason: `Calavera could not remove it${codeOf(error)}, so part of it may be left. Remove what is left yourself.`,
      });
    }
  }
  if (removed) {
    // Fails, and keeps the folder, when anything is left in it.
    await rmdir(STAGING_ROOT).catch(() => {});
  }
  return items;
}

/**
 * @param {string} path
 * @param {string} reason
 * @returns {StagingLeftover}
 */
function keep(path, reason) {
  return { path, action: "keep", reason: `${reason} ${REMEDY}` };
}

/**
 * @param {string} path
 * @returns {Promise<"folder" | "file" | "link" | "other" | undefined>} Undefined when nothing is
 *   there.
 */
async function entryType(path) {
  try {
    const stats = await lstat(path);
    if (stats.isSymbolicLink()) return "link";
    if (stats.isDirectory()) return "folder";
    return stats.isFile() ? "file" : "other";
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return undefined;
    throw error;
  }
}

/** @param {"folder" | "file" | "link" | "other" | undefined} type */
function describe(type) {
  return type === "link" ? "a symbolic link" : type === "file" ? "a file" : "not a folder";
}

/**
 * The error's code, such as ENOTCACHED or EACCES, never its message, which can carry a token or a
 * path from the person's npm configuration.
 *
 * @param {unknown} error
 */
function codeOf(error) {
  const code = /** @type {{ code?: unknown }} */ (error)?.code;
  return typeof code === "string" ? ` (${code})` : "";
}

/**
 * Every entry below `root`, by path relative to `root` with `/` between names: a folder, a file
 * with a hash of its bytes, or a symbolic link or any other entry, which an extracted package never
 * holds. A link is never followed, so the walk stays inside `root`. File modes are not compared.
 *
 * @param {string} root
 * @param {string} [prefix] The path of the folder being read, relative to `root`.
 * @param {Map<string, string>} [entries]
 * @returns {Promise<Map<string, string>>}
 */
async function contentsOf(root, prefix = "", entries = new Map()) {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) {
      entries.set(path, "folder");
      await contentsOf(root, path, entries);
    } else if (entry.isFile()) {
      const hash = createHash("sha256")
        .update(await readFile(join(root, path)))
        .digest("hex");
      entries.set(path, `file ${hash}`);
    } else {
      entries.set(path, entry.isSymbolicLink() ? "link" : "other");
    }
  }
  return entries;
}

/**
 * The first path, in sorted order, that one side holds and the other does not, or holds
 * differently; undefined when both hold the same entries. Sorted so the reason names the same path
 * on every file system.
 *
 * @param {Map<string, string>} found
 * @param {Map<string, string>} expected
 */
function firstDifference(found, expected) {
  return [...new Set([...found.keys(), ...expected.keys()])]
    .sort()
    .find((path) => found.get(path) !== expected.get(path));
}
