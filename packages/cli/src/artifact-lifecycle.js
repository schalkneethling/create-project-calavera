// @ts-check
import { cp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { artifactForId, artifactForLegacyPath } from "@schalkneethling/calavera-artifact-core";
import {
  extractArtifactPackage,
  hashArtifactPayload,
  resolveArtifactPackage,
} from "@schalkneethling/calavera-artifact-core/registry";
import packageJson from "../package.json" with { type: "json" };

import { buildAiApplyResult, hashAiInstall, resolveAiArtifacts } from "./ai/artifacts.js";
import { createEmptyState, normalizeState } from "./state.js";
import { fileExists } from "./utils/fs.js";

const LOCK_PATH = ".calavera/artifacts.lock.json";
const STATE_PATH = ".calavera/state.json";
const CACHE_PATH = ".calavera/cache/npm";
const PACKAGE_PATH = ".calavera/packages";

/**
 * @typedef {{ config: string, dryRun: boolean, artifactAction?: string, artifactId?: string, artifactTag?: "latest" | "next", artifactAll?: boolean, checkUpdates?: boolean }} ArtifactOptions
 * @typedef {{ id: string, type: "skill" | "hook" | "agent", package: string, version: string, resolved: string, integrity: string, tag: "latest" | "next", manifestVersion: number, destination: string, payloadHash: string, target?: string }} ArtifactLockEntry
 */

/**
 * @param {ArtifactOptions} options
 * @param {{ resolve?: typeof resolveArtifactPackage, extract?: typeof extractArtifactPackage }} [services]
 */
export async function runArtifactCommand(options, services = {}) {
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

/** @param {{ ai?: unknown }} recipe */
export async function lockedArtifactSources(recipe) {
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
      const stage = resolve(".calavera/.staging", selection.id);
      await rm(stage, { recursive: true, force: true });
      await mkdir(stage, { recursive: true });
      const resolution = await resolveArtifactPackage({
        id: selection.id,
        tag: entry.tag,
        version: entry.version,
        cache: resolve(CACHE_PATH),
        offline: true,
      });
      const extracted = await extractArtifactPackage(resolution, stage, packageJson.version);
      if (extracted.payloadHash !== entry.payloadHash) {
        throw new Error(`Locked payload hash mismatch for ${selection.id}.`);
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
  const lock = await readLock();
  const state = await readState();
  const stateByPath = new Map(state.aiArtifacts.map((item) => [item.path, item]));
  const artifacts = [];
  for (const entry of lock.artifacts) {
    const managed = stateByPath.get(entry.destination);
    const exists = await fileExists(entry.destination);
    const installedHash = exists
      ? await hashAiInstall(entry.type, entry.destination, entry.target)
      : null;
    const latest = options.checkUpdates
      ? await registry.resolve({ id: entry.id, tag: entry.tag, cache: resolve(CACHE_PATH) })
      : null;
    artifacts.push({
      ...entry,
      installed: exists,
      managed: Boolean(managed),
      locallyEdited: Boolean(installedHash && managed && installedHash !== managed.hash),
      latestVersion: latest?.version ?? null,
      updateAvailable: Boolean(latest && latest.version !== entry.version),
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
  const stagingRoot = resolve(
    options.dryRun ? join(tmpdir(), "calavera-artifact-stage") : ".calavera/.staging",
  );
  const sourcePaths = new Map();
  const nextEntries = [];

  await rm(stagingRoot, { recursive: true, force: true });
  await mkdir(stagingRoot, { recursive: true });

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
    const stage = join(stagingRoot, selection.id);
    const extracted = await registry.extract(resolution, stage, packageJson.version);
    const finalRoot = resolve(PACKAGE_PATH, selection.id, resolution.version);
    const finalPayload = join(finalRoot, extracted.manifest.payload);

    if (!options.dryRun) {
      await rm(finalRoot, { recursive: true, force: true });
      await mkdir(dirname(finalRoot), { recursive: true });
      await cp(stage, finalRoot, { recursive: true });
    }
    sourcePaths.set(selection.id, options.dryRun ? extracted.payloadPath : finalPayload);
    const resolvedArtifact = resolveAiArtifacts({ ai: [selection] }, sourcePaths)[0];
    if (!resolvedArtifact) throw new Error(`Could not resolve artifact ${selection.id}.`);
    nextEntries.push({
      id: selection.id,
      type: resolution.artifact.type,
      package: resolution.packageName,
      version: resolution.version,
      resolved: resolution.resolved,
      integrity: resolution.integrity,
      tag: resolution.tag,
      manifestVersion: 1,
      ...(selection.target ? { target: selection.target } : {}),
      destination: resolvedArtifact.path,
      payloadHash: extracted.payloadHash,
    });
  }

  const state = await readState();
  const applied = await buildAiApplyResult(recipe, { dryRun: options.dryRun }, state, sourcePaths);
  if (!options.dryRun) {
    const paths = new Set(applied.artifacts.map(({ path }) => path));
    const nextState = {
      ...state,
      aiArtifacts: [
        ...state.aiArtifacts.filter(({ path }) => !paths.has(path)),
        ...applied.artifacts,
      ],
    };
    await writeArtifactRecords(nextState, { schemaVersion: 1, artifacts: nextEntries });
    await rm(stagingRoot, { recursive: true, force: true });
  }
  return {
    command: updating ? "artifacts update" : "artifacts install",
    dryRun: options.dryRun,
    artifacts: nextEntries,
    changes: applied.changes,
  };
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
    const target = "target" in item ? String(item.target) : artifact.defaultTarget;
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

/** @param {unknown} state @param {unknown} lock */
async function writeArtifactRecords(state, lock) {
  const statePath = resolve(STATE_PATH);
  const lockPath = resolve(LOCK_PATH);
  await mkdir(dirname(statePath), { recursive: true });
  const stateTemporary = `${statePath}.${process.pid}.tmp`;
  const lockTemporary = `${lockPath}.${process.pid}.tmp`;
  const previousState = (await fileExists(statePath)) ? await readFile(statePath) : null;
  const previousLock = (await fileExists(lockPath)) ? await readFile(lockPath) : null;
  await writeFile(stateTemporary, `${JSON.stringify(state, null, 2)}\n`, { flag: "wx" });
  await writeFile(lockTemporary, `${JSON.stringify(lock, null, 2)}\n`, { flag: "wx" });

  try {
    await rename(stateTemporary, statePath);
    await rename(lockTemporary, lockPath);
  } catch (error) {
    if (previousState) await writeFile(statePath, previousState);
    else await rm(statePath, { force: true });
    if (previousLock) await writeFile(lockPath, previousLock);
    else await rm(lockPath, { force: true });
    await rm(stateTemporary, { force: true });
    await rm(lockTemporary, { force: true });
    throw error;
  }
}
