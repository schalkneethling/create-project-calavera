// @ts-check
import { cp, mkdir, mkdtemp, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
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
import { assertFirstSelection } from "./ai/recipe-items.js";
import { GITIGNORE_PATH, planGitignoreBlocks } from "./ignore-lines.js";
import { artifactReleaseNotesUrl, isArtifactHealthy } from "./artifact-status-report.js";
import {
  artifactCommand,
  artifactTagFlags,
  artifactUpdateCommand,
} from "./project-local-commands.js";
import { createEmptyState, normalizeState } from "./state.js";
import { errorAfterCleanups, removeTemporaryFolder, runCleanups } from "./utils/cleanup.js";
import { fileExists, isPathInside } from "./utils/fs.js";
import { formatGeneratedText } from "./utils/generated-text.js";
import { projectFormatterLoader } from "./utils/project-formatter.js";

export const LOCK_PATH = ".calavera/artifacts.lock.json";
export const STATE_PATH = ".calavera/state.json";
export const CACHE_ROOT = ".calavera/cache";
const CACHE_PATH = `${CACHE_ROOT}/npm`;
export const PACKAGE_PATH = ".calavera/packages";
export const TRANSACTION_PATH = ".calavera/artifact-transaction.json";
export const TRANSACTION_ROOT = ".calavera/.transactions";

// #841: the npm cache that artifact packages resolve through is not committed (owner decision,
// 2026-11-14). Apply keeps it out of Git with its own marked `.gitignore` block (ADR-0016,
// Amendment 1). The owner id is not an integration id; a catalog test keeps it that way. #960:
// `artifacts install`, `artifacts update`, and `artifacts status --check-updates` create the cache
// too, so they write and record the same block (owner decision, 2026-11-17).
export const ARTIFACT_CACHE_BLOCK = "artifact-cache";

/** The two halves of why the cache is ignored; the apply summary drops the file name between them. */
export const ARTIFACT_CACHE_IGNORED =
  "Calavera ignores .calavera/cache/ through its artifact-cache block";
export const ARTIFACT_CACHE_REASON =
  "because the folder is a local npm download cache and does not belong in Git. Commit .calavera/artifacts.lock.json and .calavera/packages/, which hold the exact artifact versions and payloads the project uses.";

/** Why the artifact cache is ignored (#841), as `pointers` carries it. */
export const ARTIFACT_CACHE_POINTER = `${ARTIFACT_CACHE_IGNORED} in .gitignore, ${ARTIFACT_CACHE_REASON}`;

/**
 * The `.gitignore` block that keeps the artifact cache out of Git. It is planned while the recipe
 * selects an artifact package, because apply and the `artifacts` commands then resolve packages
 * through the cache, while the command resolves packages for another reason, such as
 * `artifacts status --check-updates` checking lock entries the recipe no longer selects, and while
 * the cache folder exists, because a recipe that drops its artifacts leaves the cache behind.
 *
 * @param {{ ai?: unknown }} recipe
 * @param {{ resolvesPackages?: boolean }} [options]
 * @returns {Promise<import("./ignore-lines.js").IgnoreLines[]>}
 */
export async function artifactCacheIgnoreLines(recipe, { resolvesPackages = false } = {}) {
  const needed =
    resolvesPackages ||
    normalizePackageSelections(recipe.ai).length > 0 ||
    (await fileExists(CACHE_ROOT));
  return needed ? [{ integration: ARTIFACT_CACHE_BLOCK, lines: [`${CACHE_ROOT}/`] }] : [];
}

/**
 * The pointer that says why the cache is ignored, when `changes` add or replace its block. A block
 * that is already in place, or that is removed, needs no explanation.
 *
 * @param {import("./ignore-lines.js").IgnoreChange[]} changes
 * @returns {string[]}
 */
export function artifactCachePointers(changes) {
  const adds = changes.some(
    ({ integration, type, removedLines }) =>
      integration === ARTIFACT_CACHE_BLOCK && type !== "unchanged" && removedLines === undefined,
  );
  return adds ? [ARTIFACT_CACHE_POINTER] : [];
}

/**
 * Plans the artifact cache block for an `artifacts` command (#960), through the planner apply uses,
 * so an edited block stops the command, dry runs included, before anything is resolved or written
 * (ADR-0016). Only the cache block is planned: the integrations' blocks belong to apply, so their
 * records pass through unchanged, and the command never removes the cache block, because it only
 * plans one while it needs the block.
 *
 * @param {{ gitignoreBlocks: import("./ignore-lines.js").IgnoreLines[] }} state
 * @param {import("./ignore-lines.js").IgnoreLines[]} declared The cache block's lines, from `artifactCacheIgnoreLines`.
 * @param {string} command The command a conflict tells the person to run again.
 * @returns {Promise<ArtifactCacheBlockPlan>}
 */
async function planArtifactCacheBlock(state, declared, command) {
  if (declared.length === 0) {
    return {
      contents: undefined,
      writesGitignore: false,
      writesState: false,
      changes: [],
      gitignoreBlocks: state.gitignoreBlocks,
    };
  }
  const isCacheRecord = (/** @type {{ integration: string }} */ { integration }) =>
    integration === ARTIFACT_CACHE_BLOCK;
  const plan = planGitignoreBlocks({
    contents: (await fileExists(GITIGNORE_PATH))
      ? await readFile(GITIGNORE_PATH, "utf8")
      : undefined,
    declared,
    records: state.gitignoreBlocks.filter(isCacheRecord),
    command,
  });
  // The cache record keeps its place among the records, or follows them when it is new, as it
  // follows the integrations' blocks when apply records it.
  const gitignoreBlocks = state.gitignoreBlocks.some(isCacheRecord)
    ? state.gitignoreBlocks.flatMap((record) => (isCacheRecord(record) ? plan.records : [record]))
    : [...state.gitignoreBlocks, ...plan.records];
  const writesGitignore = plan.type === "write" || plan.type === "update";
  return {
    contents: plan.contents,
    writesGitignore,
    // A block already in the file with the declared lines but no record is unchanged in the file,
    // and only gains its record.
    writesState:
      writesGitignore || JSON.stringify(gitignoreBlocks) !== JSON.stringify(state.gitignoreBlocks),
    changes: plan.changes,
    gitignoreBlocks,
  };
}

/**
 * @typedef {{ config: string, dryRun: boolean, artifactAction?: string, artifactId?: string, artifactTag?: "latest" | "next", artifactAll?: boolean, checkUpdates?: boolean }} ArtifactOptions
 * @typedef {{ id: string, type: "skill" | "hook" | "agent", package: string, version: string, resolved: string, integrity: string, tag: "latest" | "next", manifestVersion: number, destination: string, payloadHash: string, target?: string }} ArtifactLockEntry
 * @typedef {{ resolve?: typeof resolveArtifactPackage, extract?: typeof extractArtifactPackage, loadFormatter?: () => Promise<ProjectFormatter> }} ArtifactServices
 *   `loadFormatter` loads the formatter for the state and lock an install writes, and for the
 *   recipe a migration writes; without it, the project's own formatter in the working directory.
 * @typedef {{ resolve: typeof resolveArtifactPackage, extract: typeof extractArtifactPackage }} ArtifactRegistry
 * @typedef {{ id: string, target?: string }} ArtifactSelection
 * @typedef {import("./ai/artifacts.js").AiChange} AiChange
 * @typedef {import("./utils/project-formatter.js").ProjectFormatter} ProjectFormatter
 * @typedef {{ contents: string | undefined, writesGitignore: boolean, writesState: boolean, changes: import("./ignore-lines.js").IgnoreChange[], gitignoreBlocks: import("./ignore-lines.js").IgnoreLines[] }} ArtifactCacheBlockPlan
 *   The artifact cache block an `artifacts` command writes (#960): `.gitignore` as it would be,
 *   whether `.gitignore` and the state record change, the changes to report, and the state's
 *   records after it.
 * @typedef {{ origin: string, source: string }} ArtifactRegistryReport The registry (protocol, host, and port) an artifact resolves from, and the npm configuration it came from.
 * @typedef {{ registries: ArtifactRegistryReport[], warnings: string[] }} ArtifactRegistryNotes
 */

/**
 * @param {ArtifactServices} services
 * @returns {() => Promise<ProjectFormatter>}
 */
function artifactFormatterLoader(services) {
  return services.loadFormatter ?? projectFormatterLoader(process.cwd());
}

/** @param {ArtifactServices} services @returns {ArtifactRegistry} */
export function artifactRegistry(services) {
  return {
    resolve: services.resolve ?? resolveArtifactPackage,
    extract: services.extract ?? extractArtifactPackage,
  };
}

/**
 * Collects the registry and npm configuration warnings the resolutions report, without repeats.
 * A resolver that reports none, such as a test stand-in, adds nothing.
 * @returns {{ add: (resolution: { registry?: ArtifactRegistryReport, warnings?: string[] }) => void, notes: () => ArtifactRegistryNotes }}
 */
function registryNotes() {
  /** @type {Map<string, ArtifactRegistryReport>} */
  const registries = new Map();
  /** @type {Set<string>} */
  const warnings = new Set();
  return {
    add({ registry, warnings: resolutionWarnings = [] }) {
      if (registry) registries.set(`${registry.origin} ${registry.source}`, registry);
      for (const warning of resolutionWarnings) warnings.add(warning);
    },
    notes: () => ({ registries: [...registries.values()], warnings: [...warnings] }),
  };
}

/**
 * @param {ArtifactOptions} options
 * @param {ArtifactServices} [services]
 */
export async function runArtifactCommand(options, services = {}) {
  await recoverArtifactTransaction();
  const registry = artifactRegistry(services);
  const loadFormatter = artifactFormatterLoader(services);
  switch (options.artifactAction) {
    case "migrate":
      return migrateRecipe(options, loadFormatter);
    case "status":
    case "doctor":
      return artifactStatus(options, registry, loadFormatter);
    case "install":
      return installArtifacts(options, false, registry, loadFormatter);
    case "update":
      return installArtifacts(options, true, registry, loadFormatter);
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
 * outputs, and the Calavera state are left as they were. A locked payload that is missing from
 * `.calavera/packages/` is rebuilt outside the project; call `restore` after apply's last planning
 * step, to copy it into place (#988). Call `dispose` once the sources are no longer needed.
 *
 * @param {{ ai?: unknown }} recipe
 * @param {boolean} dryRun
 * @param {ArtifactServices} [services]
 * @param {(sources: Map<string, string>) => Promise<unknown>} [preflight] Checks the complete set of sources before the install commits.
 * @param {ArtifactLockEntry[]} [approved] Entries a dry run reported; an unlocked selection listed here installs at exactly that version and tag instead of resolving its tag again.
 * @returns {Promise<{ sources: Map<string, string>, installed: ArtifactLockEntry[], changes: AiChange[], restore: () => Promise<void>, dispose: () => Promise<void> } & ArtifactRegistryNotes>}
 */
export async function prepareArtifactSources(
  recipe,
  dryRun,
  services = {},
  preflight,
  approved = [],
) {
  await recoverArtifactTransaction({ readOnly: dryRun });
  const selections = normalizePackageSelections(recipe.ai);
  const lock = await readLock();
  const lockedIds = new Set(lock.artifacts.map(({ id }) => id));
  const unlocked = selections.filter(({ id }) => !lockedIds.has(id));
  if (unlocked.length === 0) {
    const locked = await lockedArtifactSources(recipe, dryRun, services);
    return {
      sources: locked.sources,
      installed: [],
      changes: [],
      restore: locked.restore,
      dispose: locked.dispose,
      registries: [],
      warnings: [],
    };
  }

  // Stage the locked selections first, so a missing locked payload that cannot be rebuilt stops
  // apply before the install of the unlocked selections commits.
  const locked = await lockedArtifactSources(
    { ai: selections.filter(({ id }) => lockedIds.has(id)) },
    dryRun,
    services,
  );
  /** @type {Awaited<ReturnType<typeof installUnlockedArtifacts>> | undefined} */
  let staged;
  try {
    staged = await installUnlockedArtifacts(
      unlocked,
      lock,
      dryRun,
      artifactRegistry(services),
      preflight && ((stagedSources) => preflight(new Map([...locked.sources, ...stagedSources]))),
      new Map(approved.map((entry) => [entry.id, entry])),
      artifactFormatterLoader(services),
    );
    // A dry run leaves the lock untouched, so the staged install supplies the unlocked sources.
    // Apply reads them from the packages the install just committed.
    const installed = dryRun
      ? undefined
      : await lockedArtifactSources({ ai: unlocked }, false, services);
    const stagedInstall = staged;
    return {
      sources: new Map([...locked.sources, ...(installed?.sources ?? stagedInstall.sourcePaths)]),
      installed: stagedInstall.entries,
      changes: stagedInstall.changes,
      restore: async () => {
        await locked.restore();
        await installed?.restore();
      },
      // Each folder is removed even when removing another fails (#988).
      dispose: () =>
        runCleanups([
          stagedInstall.dispose,
          locked.dispose,
          ...(installed ? [installed.dispose] : []),
        ]),
      registries: stagedInstall.registries,
      warnings: stagedInstall.warnings,
    };
  } catch (error) {
    throw await errorAfterCleanups(error, [...(staged ? [staged.dispose] : []), locked.dispose]);
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
 * @param {Map<string, ArtifactLockEntry>} approvedById Selections to install at an approved version.
 * @param {() => Promise<ProjectFormatter>} loadFormatter Formats the state and lock the install writes.
 */
async function installUnlockedArtifacts(
  unlocked,
  lock,
  dryRun,
  registry,
  preflight,
  approvedById,
  loadFormatter,
) {
  const createdDirectories = [".calavera", CACHE_ROOT, CACHE_PATH, TRANSACTION_ROOT];
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
        lockedById: approvedById,
        advanceIds: new Set(),
        dryRun,
        keptEntries: lock.artifacts,
        loadFormatter,
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
          `Could not install the unlocked artifacts this recipe selects (${ids}), and rolling back the partly committed install also failed, so the project may be partly changed. ${reason} Rollback failure: ${recoveryReason} Run create-project-calavera apply or any create-project-calavera artifacts command to retry the rollback.`,
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
 * Finds the payload of each locked selection in `recipe`. A payload that is missing from
 * `.calavera/packages/`, or that no longer matches its lock entry, is rebuilt from the lock through
 * the offline cache into a temporary folder outside the project, and the returned sources point
 * there, so a caller can plan against them before it writes anything (#988). Unless this is a dry
 * run, call `restore` after the command's last planning step, to copy the rebuilt packages into
 * `.calavera/packages/`. Call `dispose` to remove the temporary folders.
 *
 * @param {{ ai?: unknown }} recipe
 * @param {boolean} [dryRun]
 * @param {ArtifactServices} [services]
 * @returns {Promise<{ sources: Map<string, string>, restore: () => Promise<void>, dispose: () => Promise<void> }>}
 */
export async function lockedArtifactSources(recipe, dryRun = false, services = {}) {
  await recoverArtifactTransaction({ readOnly: dryRun });
  const registry = artifactRegistry(services);
  /** @type {Map<string, string>} */
  const sources = new Map();
  /** @type {{ stage: string, finalRoot: string }[]} */
  const restores = [];
  /** @type {string[]} */
  const temporaryRoots = [];
  const dispose = () =>
    runCleanups(temporaryRoots.map((root) => () => removeTemporaryFolder(root)));
  const restore = async () => {
    for (const { stage, finalRoot } of restores) {
      await rm(finalRoot, { recursive: true, force: true });
      await mkdir(dirname(finalRoot), { recursive: true });
      await cp(stage, finalRoot, { recursive: true });
    }
  };
  const packageSelections = Array.isArray(recipe.ai)
    ? recipe.ai.filter(
        (/** @type {unknown} */ item) =>
          item &&
          typeof item === "object" &&
          !Array.isArray(item) &&
          ("id" in item || "src" in item),
      )
    : [];
  if (packageSelections.length === 0) return { sources, restore, dispose };

  const selections = normalizeSelections(packageSelections);
  const lock = await readLock();
  const lockedById = new Map(lock.artifacts.map((entry) => [entry.id, entry]));

  try {
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
      if (validLocalPayload) {
        sources.set(selection.id, payloadPath);
        continue;
      }

      const temporaryRoot = await mkdtemp(join(tmpdir(), "calavera-locked-artifact-"));
      temporaryRoots.push(temporaryRoot);
      const { stage, extracted } = await rebuildLockedPackage(
        entry,
        temporaryRoot,
        dryRun,
        registry,
      );
      sources.set(selection.id, extracted.payloadPath);
      if (!dryRun) {
        restores.push({ stage, finalRoot: resolve(PACKAGE_PATH, selection.id, entry.version) });
      }
    }
  } catch (error) {
    throw await errorAfterCleanups(error, [dispose]);
  }
  return { sources, restore, dispose };
}

/**
 * Rebuilds the package `entry` locks, offline from the project's artifact cache, into
 * `temporaryRoot/package`, and checks its payload against the entry's `payloadHash`. A dry run
 * resolves through a copy of the cache in `temporaryRoot`, so it leaves the project's cache
 * unchanged. The caller owns `temporaryRoot` and removes it.
 *
 * @param {ArtifactLockEntry} entry
 * @param {string} temporaryRoot An empty folder outside the project.
 * @param {boolean} dryRun
 * @param {ArtifactRegistry} registry
 */
export async function rebuildLockedPackage(entry, temporaryRoot, dryRun, registry) {
  const stage = join(temporaryRoot, "package");
  const cache = dryRun ? join(temporaryRoot, "cache") : resolve(CACHE_PATH);
  if (dryRun && (await fileExists(CACHE_PATH))) {
    await cp(resolve(CACHE_PATH), cache, { recursive: true });
  }
  await mkdir(stage, { recursive: true });
  const resolution = await registry.resolve({
    id: entry.id,
    tag: entry.tag,
    version: entry.version,
    cache,
    offline: true,
  });
  const extracted = await registry.extract(resolution, stage, packageJson.version);
  if (extracted.payloadHash !== entry.payloadHash) {
    throw new Error(`Locked payload hash mismatch for ${entry.id}.`);
  }
  return { stage, extracted };
}

/**
 * @param {ArtifactOptions} options
 * @param {() => Promise<ProjectFormatter>} loadFormatter Formats the recipe the migration writes.
 */
async function migrateRecipe(options, loadFormatter) {
  const recipe = await readJson(options.config);
  if (!Array.isArray(recipe.ai)) return { command: "artifacts migrate", migrated: 0 };
  let migrated = 0;
  const ai = recipe.ai.map((/** @type {unknown} */ item) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || !("src" in item)) return item;
    // #1024: recipe validation trims a legacy src, so the migration trims it too.
    const src = String(item.src).trim();
    const artifact = artifactForLegacyPath(src);
    if (!artifact) throw new Error(`Unknown legacy artifact path: ${src}.`);
    migrated += 1;
    const target = "target" in item ? item.target : undefined;
    return { id: artifact.id, ...(target ? { target } : {}) };
  });
  if (migrated > 0) {
    // #987: formatted as apply formats the recipe (#669), so the Vite+ pre-commit hook leaves it
    // as written. A dry run formats it too, so it stops where the migration would.
    const recipeText = await formatRecordText(
      relative(process.cwd(), resolve(options.config)),
      { ...recipe, ai },
      loadFormatter,
    );
    if (!options.dryRun) await writeAtomicText(options.config, recipeText);
  }
  return {
    command: "artifacts migrate",
    dryRun: options.dryRun,
    migrated,
    recipe: { ...recipe, ai },
  };
}

/**
 * @param {ArtifactOptions} options
 * @param {{ resolve: typeof resolveArtifactPackage }} registry
 * @param {() => Promise<ProjectFormatter>} loadFormatter Formats the state when the cache block is recorded.
 */
async function artifactStatus(options, registry, loadFormatter) {
  const recipeFound = await fileExists(options.config);
  const recipe = recipeFound ? await readJson(options.config) : {};
  const selections = normalizePackageSelections(recipe.ai);
  const selectedIds = new Set(selections.map(({ id }) => id));
  /** @param {string[]} positionals @param {string[]} [flags] */
  const command = (positionals, flags) =>
    artifactCommand(recipe, options.config, positionals, flags);
  const lock = await readLock();
  const state = await readState();
  const stateByPath = new Map(state.aiArtifacts.map((item) => [item.path, item]));
  const lockedIds = new Set(lock.artifacts.map(({ id }) => id));
  const unlockedSelections = selections.filter(({ id }) => !lockedIds.has(id));
  // #960: checking for updates resolves every lock entry and unlocked selection through the cache,
  // so the cache block is written first. A dry run plans it and resolves through a temporary
  // cache, so it writes nothing.
  const resolvesPackages = Boolean(
    options.checkUpdates && lock.artifacts.length + unlockedSelections.length > 0,
  );
  const cacheBlock = resolvesPackages
    ? await planArtifactCacheBlock(
        state,
        await artifactCacheIgnoreLines(recipe, { resolvesPackages }),
        `artifacts ${options.artifactAction} --check-updates`,
      )
    : undefined;
  if (cacheBlock) {
    await commitArtifactCacheBlock(cacheBlock, state, loadFormatter, options.dryRun);
  }
  const temporaryCache =
    resolvesPackages && options.dryRun
      ? await mkdtemp(join(tmpdir(), "calavera-artifact-status-"))
      : undefined;
  const cache = temporaryCache ?? resolve(CACHE_PATH);
  // A failed update check names this command, so a person can retry the same report (#993).
  const retryCommand = command([options.artifactAction ?? "status"], ["--check-updates"]);
  try {
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
      const { latest, updateCheckFailure } = await checkForUpdate(
        options.checkUpdates,
        () => registry.resolve({ id: entry.id, tag: entry.tag, cache }),
        {
          packageName: entry.package,
          tag: entry.tag,
          // `artifacts update` refuses an artifact the recipe does not select.
          followLatestCommand:
            entry.tag === "next" && selectedIds.has(entry.id)
              ? artifactUpdateCommand(recipe, options.config, entry.id, "latest")
              : null,
          retryCommand,
        },
      );
      const updateAvailable = Boolean(latest && latest.version !== entry.version);
      artifacts.push({
        ...entry,
        installed: outputs.every(({ installed }) => installed),
        managed: outputs.every(({ managed }) => managed),
        locallyEdited: outputs.some(({ locallyEdited }) => locallyEdited),
        latestVersion: latest?.version ?? null,
        updateAvailable,
        releaseNotesUrl:
          latest && updateAvailable
            ? artifactReleaseNotesUrl(
                "repository" in latest ? latest.repository : undefined,
                latest.version,
              )
            : null,
        // `artifacts update` refuses an artifact the recipe does not select.
        updateCommand:
          updateAvailable && selectedIds.has(entry.id)
            ? artifactUpdateCommand(recipe, options.config, entry.id, entry.tag)
            : null,
        installCommand: null,
        // #992: without a recipe, status cannot say which lock entries an install would drop.
        selected: recipeFound ? selectedIds.has(entry.id) : null,
        updateCheckFailure,
      });
    }
    for (const selection of unlockedSelections) {
      const artifact = artifactForId(selection.id);
      if (!artifact) throw new Error(`Unknown Calavera artifact: ${selection.id}.`);
      const resolvedArtifact = resolveAiArtifacts({ ai: [selection] })[0];
      if (!resolvedArtifact) throw new Error(`Could not resolve artifact ${selection.id}.`);
      const { latest, updateCheckFailure } = await checkForUpdate(
        options.checkUpdates,
        () => registry.resolve({ id: selection.id, tag: "latest", cache }),
        {
          packageName: artifact.packageName,
          tag: "latest",
          followLatestCommand: null,
          retryCommand,
        },
      );
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
        releaseNotesUrl: null,
        updateCommand: null,
        installCommand: command(["install"]),
        selected: true,
        updateCheckFailure,
      });
    }
    // `--all` moves every selected artifact to the one channel `--tag` names, so it is offered only
    // while every locked selection follows the same channel.
    const selectedChannels = new Set(
      lock.artifacts.filter(({ id }) => selectedIds.has(id)).map(({ tag }) => tag),
    );
    // Only a selected artifact has an update command, so an offered `--all` has one channel.
    const [channel] = selectedChannels;
    const offersUpdateAll =
      selections.length > 1 &&
      selectedChannels.size === 1 &&
      artifacts.some(({ updateCommand }) => updateCommand !== null);
    // #993: `--all` resolves every selected artifact on the channel and stops at the first lookup
    // that fails, so it is withheld while a selected artifact's check failed, and status names them.
    const updateAllBlockedBy = offersUpdateAll
      ? artifacts
          .filter(({ id, updateCheckFailure }) => updateCheckFailure && selectedIds.has(id))
          .map(({ id }) => id)
      : [];
    const updateAll = offersUpdateAll && updateAllBlockedBy.length === 0;
    return {
      command: `artifacts ${options.artifactAction}`,
      dryRun: options.dryRun,
      offline: !options.checkUpdates,
      updateAllCommand: updateAll
        ? command(["update"], ["--all", ...artifactTagFlags(channel)])
        : null,
      checkUpdatesCommand: options.checkUpdates ? null : command(["status"], ["--check-updates"]),
      updateAllBlockedBy,
      ok: artifacts.every(isArtifactHealthy),
      artifacts,
      ignoreChanges: cacheBlock?.changes ?? [],
      pointers: artifactCachePointers(cacheBlock?.changes ?? []),
    };
  } finally {
    if (temporaryCache) await rm(temporaryCache, { recursive: true, force: true });
  }
}

/**
 * Asks the registry for the release on an artifact's channel when update checks are on. A failed
 * registry lookup is reported for that artifact alone, so the others still get a status (#993).
 * Only an error whose `code` names a registry, network, timeout, or TLS failure is reported this
 * way (see REGISTRY_LOOKUP_CODE). Every other error stops the report as before: Calavera's own,
 * which carry no code and say what to fix (an invalid npm configuration, a package whose identity
 * or integrity does not match, a lock entry with an unknown id or tag), and local file system or
 * Node errors, such as a cache folder Calavera cannot write. The report keeps a registry
 * error's `code`, `statusCode`, and the npm configuration notes Calavera adds, but never the
 * registry's message, because that is raw registry text, which can hold the request URL and
 * response details.
 *
 * @template {{ version: string }} T
 * @param {boolean | undefined} checkUpdates
 * @param {() => Promise<T>} lookup
 * @param {{ packageName: string, tag: string, followLatestCommand: string | null, retryCommand: string }} context
 * @returns {Promise<{ latest: T | null, updateCheckFailure: import("./artifact-status-report.js").UpdateCheckFailure | null }>}
 */
async function checkForUpdate(checkUpdates, lookup, context) {
  if (!checkUpdates) return { latest: null, updateCheckFailure: null };
  try {
    return { latest: await lookup(), updateCheckFailure: null };
  } catch (error) {
    const failure = updateCheckFailure(error, context);
    if (!failure) throw error;
    return { latest: null, updateCheckFailure: failure };
  }
}

// The codes of a failed registry lookup: an HTTP answer (npm-registry-fetch sets `E<status>`, or
// EOTP and EAUTHIP for some 401s), a missing version (ETARGET), a package document artifact-core
// could not read (EBADPACKUMENT), a fetch failure or abort
// (minipass-fetch), a proxy or timeout failure (@npmcli/agent), and DNS, socket, and TLS failures
// from Node. A local file system code, such as EACCES or ENOSPC from the cache, is not one.
const REGISTRY_LOOKUP_CODE = new RegExp(
  [
    "^E\\d{3}$",
    "^(EOTP|EAUTHIP|ETARGET|EBADPACKUMENT|FETCH_ERROR|FETCH_ABORTED|EINVALIDPROXY)$",
    "^E(CONNECTION|IDLE|RESPONSE|TRANSFER)TIMEOUT$",
    "^(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH)$",
    "^(CERT_|UNABLE_TO_|SELF_SIGNED_|DEPTH_ZERO_SELF_SIGNED_|ERR_TLS_|ERR_SSL_)",
  ].join("|"),
);

// minipass-fetch keeps FETCH_ERROR as the code and names the kind of failure, such as
// request-timeout or invalid-json, in `type`. Only a short identifier is kept.
const FETCH_ERROR_TYPE = /^[a-z-]{1,32}$/;

/**
 * Artifact-core's registry errors carry these notes as string arrays; any other error has none.
 *
 * @param {unknown} value
 * @returns {string[]}
 */
function notesList(value) {
  return Array.isArray(value) ? value : [];
}

/**
 * The report of a failed registry lookup, or undefined for an error that is not one.
 *
 * @param {unknown} error
 * @param {{ packageName: string, tag: string, followLatestCommand: string | null, retryCommand: string }} context
 * @returns {import("./artifact-status-report.js").UpdateCheckFailure | undefined}
 */
function updateCheckFailure(error, { packageName, tag, followLatestCommand, retryCommand }) {
  const fields =
    /** @type {{ code?: unknown, statusCode?: unknown, npmDiagnostics?: unknown, unsetVariables?: unknown, distTags?: unknown, type?: unknown, cause?: { distTags?: unknown } }} */ (
      error ?? {}
    );
  if (typeof fields.code !== "string" || !REGISTRY_LOOKUP_CODE.test(fields.code)) return undefined;
  const code = fields.code;
  const statusCode = typeof fields.statusCode === "number" ? fields.statusCode : null;
  const type =
    typeof fields.type === "string" && FETCH_ERROR_TYPE.test(fields.type) ? fields.type : null;
  const notes = {
    type,
    npmDiagnostics: notesList(fields.npmDiagnostics),
    unsetVariables: notesList(fields.unsetVariables),
  };
  // npm-pick-manifest throws ETARGET when no version matches the spec, and status always asks for
  // a dist-tag. It also throws ETARGET when the tag names a version the package document does not
  // list yet, so the package's tags tell the two apart. The npm configuration notes wrap the error
  // and keep the tags on its cause.
  if (code === "ETARGET") {
    const distTags = fields.distTags ?? fields.cause?.distTags;
    const hasTag = Object.hasOwn(Object(distTags), tag);
    return hasTag
      ? {
          code,
          statusCode,
          reason: `npm's ${tag} tag for ${packageName} names a version the registry does not list yet`,
          remedy: `Wait a few minutes for the registry to list it, then run: ${retryCommand}`,
          ...notes,
        }
      : {
          code,
          statusCode,
          reason: `npm has no ${tag} tag for ${packageName}, so Calavera could not check for an update on that channel`,
          remedy: followLatestCommand
            ? `To follow latest instead, run: ${followLatestCommand}`
            : null,
          ...notes,
        };
  }
  const kind = type === null ? code : `${code} ${type}`;
  const details = statusCode === null ? kind : `${kind}, HTTP ${statusCode}`;
  // npm-registry-fetch sets `statusCode` on every HTTP error, while its `code` is EOTP or EAUTHIP
  // for some 401 answers, so the status picks the remedy.
  let check = "the network connection and the npm registry settings";
  if (statusCode === 401 || statusCode === 403) {
    check = "the npm credentials for this registry";
  } else if (statusCode === 404) {
    check = `that the npm registry settings point at a registry that publishes ${packageName}`;
  }
  return {
    code,
    statusCode,
    reason: `the registry lookup for ${packageName} failed (${details})`,
    remedy: `Check ${check}, then run: ${retryCommand}`,
    ...notes,
  };
}

/**
 * Commits the artifact cache block and its state record through the artifact transaction, so an
 * interrupted write leaves both as they were (#960). The commands commit it before they resolve
 * anything, so a cache the registry fills is ignored even when the command fails afterwards, and
 * `.gitignore` is written right after it was read. Writes nothing when neither file changes. A dry
 * run formats the state it would record and writes nothing, so it stops where the command would
 * when the project's formatter cannot load or rejects the text (#838).
 *
 * @param {ArtifactCacheBlockPlan} cacheBlock
 * @param {ReturnType<typeof createEmptyState>} state
 * @param {() => Promise<ProjectFormatter>} loadFormatter
 * @param {boolean} dryRun
 */
async function commitArtifactCacheBlock(cacheBlock, state, loadFormatter, dryRun) {
  if (!cacheBlock.writesState) return;
  const stateText = await formatRecordText(
    STATE_PATH,
    { ...state, gitignoreBlocks: cacheBlock.gitignoreBlocks },
    loadFormatter,
  );
  if (dryRun) return;
  const stagingRoot = resolve(TRANSACTION_ROOT, `${Date.now()}-${process.pid}`);
  const stagedState = join(stagingRoot, "records", "state.json");
  const stagedGitignore = join(stagingRoot, "records", "gitignore");
  let commitStarted = false;
  try {
    await mkdir(dirname(stagedState), { recursive: true });
    await writeFile(stagedState, stateText, { flag: "wx" });
    if (cacheBlock.writesGitignore) {
      await writeFile(stagedGitignore, /** @type {string} */ (cacheBlock.contents), { flag: "wx" });
    }
    commitStarted = true;
    await commitArtifactTransaction(stagingRoot, [
      ...(cacheBlock.writesGitignore
        ? [{ staged: stagedGitignore, target: resolve(GITIGNORE_PATH) }]
        : []),
      { staged: stagedState, target: resolve(STATE_PATH) },
    ]);
  } finally {
    // A commit that failed part way leaves its journal and staging for recovery.
    if (!commitStarted || !(await fileExists(TRANSACTION_PATH))) {
      await rm(stagingRoot, { recursive: true, force: true });
    }
  }
}

/**
 * @param {ArtifactOptions} options
 * @param {boolean} updating
 * @param {ArtifactRegistry} registry
 * @param {() => Promise<ProjectFormatter>} loadFormatter
 */
async function installArtifacts(options, updating, registry, loadFormatter) {
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

  // #991: a targeted update installs and locks only the artifact it names. Every other selection
  // with a lock entry is staged again at its locked version, and a selection without one is left
  // for `artifacts install` or `artifacts update --all`, which request every selection.
  // `normalizeSelections` maps the recipe's `ai` items one to one, so an index marks both.
  const staged = selections.map(({ id }) => requestedIds.has(id) || lockedById.has(id));
  const command = updating ? "artifacts update" : "artifacts install";
  // #960: the cache block is planned and committed before anything resolves, so an edited block
  // stops the command before the registry fills the cache, and a cache the registry fills is
  // ignored even when the install fails afterwards. The install then reads the recorded block
  // back from the state.
  const state = await readState();
  const cacheBlock = await planArtifactCacheBlock(
    state,
    await artifactCacheIgnoreLines(recipe),
    command,
  );
  await commitArtifactCacheBlock(cacheBlock, state, loadFormatter, options.dryRun);
  const result = await stageArtifactInstall(
    Array.isArray(recipe.ai)
      ? {
          ...recipe,
          ai: recipe.ai.filter(
            (/** @type {unknown} */ _item, /** @type {number} */ index) => staged[index],
          ),
        }
      : recipe,
    selections.filter((_selection, index) => staged[index]),
    {
      lockedById,
      advanceIds: updating ? requestedIds : new Set(),
      artifactTag: options.artifactTag,
      dryRun: options.dryRun,
      keptEntries: [],
      loadFormatter,
    },
    registry,
  );
  await result.dispose();
  return {
    command,
    dryRun: options.dryRun,
    artifacts: result.entries,
    // #992: the lock written above holds only staged selections, so it no longer holds the entries
    // of artifacts the recipe does not select.
    removedLockEntries: currentLock.artifacts
      .filter(({ id }) => !selectedIds.has(id))
      .map(({ id, version, tag }) => ({ id, version, tag })),
    changes: result.changes,
    ignoreChanges: cacheBlock.changes,
    pointers: artifactCachePointers(cacheBlock.changes),
    registries: result.registries,
    warnings: result.warnings,
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
 * @param {{ lockedById: Map<string, ArtifactLockEntry>, advanceIds: Set<string>, artifactTag?: "latest" | "next", dryRun: boolean, keptEntries: ArtifactLockEntry[], loadFormatter: () => Promise<ProjectFormatter>, preflight?: (sources: Map<string, string>) => Promise<void> }} plan
 *   `loadFormatter` formats the state and the lock the transaction commits (#838).
 * @param {ArtifactRegistry} registry
 * @returns {Promise<{ entries: ArtifactLockEntry[], changes: AiChange[], sourcePaths: Map<string, string>, dispose: () => Promise<void> } & ArtifactRegistryNotes>}
 */
async function stageArtifactInstall(recipe, selections, plan, registry) {
  const { lockedById, advanceIds, artifactTag, dryRun, loadFormatter } = plan;
  // A project whose formatter cannot load stops the dry run and the install alike, before
  // anything is resolved or staged.
  await loadFormatter();
  const stagingRoot = dryRun
    ? await mkdtemp(join(tmpdir(), "calavera-artifact-stage-"))
    : resolve(TRANSACTION_ROOT, `${Date.now()}-${process.pid}`);
  const dispose = () => removeTemporaryFolder(stagingRoot);
  /** @type {Map<string, string>} */
  const sourcePaths = new Map();
  /** @type {ArtifactLockEntry[]} */
  const nextEntries = [];
  const collected = registryNotes();
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
      collected.add(resolution);
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
    const paths = new Set(applied.artifacts.map(({ path }) => path));
    // #838: formatted in the dry run as well, so the dry run stops where the install would.
    const stateText = await formatRecordText(
      STATE_PATH,
      {
        ...state,
        aiArtifacts: [
          ...state.aiArtifacts.filter(({ path }) => !paths.has(path)),
          ...applied.artifacts,
        ],
      },
      loadFormatter,
    );
    const lockText = await formatRecordText(
      LOCK_PATH,
      { schemaVersion: 1, artifacts: [...plan.keptEntries, ...nextEntries] },
      loadFormatter,
    );
    if (!dryRun) {
      if (plan.preflight) await plan.preflight(sourcePaths);
      const stagedState = join(stagingRoot, "records", "state.json");
      const stagedLock = join(stagingRoot, "records", "artifacts.lock.json");
      await mkdir(dirname(stagedState), { recursive: true });
      await writeFile(stagedState, stateText, { flag: "wx" });
      await writeFile(stagedLock, lockText, { flag: "wx" });

      const operations = selections.map((selection) => {
        const entry = nextEntries.find(({ id }) => id === selection.id);
        if (!entry) throw new Error(`Missing lock entry for ${selection.id}.`);
        return {
          staged: join(stagingRoot, "packages", selection.id),
          target: resolve(PACKAGE_PATH, selection.id, entry.version),
        };
      });
      const changedPaths = new Set(
        applied.changes.filter(({ type }) => type !== "unchanged").map(({ path }) => path),
      );
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
    return {
      entries: nextEntries,
      changes: applied.changes,
      sourcePaths,
      dispose,
      ...collected.notes(),
    };
  } catch (error) {
    // A commit that failed part way leaves its journal and staging for recovery.
    if (!commitStarted || !(await fileExists(TRANSACTION_PATH))) {
      throw await errorAfterCleanups(error, [dispose]);
    }
    throw error;
  }
}

/**
 * The catalog selections of a recipe's `ai` items, in order: an item selected by its legacy type
 * and src is named by its catalog ID, as its lock entry is.
 *
 * @param {unknown} ai
 */
export function normalizePackageSelections(ai) {
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
  /** @type {Map<string, number>} */
  const firstIndexById = new Map();
  return ai.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new Error("Artifact selections must be objects.");
    }
    const artifact =
      "id" in item
        ? artifactForId(String(item.id))
        : "src" in item
          ? // #1024: recipe validation trims a legacy src, so a selection trims it too.
            artifactForLegacyPath(String(item.src).trim())
          : undefined;
    if (!artifact) throw new Error("Unknown artifact selection.");
    assertFirstSelection(firstIndexById, artifact.id, index);
    const target = "target" in item ? String(item.target).trim() : artifact.defaultTarget;
    return { id: artifact.id, ...(target ? { target } : {}) };
  });
}

/** @returns {Promise<{ schemaVersion: number, artifacts: ArtifactLockEntry[] }>} */
export async function readLock() {
  if (!(await fileExists(LOCK_PATH))) return { schemaVersion: 1, artifacts: [] };
  const lock = await readJson(LOCK_PATH);
  if (!Array.isArray(lock.artifacts)) throw new Error("Invalid artifact lockfile.");
  return /** @type {{ schemaVersion: number, artifacts: ArtifactLockEntry[] }} */ (lock);
}

export async function readState() {
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
  await writeAtomicText(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string} path @param {string} text */
async function writeAtomicText(path, text) {
  const absolute = resolve(path);
  await mkdir(dirname(absolute), { recursive: true });
  const temporary = `${absolute}.${process.pid}.tmp`;
  await writeFile(temporary, text, { flag: "wx" });
  await rename(temporary, absolute);
}

/**
 * The text an artifact command writes as the JSON file at `path`, such as the state and lock the
 * artifact transaction commits (#838) or the recipe `artifacts migrate` rewrites (#987): `value` as
 * JSON, formatted by the project's formatter, so the Vite+ pre-commit hook leaves the committed file
 * as written.
 *
 * @param {string} path The project path of the file, which picks the formatter's settings.
 * @param {unknown} value
 * @param {() => Promise<ProjectFormatter>} loadFormatter
 * @returns {Promise<string>}
 */
async function formatRecordText(path, value, loadFormatter) {
  return formatGeneratedText(path, `${JSON.stringify(value, null, 2)}\n`, loadFormatter);
}

/**
 * Moves each staged path to its target through a journal that
 * `recoverArtifactTransaction` rolls back. Refuses, before anything moves, a
 * transaction root outside `.calavera/.transactions`, and an operation whose
 * staged path is outside the transaction root or missing, whose target is
 * outside the project, or whose target an earlier operation already names,
 * each with its own message.
 *
 * @param {string} transactionRoot
 * @param {{ staged: string, target: string }[]} operations
 */
export async function commitArtifactTransaction(transactionRoot, operations) {
  const projectRoot = resolve(".");
  const normalizedRoot = resolve(transactionRoot);
  if (!isPathInside(resolve(TRANSACTION_ROOT), normalizedRoot)) {
    throw new Error(
      `The artifact transaction root ${normalizedRoot} is outside ${resolve(TRANSACTION_ROOT)}.`,
    );
  }
  /** @type {Map<string, number>} */
  const seenTargets = new Map();
  const journalOperations = [];
  for (const [index, operation] of operations.entries()) {
    const staged = resolve(operation.staged);
    const target = resolve(operation.target);
    if (!isPathInside(normalizedRoot, staged)) {
      throw new Error(
        `Artifact transaction operation ${index} stages ${staged}, which is outside the transaction root ${normalizedRoot}.`,
      );
    }
    if (!isPathInside(projectRoot, target)) {
      throw new Error(
        `Artifact transaction operation ${index} targets ${target}, which is outside the project ${projectRoot}.`,
      );
    }
    const earlier = seenTargets.get(target);
    if (earlier !== undefined) {
      throw new Error(
        `Artifact transaction operations ${earlier} and ${index} both target ${target}.`,
      );
    }
    if (!(await fileExists(staged))) {
      throw new Error(
        `Artifact transaction operation ${index} stages ${staged}, which does not exist.`,
      );
    }
    seenTargets.set(target, index);
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

/**
 * Rolls back an artifact transaction that an interrupted command left pending, and removes its
 * journal. With `readOnly`, as in a dry run, it throws instead, because the rollback writes files.
 *
 * @param {{ readOnly?: boolean }} [options]
 */
export async function recoverArtifactTransaction(options = {}) {
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
  if (!isPathInside(resolve(TRANSACTION_ROOT), transactionRoot)) {
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
      !isPathInside(transactionRoot, staged) ||
      !isPathInside(transactionRoot, backup) ||
      !isPathInside(projectRoot, target)
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
