// @ts-check
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
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
 */

/**
 * @param {ArtifactOptions} options
 * @param {{ resolve?: typeof resolveArtifactPackage, extract?: typeof extractArtifactPackage }} [services]
 */
export async function runArtifactCommand(options, services = {}) {
  await recoverArtifactTransaction();
  const registry = {
    resolve: services.resolve ?? resolveArtifactPackage,
    extract: services.extract ?? extractArtifactPackage,
  };
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
 * @param {{ ai?: unknown }} recipe
 * @param {boolean} [dryRun]
 * @param {{ resolve?: typeof resolveArtifactPackage, extract?: typeof extractArtifactPackage }} [services]
 */
export async function lockedArtifactSources(recipe, dryRun = false, services = {}) {
  await recoverArtifactTransaction({ readOnly: dryRun });
  const resolvePackage = services.resolve ?? resolveArtifactPackage;
  const extractPackage = services.extract ?? extractArtifactPackage;
  const packageSelections = Array.isArray(recipe.ai)
    ? recipe.ai.filter(
        (/** @type {unknown} */ item) =>
          item && typeof item === "object" && !Array.isArray(item) && "id" in item,
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
 * @param {{ resolve: typeof resolveArtifactPackage, extract: typeof extractArtifactPackage }} registry
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

  const cache = resolve(options.dryRun ? join(tmpdir(), "calavera-artifact-cache") : CACHE_PATH);
  const stagingRoot = options.dryRun
    ? await mkdtemp(join(tmpdir(), "calavera-artifact-stage-"))
    : resolve(TRANSACTION_ROOT, `${Date.now()}-${process.pid}`);
  const sourcePaths = new Map();
  /** @type {ArtifactLockEntry[]} */
  const nextEntries = [];
  let commitStarted = false;

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

  try {
    for (const selection of selections) {
      const locked = lockedById.get(selection.id);
      const shouldAdvance = updating && requestedIds.has(selection.id);
      const resolution = await registry.resolve({
        id: selection.id,
        tag: shouldAdvance
          ? (options.artifactTag ?? "latest")
          : (locked?.tag ?? options.artifactTag ?? "latest"),
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
    const applied = await buildAiApplyResult(
      recipe,
      { dryRun: options.dryRun, outputRoot },
      state,
      sourcePaths,
    );
    if (!options.dryRun) {
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
      await writeJson(stagedLock, { schemaVersion: 1, artifacts: nextEntries });

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
      operations.push(
        { staged: stagedState, target: resolve(STATE_PATH) },
        { staged: stagedLock, target: resolve(LOCK_PATH) },
      );
      commitStarted = true;
      await commitArtifactTransaction(stagingRoot, operations);
      commitStarted = false;
    }
    return {
      command: updating ? "artifacts update" : "artifacts install",
      dryRun: options.dryRun,
      artifacts: nextEntries,
      changes: applied.changes,
    };
  } finally {
    if (!commitStarted || !(await fileExists(TRANSACTION_PATH))) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

/** @param {unknown} ai */
function normalizePackageSelections(ai) {
  if (!Array.isArray(ai)) return [];
  return normalizeSelections(
    ai.filter((item) => item && typeof item === "object" && !Array.isArray(item) && "id" in item),
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
