// @ts-check
import { cp, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

import { artifactForId, artifactForLegacyPath } from "@schalkneethling/calavera-artifact-core";
import {
  extractArtifactPackage,
  hashArtifactPayload,
  resolveArtifactPackage,
} from "@schalkneethling/calavera-artifact-core/registry";
import packageJson from "../package.json" with { type: "json" };

import {
  aiArtifactOutputPaths,
  buildAiApplyResult,
  CODE_RABBIT_CONFIG_PATH,
  hashAiInstall,
  resolveAiArtifacts,
} from "./ai/artifacts.js";
import { createEmptyState, normalizeState } from "./state.js";
import { fileExists } from "./utils/fs.js";

const LOCK_PATH = ".calavera/artifacts.lock.json";
const STATE_PATH = ".calavera/state.json";
const CACHE_PATH = ".calavera/cache/npm";
const PACKAGE_PATH = ".calavera/packages";
const TRANSACTION_PATH = ".calavera/artifact-transaction.json";
const TRANSACTION_ROOT = ".calavera/.transactions";

/**
 * @typedef {{ config: string, dryRun: boolean, artifactAction?: string, artifactId?: string, artifactTag?: "latest" | "next", artifactAll?: boolean, checkUpdates?: boolean }} ArtifactOptions
 * @typedef {{ id: string, type: "skill" | "hook" | "agent", package: string, version: string, resolved: string, integrity: string, tag: "latest" | "next", manifestVersion: number, destination: string, payloadHash: string, target?: string }} ArtifactLockEntry
 * @typedef {{ resolve?: typeof resolveArtifactPackage, extract?: typeof extractArtifactPackage }} ArtifactServices
 * @typedef {{ resolve: typeof resolveArtifactPackage, extract: typeof extractArtifactPackage }} ArtifactRegistry
 * @typedef {{ id: string, target?: string }} ArtifactSelection
 * @typedef {import("./ai/artifacts.js").AiChange} AiChange
 */

/** @param {ArtifactServices} services @returns {ArtifactRegistry} */
function artifactRegistry(services) {
  return {
    resolve: services.resolve ?? resolveArtifactPackage,
    extract: services.extract ?? extractArtifactPackage,
  };
}

/**
 * @param {ArtifactOptions} options
 * @param {ArtifactServices} [services]
 */
export async function runArtifactCommand(options, services = {}) {
  await recoverArtifactTransaction();
  const registry = artifactRegistry(services);
  switch (options.artifactAction) {
    case "migrate":
      return migrateRecipe(options);
    case "status":
    case "doctor":
      return artifactStatus(options, registry);
    case "install":
      return installArtifacts(options, false, registry);
    case "update":
      return installArtifacts(options, true, registry);
    default:
      throw new Error("Artifacts command must be install, status, doctor, migrate, or update.");
  }
}

/**
 * Returns the payload source of every artifact a recipe selects, keyed by artifact ID, for apply.
 * Selections without a lock entry are installed first, as `artifacts install` would: only those
 * selections gain lock entries and outputs, and selections already locked keep their exact locked
 * version. A dry run stages the install in temporary storage and writes nothing to the project.
 * Otherwise the install commits through the artifact transaction, and only after `preflight`
 * accepts the sources of every selection, so a conflict anywhere in the recipe's artifacts stops
 * apply before the install commits. When the install stops, the artifact lock, the artifact
 * outputs, and the Calavera state are left as they were. Call `dispose` once the sources are no
 * longer needed.
 *
 * @param {{ ai?: unknown }} recipe
 * @param {boolean} dryRun
 * @param {ArtifactServices} [services]
 * @param {(sources: Map<string, string>) => Promise<unknown>} [preflight] Checks the complete set of sources before the install commits.
 * @returns {Promise<{ sources: Map<string, string>, installed: ArtifactLockEntry[], changes: AiChange[], dispose: () => Promise<void> }>}
 */
export async function prepareArtifactSources(recipe, dryRun, services = {}, preflight) {
  await recoverArtifactTransaction({ readOnly: dryRun });
  const selections = normalizePackageSelections(recipe.ai);
  const lock = await readLock();
  const lockedIds = new Set(lock.artifacts.map(({ id }) => id));
  const unlocked = selections.filter(({ id }) => !lockedIds.has(id));
  if (unlocked.length === 0) {
    return {
      sources: await lockedArtifactSources(recipe, dryRun, services),
      installed: [],
      changes: [],
      dispose: async () => {},
    };
  }

  // Restore the locked selections first, so a missing locked payload stops apply before the
  // install of the unlocked selections commits.
  const lockedSources = await lockedArtifactSources(
    { ai: selections.filter(({ id }) => lockedIds.has(id)) },
    dryRun,
    services,
  );
  const staged = await installUnlockedArtifacts(
    unlocked,
    lock,
    dryRun,
    artifactRegistry(services),
    preflight && ((stagedSources) => preflight(new Map([...lockedSources, ...stagedSources]))),
  );
  try {
    // A dry run leaves the lock untouched, so the staged install supplies the unlocked sources.
    const installedSources = dryRun
      ? staged.sourcePaths
      : await lockedArtifactSources({ ai: unlocked }, false, services);
    return {
      sources: new Map([...lockedSources, ...installedSources]),
      installed: staged.entries,
      changes: staged.changes,
      dispose: staged.dispose,
    };
  } catch (error) {
    await staged.dispose();
    throw error;
  }
}

/**
 * Installs selections that have no lock entry, keeping every existing lock entry. On failure, rolls
 * back a started transaction and removes the directories this attempt created, then reports the
 * underlying cause. Registry cache entries written to an existing `.calavera/cache/npm` remain.
 *
 * @param {ArtifactSelection[]} unlocked
 * @param {{ artifacts: ArtifactLockEntry[] }} lock
 * @param {boolean} dryRun
 * @param {ArtifactRegistry} registry
 * @param {((sources: Map<string, string>) => Promise<unknown>) | undefined} preflight
 */
async function installUnlockedArtifacts(unlocked, lock, dryRun, registry, preflight) {
  const createdDirectories = [".calavera", ".calavera/cache", CACHE_PATH, TRANSACTION_ROOT];
  // The transaction creates the parent directories of the outputs it moves into place, and a
  // rollback restores files only, so remove the parents this attempt created, deepest first.
  const outputParents = new Set();
  for (const artifact of resolveAiArtifacts({ ai: unlocked })) {
    for (const path of aiArtifactOutputPaths(artifact)) {
      for (let parent = dirname(path); parent !== "." && parent !== dirname(parent);) {
        outputParents.add(parent);
        parent = dirname(parent);
      }
    }
  }
  const existedBefore = new Set();
  for (const path of [...createdDirectories, ...outputParents]) {
    if (await fileExists(path)) existedBefore.add(path);
  }
  let preflightFailed = false;

  try {
    return await stageArtifactInstall(
      { ai: unlocked },
      unlocked,
      {
        lockedById: new Map(),
        advanceIds: new Set(),
        dryRun,
        keptEntries: lock.artifacts,
        preflight:
          preflight &&
          (async (sources) => {
            try {
              await preflight(sources);
            } catch (error) {
              preflightFailed = true;
              throw error;
            }
          }),
      },
      registry,
    );
  } catch (error) {
    const ids = unlocked.map(({ id }) => id).join(", ");
    const reason = error instanceof Error ? error.message : String(error);
    const stopped = preflightFailed
      ? `Apply stopped before installing the unlocked artifacts this recipe selects (${ids}) because the recipe's artifacts cannot be applied`
      : `Could not ${dryRun ? "preview installing" : "install"} the unlocked artifacts this recipe selects (${ids})`;
    const message = `${stopped}, so the artifact lock, artifact outputs, and Calavera state were not changed. ${reason} Review the install with create-project-calavera artifacts install --dry-run.`;
    if (!dryRun) {
      try {
        if (await fileExists(TRANSACTION_PATH)) await recoverArtifactTransaction();
      } catch (recoveryError) {
        // The journal stays in place, so the next Calavera command retries the rollback.
        const recoveryReason =
          recoveryError instanceof Error ? recoveryError.message : String(recoveryError);
        throw new AggregateError(
          [error, recoveryError],
          `Could not install the unlocked artifacts this recipe selects (${ids}), and rolling back the partly committed install also failed, so the project may be partly changed. ${reason} Rollback failure: ${recoveryReason} Run any create-project-calavera command to retry the rollback.`,
          { cause: error },
        );
      }
      /** @type {unknown[]} */
      const cleanupErrors = [];
      for (const path of createdDirectories) {
        if (existedBefore.has(path)) continue;
        try {
          await rm(path, { recursive: true, force: true });
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      const newParents = [...outputParents].filter((path) => !existedBefore.has(path));
      for (const path of newParents.sort((a, b) => b.length - a.length)) {
        try {
          // rmdir removes only an empty directory, so nothing written by anyone else is lost.
          await rmdir(path);
        } catch (cleanupError) {
          const code = /** @type {NodeJS.ErrnoException} */ (cleanupError).code;
          if (code !== "ENOENT" && code !== "ENOTEMPTY") cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        const cleanupReasons = cleanupErrors
          .map((cleanupError) =>
            cleanupError instanceof Error ? cleanupError.message : String(cleanupError),
          )
          .join(" ");
        throw new AggregateError(
          [error, ...cleanupErrors],
          `${message} Removing the directories this install created also failed, so empty directories may remain: ${cleanupReasons}`,
          { cause: error },
        );
      }
    }
    throw new Error(message, { cause: error });
  }
}

/**
 * @param {{ ai?: unknown }} recipe
 * @param {boolean} [dryRun]
 * @param {ArtifactServices} [services]
 */
export async function lockedArtifactSources(recipe, dryRun = false, services = {}) {
  await recoverArtifactTransaction({ readOnly: dryRun });
  const { resolve: resolvePackage, extract: extractPackage } = artifactRegistry(services);
  const packageSelections = Array.isArray(recipe.ai)
    ? recipe.ai.filter(
        (/** @type {unknown} */ item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          ("id" in item || "src" in item),
      )
    : [];
  if (packageSelections.length === 0) return new Map();

  const selections = normalizeSelections(packageSelections);
  const lock = await readLock();
  const lockedById = new Map(lock.artifacts.map((entry) => [entry.id, entry]));
  const sources = new Map();

  for (const selection of selections) {
    const entry = lockedById.get(selection.id);
    if (!entry) {
      throw new Error(
        `Artifact ${selection.id} is not locked. Run create-project-calavera artifacts install.`,
      );
    }
    const artifact = artifactForId(selection.id);
    if (!artifact) throw new Error(`Unknown Calavera artifact: ${selection.id}.`);
    const payloadPath = resolve(PACKAGE_PATH, selection.id, entry.version, artifact.payload);
    const validLocalPayload =
      (await fileExists(payloadPath)) &&
      (await hashArtifactPayload(payloadPath)) === entry.payloadHash;

    if (!validLocalPayload) {
      const temporaryRoot = dryRun
        ? await mkdtemp(join(tmpdir(), "calavera-locked-artifact-"))
        : resolve(".calavera/.staging", selection.id);
      const stage = dryRun ? join(temporaryRoot, "package") : temporaryRoot;
      const cache = dryRun ? join(temporaryRoot, "cache") : resolve(CACHE_PATH);
      if (dryRun && (await fileExists(CACHE_PATH))) {
        await cp(resolve(CACHE_PATH), cache, { recursive: true });
      }
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true });
      const resolution = await resolvePackage({
        id: selection.id,
        tag: entry.tag,
        version: entry.version,
        cache,
        offline: true,
      });
      const extracted = await extractPackage(resolution, stage, packageJson.version);
      if (extracted.payloadHash !== entry.payloadHash) {
        throw new Error(`Locked payload hash mismatch for ${selection.id}.`);
      }
      if (dryRun) {
        sources.set(selection.id, extracted.payloadPath);
        continue;
      }
      const finalRoot = resolve(PACKAGE_PATH, selection.id, entry.version);
      await rm(finalRoot, { recursive: true, force: true });
      await mkdir(dirname(finalRoot), { recursive: true });
      await cp(stage, finalRoot, { recursive: true });
    }
    sources.set(selection.id, payloadPath);
  }
  return sources;
}

/** @param {ArtifactOptions} options */
async function migrateRecipe(options) {
  const recipe = await readJson(options.config);
  if (!Array.isArray(recipe.ai)) return { command: "artifacts migrate", migrated: 0 };
  let migrated = 0;
  const ai = recipe.ai.map((/** @type {unknown} */ item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("src" in item)) return item;
    const artifact = artifactForLegacyPath(String(item.src));
    if (!artifact) throw new Error(`Unknown legacy artifact path: ${String(item.src)}.`);
    migrated += 1;
    const target = "target" in item ? item.target : undefined;
    return { id: artifact.id, ...(target ? { target } : {}) };
  });
  if (!options.dryRun && migrated > 0) await writeAtomicJson(options.config, { ...recipe, ai });
  return {
    command: "artifacts migrate",
    dryRun: options.dryRun,
    migrated,
    recipe: { ...recipe, ai },
  };
}

/** @param {ArtifactOptions} options @param {{ resolve: typeof resolveArtifactPackage }} registry */
async function artifactStatus(options, registry) {
  const recipe = (await fileExists(options.config)) ? await readJson(options.config) : {};
  const selections = normalizePackageSelections(recipe.ai);
  const lock = await readLock();
  const state = await readState();
  const stateByPath = new Map(state.aiArtifacts.map((item) => [item.path, item]));
  const artifacts = [];
  for (const entry of lock.artifacts) {
    const outputPaths = aiArtifactOutputPaths({ type: entry.type, path: entry.destination });
    const outputs = await Promise.all(
      outputPaths.map(async (path) => {
        const managed = stateByPath.get(path);
        const installed = await fileExists(path);
        const installedHash = installed
          ? await hashAiInstall(entry.type, path, entry.target)
          : null;
        return {
          installed,
          managed: Boolean(managed),
          locallyEdited: Boolean(installedHash && managed && installedHash !== managed.hash),
        };
      }),
    );
    const latest = options.checkUpdates
      ? await registry.resolve({ id: entry.id, tag: entry.tag, cache: resolve(CACHE_PATH) })
      : null;
    artifacts.push({
      ...entry,
      installed: outputs.every(({ installed }) => installed),
      managed: outputs.every(({ managed }) => managed),
      locallyEdited: outputs.some(({ locallyEdited }) => locallyEdited),
      latestVersion: latest?.version ?? null,
      updateAvailable: Boolean(latest && latest.version !== entry.version),
    });
  }
  const lockedIds = new Set(lock.artifacts.map(({ id }) => id));
  for (const selection of selections.filter(({ id }) => !lockedIds.has(id))) {
    const artifact = artifactForId(selection.id);
    if (!artifact) throw new Error(`Unknown Calavera artifact: ${selection.id}.`);
    const resolvedArtifact = resolveAiArtifacts({ ai: [selection] })[0];
    if (!resolvedArtifact) throw new Error(`Could not resolve artifact ${selection.id}.`);
    const latest = options.checkUpdates
      ? await registry.resolve({ id: selection.id, tag: "latest", cache: resolve(CACHE_PATH) })
      : null;
    artifacts.push({
      id: selection.id,
      type: artifact.type,
      package: artifact.packageName,
      version: null,
      resolved: null,
      integrity: null,
      tag: "latest",
      manifestVersion: null,
      ...(selection.target ? { target: selection.target } : {}),
      destination: resolvedArtifact.path,
      payloadHash: null,
      installed: false,
      managed: false,
      locallyEdited: false,
      latestVersion: latest?.version ?? null,
      updateAvailable: false,
    });
  }
  return {
    command: `artifacts ${options.artifactAction}`,
    offline: !options.checkUpdates,
    ok: artifacts.every(
      ({ installed, managed, locallyEdited }) => installed && managed && !locallyEdited,
    ),
    artifacts,
  };
}

/**
 * @param {ArtifactOptions} options
 * @param {boolean} updating
 * @param {ArtifactRegistry} registry
 */
async function installArtifacts(options, updating, registry) {
  const recipe = await readJson(options.config);
  const selections = normalizeSelections(recipe.ai);
  const currentLock = await readLock();
  const lockedById = new Map(currentLock.artifacts.map((entry) => [entry.id, entry]));
  const requestedIds = updating
    ? options.artifactAll
      ? new Set(selections.map(({ id }) => id))
      : new Set(options.artifactId ? [options.artifactId] : [])
    : new Set(selections.map(({ id }) => id));
  if (updating && requestedIds.size === 0) {
    throw new Error("artifacts update requires an artifact ID or --all.");
  }
  const selectedIds = new Set(selections.map(({ id }) => id));
  for (const id of requestedIds) {
    if (!selectedIds.has(id)) throw new Error(`Artifact ${id} is not selected by the recipe.`);
  }

  const staged = await stageArtifactInstall(
    recipe,
    selections,
    {
      lockedById,
      advanceIds: updating ? requestedIds : new Set(),
      artifactTag: options.artifactTag,
      dryRun: options.dryRun,
      keptEntries: [],
    },
    registry,
  );
  await staged.dispose();
  return {
    command: updating ? "artifacts update" : "artifacts install",
    dryRun: options.dryRun,
    artifacts: staged.entries,
    changes: staged.changes,
  };
}

/**
 * Resolves, verifies, and stages `selections` and the outputs `recipe` installs from them. Unless
 * this is a dry run, runs `preflight` with the staged sources and then commits the packages,
 * outputs, state, and a lock holding `keptEntries` plus the staged entries in one artifact
 * transaction. A selection keeps its locked version unless its
 * ID is in `advanceIds`. Call `dispose` to remove the staging directory once its sources are no
 * longer needed.
 *
 * @param {{ ai?: unknown }} recipe
 * @param {ArtifactSelection[]} selections
 * @param {{ lockedById: Map<string, ArtifactLockEntry>, advanceIds: Set<string>, artifactTag?: "latest" | "next", dryRun: boolean, keptEntries: ArtifactLockEntry[], preflight?: (sources: Map<string, string>) => Promise<void> }} plan
 * @param {ArtifactRegistry} registry
 * @returns {Promise<{ entries: ArtifactLockEntry[], changes: AiChange[], sourcePaths: Map<string, string>, dispose: () => Promise<void> }>}
 */
async function stageArtifactInstall(recipe, selections, plan, registry) {
  const { lockedById, advanceIds, artifactTag, dryRun } = plan;
  const stagingRoot = dryRun
    ? await mkdtemp(join(tmpdir(), "calavera-artifact-stage-"))
    : resolve(TRANSACTION_ROOT, `${Date.now()}-${process.pid}`);
  const dispose = () => rm(stagingRoot, { recursive: true, force: true });
  /** @type {Map<string, string>} */
  const sourcePaths = new Map();
  /** @type {ArtifactLockEntry[]} */
  const nextEntries = [];
  let commitStarted = false;

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });
  // A dry run keeps its registry cache inside the staging directory, so `dispose` removes both.
  const cache = dryRun ? join(stagingRoot, "cache") : resolve(CACHE_PATH);

  try {
    for (const selection of selections) {
      const locked = lockedById.get(selection.id);
      const shouldAdvance = advanceIds.has(selection.id);
      const resolution = await registry.resolve({
        id: selection.id,
        tag: shouldAdvance ? (artifactTag ?? "latest") : (locked?.tag ?? artifactTag ?? "latest"),
        version: shouldAdvance ? undefined : locked?.version,
        cache,
      });
      const stage = join(stagingRoot, "packages", selection.id);
      const extracted = await registry.extract(resolution, stage, packageJson.version);
      sourcePaths.set(selection.id, extracted.payloadPath);
      const resolvedArtifact = resolveAiArtifacts({ ai: [selection] }, sourcePaths)[0];
      if (!resolvedArtifact) throw new Error(`Could not resolve artifact ${selection.id}.`);
      nextEntries.push({
        id: selection.id,
        type: /** @type {ArtifactLockEntry["type"]} */ (resolution.artifact.type),
        package: resolution.packageName,
        version: resolution.version,
        resolved: resolution.resolved,
        integrity: resolution.integrity,
        tag: /** @type {ArtifactLockEntry["tag"]} */ (resolution.tag),
        manifestVersion: 1,
        ...(selection.target ? { target: selection.target } : {}),
        destination: resolvedArtifact.path,
        payloadHash: extracted.payloadHash,
      });
    }

    const state = await readState();
    const outputRoot = join(stagingRoot, "outputs");
    const applied = await buildAiApplyResult(recipe, { dryRun, outputRoot }, state, sourcePaths);
    if (!dryRun) {
      if (plan.preflight) await plan.preflight(sourcePaths);
      const paths = new Set(applied.artifacts.map(({ path }) => path));
      const nextState = {
        ...state,
        aiArtifacts: [
          ...state.aiArtifacts.filter(({ path }) => !paths.has(path)),
          ...applied.artifacts,
        ],
      };
      const stagedState = join(stagingRoot, "records", "state.json");
      const stagedLock = join(stagingRoot, "records", "artifacts.lock.json");
      await writeJson(stagedState, nextState);
      await writeJson(stagedLock, {
        schemaVersion: 1,
        artifacts: [...plan.keptEntries, ...nextEntries],
      });

      const operations = selections.map((selection) => {
        const entry = nextEntries.find(({ id }) => id === selection.id);
        if (!entry) throw new Error(`Missing lock entry for ${selection.id}.`);
        return {
          staged: join(stagingRoot, "packages", selection.id),
          target: resolve(PACKAGE_PATH, selection.id, entry.version),
        };
      });
      const changedPaths = new Set(applied.changes.map(({ path }) => path));
      for (const artifact of resolveAiArtifacts(recipe, sourcePaths)) {
        const outputPaths = aiArtifactOutputPaths(artifact);
        if (!outputPaths.some((path) => changedPaths.has(path))) continue;
        for (const path of outputPaths) {
          operations.push({ staged: resolve(outputRoot, path), target: resolve(path) });
        }
      }
      if (changedPaths.has(CODE_RABBIT_CONFIG_PATH)) {
        operations.push({
          staged: resolve(outputRoot, CODE_RABBIT_CONFIG_PATH),
          target: resolve(CODE_RABBIT_CONFIG_PATH),
        });
      }
      operations.push(
        { staged: stagedState, target: resolve(STATE_PATH) },
        { staged: stagedLock, target: resolve(LOCK_PATH) },
      );
      commitStarted = true;
      await commitArtifactTransaction(stagingRoot, operations);
      commitStarted = false;
    }
    return { entries: nextEntries, changes: applied.changes, sourcePaths, dispose };
  } catch (error) {
    // A commit that failed part way leaves its journal and staging for recovery.
    if (!commitStarted || !(await fileExists(TRANSACTION_PATH))) await dispose();
    throw error;
  }
}

/** @param {unknown} ai */
function normalizePackageSelections(ai) {
  if (!Array.isArray(ai)) return [];
  return normalizeSelections(
    ai.filter(
      (item) =>
        item && typeof item === "object" && !Array.isArray(item) && ("id" in item || "src" in item),
    ),
  );
}

/** @param {unknown} ai */
function normalizeSelections(ai) {
  if (!Array.isArray(ai)) return [];
  return ai.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Artifact selections must be objects.");
    }
    const artifact =
      "id" in item
        ? artifactForId(String(item.id))
        : "src" in item
          ? artifactForLegacyPath(String(item.src))
          : undefined;
    if (!artifact) throw new Error("Unknown artifact selection.");
    const target = "target" in item ? String(item.target).trim() : artifact.defaultTarget;
    return { id: artifact.id, ...(target ? { target } : {}) };
  });
}

/** @returns {Promise<{ schemaVersion: number, artifacts: ArtifactLockEntry[] }>} */
async function readLock() {
  if (!(await fileExists(LOCK_PATH))) return { schemaVersion: 1, artifacts: [] };
  const lock = await readJson(LOCK_PATH);
  if (!Array.isArray(lock.artifacts)) throw new Error("Invalid artifact lockfile.");
  return /** @type {{ schemaVersion: number, artifacts: ArtifactLockEntry[] }} */ (lock);
}

async function readState() {
  return (await fileExists(STATE_PATH))
    ? normalizeState(await readJson(STATE_PATH))
    : createEmptyState();
}

/** @param {string} path @returns {Promise<Record<string, unknown>>} */
async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {string} path @param {unknown} value */
async function writeAtomicJson(path, value) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await rename(temporary, absolute);
}

/** @param {string} path @param {unknown} value */
async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
}

/** @param {string} parent @param {string} child */
function isInside(parent, child) {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

/** @param {string} transactionRoot @param {{ staged: string, target: string }[]} operations */
async function commitArtifactTransaction(transactionRoot, operations) {
  const projectRoot = resolve(".");
  const normalizedRoot = resolve(transactionRoot);
  const seenTargets = new Set();
  const journalOperations = [];
  for (const [index, operation] of operations.entries()) {
    const staged = resolve(operation.staged);
    const target = resolve(operation.target);
    if (
      !isInside(resolve(TRANSACTION_ROOT), normalizedRoot) ||
      !isInside(normalizedRoot, staged) ||
      !isInside(projectRoot, target) ||
      seenTargets.has(target) ||
      !(await fileExists(staged))
    ) {
      throw new Error("Invalid artifact transaction operation.");
    }
    seenTargets.add(target);
    journalOperations.push({
      staged,
      target,
      backup: join(normalizedRoot, "backups", String(index)),
      hadTarget: await fileExists(target),
    });
  }

  await writeAtomicJson(TRANSACTION_PATH, {
    schemaVersion: 1,
    transactionRoot: normalizedRoot,
    operations: journalOperations,
  });
  for (const operation of journalOperations) {
    await mkdir(dirname(operation.target), { recursive: true });
    if (operation.hadTarget) {
      await mkdir(dirname(operation.backup), { recursive: true });
      await rename(operation.target, operation.backup);
    }
    await rename(operation.staged, operation.target);
  }
  await rm(TRANSACTION_PATH, { force: true });
}

/** @param {{ readOnly?: boolean }} [options] */
async function recoverArtifactTransaction(options = {}) {
  if (!(await fileExists(TRANSACTION_PATH))) return;
  if (options.readOnly) {
    throw new Error("A pending artifact transaction requires recovery before a dry run.");
  }
  const journal = await readJson(TRANSACTION_PATH);
  if (
    journal.schemaVersion !== 1 ||
    typeof journal.transactionRoot !== "string" ||
    !Array.isArray(journal.operations)
  ) {
    throw new Error("Invalid artifact transaction journal.");
  }
  const projectRoot = resolve(".");
  const transactionRoot = resolve(journal.transactionRoot);
  if (!isInside(resolve(TRANSACTION_ROOT), transactionRoot)) {
    throw new Error("Invalid artifact transaction root.");
  }
  const operations = journal.operations.map((operation) => {
    if (
      !operation ||
      typeof operation !== "object" ||
      typeof operation.staged !== "string" ||
      typeof operation.target !== "string" ||
      typeof operation.backup !== "string" ||
      typeof operation.hadTarget !== "boolean"
    ) {
      throw new Error("Invalid artifact transaction journal operation.");
    }
    const staged = resolve(operation.staged);
    const target = resolve(operation.target);
    const backup = resolve(operation.backup);
    if (
      !isInside(transactionRoot, staged) ||
      !isInside(transactionRoot, backup) ||
      !isInside(projectRoot, target)
    ) {
      throw new Error("Artifact transaction journal path escapes its workspace.");
    }
    return { staged, target, backup, hadTarget: operation.hadTarget };
  });

  for (const operation of operations.reverse()) {
    if (await fileExists(operation.backup)) {
      await rm(operation.target, { recursive: true, force: true });
      await mkdir(dirname(operation.target), { recursive: true });
      await rename(operation.backup, operation.target);
    } else if (!operation.hadTarget) {
      await rm(operation.target, { recursive: true, force: true });
    }
  }
  await rm(TRANSACTION_PATH, { force: true });
  await rm(transactionRoot, { recursive: true, force: true });
}
