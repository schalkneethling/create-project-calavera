// @ts-check
import { createHash } from "node:crypto";
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  rename,
  rm,
  rmdir,
  writeFile,
} from "node:fs/promises";
import nodePath, { dirname, join, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import { artifactForId, artifactForLegacyPath } from "@schalkneethling/calavera-artifact-core";
import {
  extractArtifactPackage,
  hashArtifactPayload,
  resolveArtifactPackage,
} from "@schalkneethling/calavera-artifact-core/registry";
import packageJson from "../package.json" with { type: "json" };

import {
  AI_ARTIFACT_OUTPUT_FOLDERS,
  aiArtifactOutputPaths,
  buildAiApplyResult,
  CODE_RABBIT_CONFIG_PATH,
  hashAiInstall,
  resolveAiArtifacts,
} from "./ai/artifacts.js";
import { assertFirstSelection, assertNoLegacyEntryNeedsWiring } from "./ai/recipe-items.js";
import { GITIGNORE_PATH, planGitignoreBlocks } from "./ignore-lines.js";
import { validateRecipe } from "./recipe.js";
import { artifactReleaseNotesUrl, isArtifactHealthy } from "./artifact-status-report.js";
import {
  artifactCommand,
  artifactTagFlags,
  artifactUpdateCommand,
} from "./project-local-commands.js";
import { createEmptyState, mergeInstalledAiArtifacts, normalizeState } from "./state.js";
import {
  cleanupFailures,
  createTemporaryFolder,
  errorAfterCleanups,
  errorWithLeftovers,
  removeTemporaryFolder,
  runCleanups,
  temporaryFolderLeftovers,
} from "./utils/cleanup.js";
import { fileExists, isPathInside, parseJSON, readJSON } from "./utils/fs.js";
import { formatGeneratedText, generatedJSONFormatter } from "./utils/generated-text.js";
import { rewriteLossProblem } from "./utils/json-rewrite.js";
import { withDeadline } from "./utils/deadline.js";
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
 * @typedef {{ resolve?: typeof resolveArtifactPackage, extract?: typeof extractArtifactPackage, loadFormatter?: () => Promise<ProjectFormatter>, updateCheckDeadlineMs?: number }} ArtifactServices
 *   `loadFormatter` loads the formatter for the state and lock an install writes, and for the
 *   recipe a migration writes; without it, the project's own formatter in the working directory.
 *   `updateCheckDeadlineMs` holds each registry lookup of an update check to that deadline instead
 *   of UPDATE_CHECK_DEADLINE_MS, so a test can use a short one.
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
 * How long one registry lookup of an update check may take, in milliseconds, before status reports
 * it for that artifact and moves on (#1138). npm's own timeout is five minutes, which leaves a
 * registry that accepts the connection and never answers holding the report that long.
 */
const UPDATE_CHECK_DEADLINE_MS = 15_000;

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
      // artifact-core's registry also names its `setting`, for messages only (ADR-0021), so the
      // reported registry keeps only the origin and the source.
      if (registry) {
        registries.set(`${registry.origin} ${registry.source}`, {
          origin: registry.origin,
          source: registry.source,
        });
      }
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
      return artifactStatus(options, registry, loadFormatter, {
        updateCheckDeadlineMs: services.updateCheckDeadlineMs,
      });
    case "install":
      return installArtifacts(options, false, registry, loadFormatter);
    case "update":
      return installArtifacts(options, true, registry, loadFormatter);
    default:
      throw new Error("Artifacts command must be install, status, doctor, migrate, or update.");
  }
}

/**
 * The `artifacts status` report, read without writing anything into the project, for the read-only
 * `artifact_status` MCP tool (#1052, ADR-0018 Decision 3). It runs the same core function as
 * `artifacts status`, with three differences that ADR-0020, Decision 1 sets for the tool. It never
 * recovers a pending artifact transaction: it returns the `pending-transaction` report instead,
 * before it reads any record or resolves any package. With `checkUpdates`, it plans and records no
 * artifact cache block and resolves through a temporary cache that it removes afterward, as a dry
 * run does, so `ignoreChanges` and `pointers` are empty. And it never loads the project's
 * formatter, because it formats nothing.
 *
 * @param {{ config: string, checkUpdates?: boolean }} options
 * @param {ArtifactServices} [services] Only `resolve` and `updateCheckDeadlineMs` are read; the
 *   formatter is never loaded.
 */
export async function readArtifactStatus(options, services = {}) {
  if (await fileExists(TRANSACTION_PATH)) return pendingTransactionReport(options.config);
  return artifactStatus(
    {
      config: options.config,
      dryRun: false,
      artifactAction: "status",
      checkUpdates: options.checkUpdates,
    },
    artifactRegistry(services),
    async () => {
      throw new Error("The read-only artifact status report never loads the formatter.");
    },
    { readOnly: true, updateCheckDeadlineMs: services.updateCheckDeadlineMs },
  );
}

/**
 * The read-only report while an artifact transaction is pending (ADR-0020, owner decisions 20 and
 * 23; owner decision of 2026-11-22 on #1052). It is a result, not an error, so the phase function
 * that ADR-0020 adds later only adds fields. It carries the fields every status report carries,
 * with no artifacts and `ok: false`, because the records cannot be read yet, and three more:
 * `phase`; `rollbackFiles`, which lists the project paths the rollback would restore from their
 * backups or remove, read from the journal without writing, or is null when the journal cannot be
 * read; and `remedy`, which tells the person to save edits to those files before running
 * `artifacts status`, which rolls the transaction back. The remedy is fixed text plus a command
 * built from the recipe's package manager, which only selects a runner from a fixed list, so no
 * text from the recipe or the journal reaches it; the journal's paths stay in `rollbackFiles`. A
 * recipe it cannot read only makes the command use the npm runner.
 *
 * @param {string} config
 */
async function pendingTransactionReport(config) {
  let recipe = {};
  try {
    recipe = await readJson(config);
  } catch {
    // A missing or unreadable recipe only changes the runner the command names.
  }
  const rollbackFiles = await pendingRollbackFiles();
  const command = artifactCommand(recipe, config, ["status"]);
  let files;
  if (rollbackFiles === null) {
    files = `Calavera cannot read the journal, ${TRANSACTION_PATH}, or the journal fails the rollback's checks, so it cannot list the files the rollback would restore or remove. Save any edits to the files the stopped operation was changing, then run`;
  } else if (rollbackFiles.length === 0) {
    files = "The rollback restores or removes no file, so run";
  } else {
    files = "Save any edits to the files in rollbackFiles first, then run";
  }
  return {
    command: "artifacts status",
    dryRun: false,
    offline: true,
    updateAllCommand: null,
    checkUpdatesCommand: null,
    updateAllBlockedBy: [],
    ok: false,
    artifacts: [],
    ignoreChanges: [],
    pointers: [],
    phase: "pending-transaction",
    rollbackFiles,
    remedy: `An artifact operation stopped before its rollback ran, so this read-only report does not read the artifact records, because the rollback may still change them. ${files}: ${command}. It rolls the transaction back and reports the artifact status.`,
  };
}

/**
 * The project paths of the files the pending transaction's rollback would restore from their
 * backups or remove, as `recoverArtifactTransaction` decides it, read without writing, or null
 * when the journal cannot be read or fails its checks.
 *
 * @returns {Promise<string[] | null>}
 */
async function pendingRollbackFiles() {
  let operations;
  try {
    ({ operations } = await readTransactionJournal());
  } catch {
    return null;
  }
  // The journal check refuses a target that is the project root or that another target equals
  // (#1193), so every target has its own, non-empty project path.
  const replaced = [];
  for (const operation of operations) {
    if ((await fileExists(operation.backup)) || !operation.hadTarget) {
      replaced.push(relative(resolve("."), operation.target));
    }
  }
  return replaced;
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
  // #1209: apply rebuilds a missing locked package into `.calavera/packages` (`restore`) and writes
  // the outputs of every selection itself, without an artifact transaction, so a linked folder on
  // any of those paths stops apply and its dry run before anything is rebuilt, installed, or
  // written. The install of the unlocked selections checks only its own folders. A recipe without
  // AI items writes no artifact, so it is not checked.
  if (resolveAiArtifacts(recipe).length > 0) {
    await refuseLinkedArtifactFolders(artifactInstallFolders(recipe, selections));
  }
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
    // `lstat`, not `fileExists`, so a symbolic link whose target is missing counts as existing,
    // and the cleanup below never removes a link the person made (#1193).
    try {
      await lstat(path);
      existedBefore.add(path);
    } catch {
      // Missing, so this attempt may create it and the cleanup may remove it.
    }
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
    // Not "were not changed": under create-here, apply has already recorded the package.json it
    // created in the state before this step (#1085).
    const message = `${stopped}, so this step did not change the artifact lock, artifact outputs, or Calavera state. ${reason} Review the install with create-project-calavera artifacts install --dry-run.`;
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

      const temporaryRoot = await createTemporaryFolder("calavera-locked-artifact-");
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
  const text = await readFile(options.config, "utf8");
  const recipe = /** @type {Record<string, unknown>} */ (parseJSON(text, options.config));
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
    const path = relative(process.cwd(), resolve(options.config));
    // #1078: the recipe is written back from its parsed value, so a hand-edited recipe can lose a
    // repeated key or a number's spelling. The migration stops before writing, in a dry run too.
    // The problem names a line rather than a value, because the recipe records input values. The
    // check asks the formatter the write below uses, so it judges the spelling that is written.
    const loss = await rewriteLossProblem(
      text,
      path,
      await generatedJSONFormatter(path, loadFormatter),
      {
        withoutValues: true,
      },
    );
    if (loss !== undefined) {
      throw new Error(
        `${path} ${loss}. artifacts migrate rewrites the whole recipe to replace each legacy entry, so it stops instead of changing that silently. Edit that line, then run artifacts migrate again.`,
      );
    }
    // #987: formatted as apply formats the recipe (#669), so the Vite+ pre-commit hook leaves it
    // as written. A dry run formats it too, so it stops where the migration would.
    const recipeText = await formatRecordText(path, { ...recipe, ai }, loadFormatter);
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
 * @param {{ readOnly?: boolean, updateCheckDeadlineMs?: number }} [mode] With `readOnly`, as
 *   `readArtifactStatus` runs it, the report plans no cache block and resolves through a temporary
 *   cache, so it writes nothing. `updateCheckDeadlineMs` bounds each registry lookup (#1138).
 */
async function artifactStatus(
  options,
  registry,
  loadFormatter,
  { readOnly = false, updateCheckDeadlineMs = UPDATE_CHECK_DEADLINE_MS } = {},
) {
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
  // cache, so it writes nothing. A read-only report (#1052) does not plan it at all, because it
  // neither writes the block nor reports a change to it, and resolves through a temporary cache.
  const resolvesPackages = Boolean(
    options.checkUpdates && lock.artifacts.length + unlockedSelections.length > 0,
  );
  // #1209: the update check fills the registry cache in `.calavera/cache` even when the cache block
  // is already recorded and `commitArtifactCacheBlock` writes nothing, so a linked `.calavera` stops
  // the report and its dry run here, as it stops an install.
  if (resolvesPackages && !readOnly) await refuseLinkedArtifactFolders([dirname(CACHE_ROOT)]);
  const cacheBlock =
    resolvesPackages && !readOnly
      ? await planArtifactCacheBlock(
          state,
          await artifactCacheIgnoreLines(recipe, { resolvesPackages }),
          `artifacts ${options.artifactAction} --check-updates`,
        )
      : undefined;
  if (cacheBlock) {
    // The status report has no field for a folder left behind (#1172), so a staging folder that
    // stays still stops the report, now with the folder and its remedy (#1136).
    const leftoverFailures = await commitArtifactCacheBlock(
      cacheBlock,
      state,
      loadFormatter,
      options.dryRun,
    );
    if (leftoverFailures.length > 0) {
      throw errorWithLeftovers(
        new Error("Calavera could not remove the staging folder of the artifact cache block."),
        leftoverFailures,
      );
    }
  }
  const temporaryCache =
    resolvesPackages && (options.dryRun || readOnly)
      ? await mkdtemp(join(tmpdir(), "calavera-artifact-status-"))
      : undefined;
  const cache = temporaryCache ?? resolve(CACHE_PATH);
  // A failed update check names this command, so a person can retry the same report (#993).
  const retryCommand = command([options.artifactAction ?? "status"], ["--check-updates"]);
  // The URLs of the registries that missed a lookup's deadline in this report. The lookups after
  // that one to the same registry are skipped instead of each waiting (#1138). The URL, path
  // included, is the key, so two registries on one host are told apart.
  /** @type {Set<string>} */
  const silentRegistries = new Set();
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
        (signal, beforeLookup) =>
          registry.resolve({ id: entry.id, tag: entry.tag, cache, signal, beforeLookup }),
        {
          packageName: entry.package,
          tag: entry.tag,
          // `artifacts update` refuses an artifact the recipe does not select.
          followLatestCommand:
            entry.tag === "next" && selectedIds.has(entry.id)
              ? artifactUpdateCommand(recipe, options.config, entry.id, "latest")
              : null,
          retryCommand,
          deadlineMs: updateCheckDeadlineMs,
          silentRegistries,
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
        (signal, beforeLookup) =>
          registry.resolve({ id: selection.id, tag: "latest", cache, signal, beforeLookup }),
        {
          packageName: artifact.packageName,
          tag: "latest",
          followLatestCommand: null,
          retryCommand,
          deadlineMs: updateCheckDeadlineMs,
          silentRegistries,
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
 * A registry lookup that missed its deadline (#1138). Status creates it, so the report can tell it
 * apart from a registry error that merely carries the same code.
 */
class UpdateCheckTimeout extends Error {
  /** @param {number} deadlineMs */
  constructor(deadlineMs) {
    super(`The registry did not answer within ${deadlineMs} ms.`);
    this.name = "UpdateCheckTimeout";
    this.code = "ELOOKUPTIMEOUT";
    this.deadlineMs = deadlineMs;
  }
}

/**
 * A lookup that status did not send, because an earlier lookup to the same registry missed its
 * deadline in this report (#1138).
 */
class UpdateCheckSkipped extends Error {
  /** @param {string} registryOrigin @param {number} deadlineMs */
  constructor(registryOrigin, deadlineMs) {
    super(
      `The registry ${registryOrigin} did not answer an earlier lookup within ${deadlineMs} ms.`,
    );
    this.name = "UpdateCheckSkipped";
    this.code = "ELOOKUPSKIPPED";
    this.registryOrigin = registryOrigin;
    this.deadlineMs = deadlineMs;
  }
}

/**
 * The npm configuration notes of a lookup that missed its deadline. Artifact-core attaches them
 * to the error the aborted request ends with, which usually arrives within the same turn of the
 * event loop as the abort. The lookup gets until the next turn, so a lookup that ignores the
 * abort cannot hold the report; it then has no notes.
 *
 * @param {Promise<unknown>} pending
 */
async function abortedLookupNotes(pending) {
  const late = await Promise.race([
    pending.then(
      () => undefined,
      (/** @type {unknown} */ error) => error,
    ),
    new Promise((done) => setImmediate(() => done(undefined))),
  ]);
  const fields = /** @type {{ npmDiagnostics?: unknown, unsetVariables?: unknown }} */ (late ?? {});
  return {
    npmDiagnostics: notesList(fields.npmDiagnostics),
    unsetVariables: notesList(fields.unsetVariables),
  };
}

/**
 * Asks the registry for the release on an artifact's channel when update checks are on. A failed
 * registry lookup is reported for that artifact alone, so the others still get a status (#993).
 * Each lookup is held to `context.deadlineMs` with the version notice's deadline and abort
 * (ADR-0019 Decision 2): at the deadline the lookup's signal is aborted, which ends pacote's
 * request, and the artifact is reported as ELOOKUPTIMEOUT, even if the lookup ignores the abort.
 * The lookup names its registry through `beforeLookup` before it sends a request. Once a lookup to
 * a registry times out, the registry's URL joins `context.silentRegistries`, and each later lookup
 * to that URL is stopped there and reported as ELOOKUPSKIPPED, with the same remedy, so the report
 * waits for one deadline per silent registry instead of one per artifact. The URL includes the
 * path, so a registry on the same host under another path is still checked. A lookup that never
 * names its registry, such as a test stand-in, is never skipped.
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
 * @param {(signal: AbortSignal, beforeLookup: (registry: { origin: string, url: string }) => void) => Promise<T>} lookup
 * @param {{ packageName: string, tag: string, followLatestCommand: string | null, retryCommand: string, deadlineMs: number, silentRegistries: Set<string> }} context
 * @returns {Promise<{ latest: T | null, updateCheckFailure: import("./artifact-status-report.js").UpdateCheckFailure | null }>}
 */
async function checkForUpdate(checkUpdates, lookup, context) {
  if (!checkUpdates) return { latest: null, updateCheckFailure: null };
  /** @type {Promise<T> | undefined} */
  let pending;
  /** @type {{ origin: string, url: string } | undefined} */
  let lookupRegistry;
  /** @param {{ origin: string, url: string }} registry */
  const beforeLookup = (registry) => {
    lookupRegistry = registry;
    if (context.silentRegistries.has(registry.url)) {
      throw new UpdateCheckSkipped(registry.origin, context.deadlineMs);
    }
  };
  try {
    const latest = await withDeadline(
      context.deadlineMs,
      () => new UpdateCheckTimeout(context.deadlineMs),
      (signal) => (pending = lookup(signal, beforeLookup)),
    );
    return { latest, updateCheckFailure: null };
  } catch (error) {
    if (error instanceof UpdateCheckSkipped) {
      return { latest: null, updateCheckFailure: lookupSkippedFailure(error, context) };
    }
    if (error instanceof UpdateCheckTimeout) {
      if (lookupRegistry) context.silentRegistries.add(lookupRegistry.url);
      // withDeadline calls the lookup before its deadline can pass, so `pending` is set.
      const notes = await abortedLookupNotes(/** @type {Promise<T>} */ (pending));
      return { latest: null, updateCheckFailure: lookupTimeoutFailure(error, notes, context) };
    }
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
 * An origin (protocol, host, and port) as artifact-core reports it, or null for anything else.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function originField(value) {
  return typeof value === "string" && URL.canParse(value) && new URL(value).origin === value
    ? value
    : null;
}

/**
 * The origin of an http or https URL, or null; the path and query, which can carry a token, are
 * dropped.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function uriOrigin(value) {
  if (typeof value !== "string" || !URL.canParse(value)) return null;
  const url = new URL(value);
  return /^https?:$/.test(url.protocol) ? url.origin : null;
}

/**
 * The report of a lookup that missed its deadline (#1138). It has no HTTP status or origin,
 * because the registry never answered.
 *
 * @param {UpdateCheckTimeout} timeout
 * @param {{ npmDiagnostics: string[], unsetVariables: string[] }} notes
 * @param {{ packageName: string, retryCommand: string }} context
 * @returns {import("./artifact-status-report.js").UpdateCheckFailure}
 */
function lookupTimeoutFailure(timeout, notes, { packageName, retryCommand }) {
  return {
    code: timeout.code,
    statusCode: null,
    reason: `the registry did not answer the lookup for ${packageName} within ${timeout.deadlineMs} ms`,
    remedy: `Check the network connection and the npm registry settings, then run: ${retryCommand}`,
    type: null,
    origin: null,
    ...notes,
  };
}

/**
 * The report of a lookup that status skipped after an earlier lookup to the same registry missed
 * its deadline (#1138). It has the timeout's remedy, and no npm configuration notes, because the
 * timed-out artifact already reports them.
 *
 * @param {UpdateCheckSkipped} skipped
 * @param {{ packageName: string, retryCommand: string }} context
 * @returns {import("./artifact-status-report.js").UpdateCheckFailure}
 */
function lookupSkippedFailure(skipped, { packageName, retryCommand }) {
  return {
    code: skipped.code,
    statusCode: null,
    reason: `Calavera did not look up ${packageName}, because the registry ${skipped.registryOrigin} did not answer an earlier lookup within ${skipped.deadlineMs} ms`,
    remedy: `Check the network connection and the npm registry settings, then run: ${retryCommand}`,
    type: null,
    origin: null,
    npmDiagnostics: [],
    unsetVariables: [],
  };
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
    /** @type {{ code?: unknown, statusCode?: unknown, npmDiagnostics?: unknown, unsetVariables?: unknown, distTags?: unknown, type?: unknown, origin?: unknown, setting?: unknown, layer?: unknown, registryOrigin?: unknown, uri?: unknown, cause?: { distTags?: unknown, uri?: unknown } }} */ (
      error ?? {}
    );
  if (typeof fields.code !== "string" || !REGISTRY_LOOKUP_CODE.test(fields.code)) return undefined;
  const code = fields.code;
  const statusCode = typeof fields.statusCode === "number" ? fields.statusCode : null;
  const type =
    typeof fields.type === "string" && FETCH_ERROR_TYPE.test(fields.type) ? fields.type : null;
  // ADR-0021: the origin that answered an HTTP failure, or null for a failure without one.
  // artifact-core sets `origin` on a 401 or 403; npm-registry-fetch sets `uri` on every HTTP
  // error, kept on the cause when the loader's notes wrap it. Only its origin is kept.
  const origin =
    statusCode === null
      ? null
      : (originField(fields.origin) ?? uriOrigin(fields.uri) ?? uriOrigin(fields.cause?.uri));
  const notes = {
    type,
    origin,
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
  // for some 401 answers, so the status picks the remedy. Calavera sends no credentials
  // (ADR-0021), so a 401 or 403 says so and points at the setting that chose the registry.
  if (statusCode === 401 || statusCode === 403) {
    const registryOrigin = originField(fields.registryOrigin);
    let reason = `the registry lookup for ${packageName} failed (${details}), and Calavera sends no credentials to any registry`;
    if (origin !== null && (registryOrigin === null || origin === registryOrigin)) {
      reason = `the registry ${origin} answered ${statusCode} (${code}), and Calavera sends no credentials to any registry`;
    } else if (origin !== null) {
      reason = `the host ${origin} answered ${statusCode} (${code}) for a lookup that started at the registry ${registryOrigin}, and Calavera sends no credentials to any registry or host`;
    }
    const setting =
      typeof fields.setting === "string" && typeof fields.layer === "string"
        ? `${fields.setting} in the ${fields.layer}`
        : "the registry setting";
    return {
      code,
      statusCode,
      reason,
      remedy: `If this registry requires authentication, point ${setting} at a registry that serves Calavera's packages without authentication, then run: ${retryCommand}`,
      ...notes,
    };
  }
  let check = "the network connection and the npm registry settings";
  if (statusCode === 404) {
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
 * @returns {Promise<unknown[]>} Each failure to remove the transaction's staging folder after the
 *   block committed, for `temporaryFolderLeftovers`.
 */
async function commitArtifactCacheBlock(cacheBlock, state, loadFormatter, dryRun) {
  if (!cacheBlock.writesState) return [];
  const stateText = await formatRecordText(
    STATE_PATH,
    { ...state, gitignoreBlocks: cacheBlock.gitignoreBlocks },
    loadFormatter,
  );
  if (dryRun) return [];
  // #1193: the state, the journal, and the staging folder all lie in `.calavera`.
  await refuseLinkedArtifactFolders([TRANSACTION_ROOT]);
  const stagingRoot = resolve(TRANSACTION_ROOT, `${Date.now()}-${process.pid}`);
  const stagedState = join(stagingRoot, "records", "state.json");
  const stagedGitignore = join(stagingRoot, "records", "gitignore");
  const removeStaging = () => removeTemporaryFolder(stagingRoot);
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
  } catch (error) {
    // A commit that failed part way leaves its journal and staging for recovery. Otherwise the
    // staging folder is removed, and a folder that stays is named after the failure that stopped
    // the command, with its remedy (#1136).
    if (!commitStarted || !(await fileExists(TRANSACTION_PATH))) {
      throw errorWithLeftovers(error, await cleanupFailures([removeStaging]));
    }
    throw error;
  }
  // #1136: the block has committed, so a staging folder that stays is reported, not an error.
  return cleanupFailures([removeStaging]);
}

/**
 * @param {ArtifactOptions} options
 * @param {boolean} updating
 * @param {ArtifactRegistry} registry
 * @param {() => Promise<ProjectFormatter>} loadFormatter
 */
async function installArtifacts(options, updating, registry, loadFormatter) {
  const recipe = await readJson(options.config);
  // #1137: validated first, as apply validates it, so the command refuses every recipe apply
  // refuses, with apply's message, before anything is written or resolved. That includes an
  // unknown id or legacy src, which the message names by its position, and a legacy entry that
  // selects an artifact needing wiring or inputs (#1125).
  validateRecipe(recipe);
  assertNoLegacyEntryNeedsWiring(recipe.ai);
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
  const stagedRecipe = Array.isArray(recipe.ai)
    ? {
        ...recipe,
        ai: recipe.ai.filter(
          (/** @type {unknown} */ _item, /** @type {number} */ index) => staged[index],
        ),
      }
    : recipe;
  const stagedSelections = selections.filter((_selection, index) => staged[index]);
  // #1193: a linked folder stops the command before the cache block below writes anything.
  await refuseLinkedArtifactFolders(artifactInstallFolders(stagedRecipe, stagedSelections));
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
  const leftoverFailures = await commitArtifactCacheBlock(
    cacheBlock,
    state,
    loadFormatter,
    options.dryRun,
  );
  const result = await stageArtifactInstall(
    stagedRecipe,
    stagedSelections,
    {
      lockedById,
      advanceIds: updating ? requestedIds : new Set(),
      artifactTag: options.artifactTag,
      dryRun: options.dryRun,
      keptEntries: [],
      loadFormatter,
    },
    registry,
  ).catch((error) => {
    // #1136: a staging folder the cache block left is named after the failure, with its remedy.
    throw errorWithLeftovers(error, leftoverFailures);
  });
  // #1136: the install has committed, or the dry run has finished, here, so a staging folder the
  // command cannot remove is reported with its remedy, as apply reports it (#1033), and the
  // command still finishes.
  leftoverFailures.push(...(await cleanupFailures([result.dispose])));
  const leftoverFolders = temporaryFolderLeftovers(leftoverFailures);
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
    temporaryFolderLeftovers: leftoverFolders,
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
  // A project whose formatter cannot load, or that links a folder the install writes into
  // (#1193), stops the dry run and the install alike, before anything is resolved or staged.
  await loadFormatter();
  await refuseLinkedArtifactFolders(artifactInstallFolders(recipe, selections));
  const stagingRoot = dryRun
    ? await createTemporaryFolder("calavera-artifact-stage-")
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
    // #838: formatted in the dry run as well, so the dry run stops where the install would.
    const stateText = await formatRecordText(
      STATE_PATH,
      {
        ...state,
        // #1139: the order apply writes, so a run that changes nothing leaves the state unchanged.
        aiArtifacts: mergeInstalledAiArtifacts(state.aiArtifacts, applied.artifacts),
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
      // #1136: a folder that stays is named after the failure, with its remedy, as apply does.
      throw errorWithLeftovers(error, await cleanupFailures([dispose]));
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
  return /** @type {Record<string, unknown>} */ (await readJSON(path));
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
 * The project files an artifact transaction may target (#1193). The two callers of
 * `commitArtifactTransaction` write them: `commitArtifactCacheBlock` targets `.gitignore` and the
 * state, and `stageArtifactInstall` the state, the lock, and `.coderabbit.yaml`.
 */
const TRANSACTION_TARGET_FILES = Object.freeze([
  GITIGNORE_PATH,
  STATE_PATH,
  LOCK_PATH,
  CODE_RABBIT_CONFIG_PATH,
]);

/**
 * The project folders an artifact transaction may target paths strictly below, never the folder
 * itself (#1193): `stageArtifactInstall` targets package folders and AI artifact outputs.
 */
const TRANSACTION_TARGET_FOLDERS = Object.freeze([PACKAGE_PATH, ...AI_ARTIFACT_OUTPUT_FOLDERS]);

/**
 * Whether an artifact transaction may target the absolute path `target` in the project at
 * `projectRoot`: one of `TRANSACTION_TARGET_FILES`, or a path strictly below one of
 * `TRANSACTION_TARGET_FOLDERS`. The project root, its parent folders, and the target folders
 * themselves are never targets, and neither is a path with a segment that ends in a space or a
 * dot. Paths are compared with `relative`, as `isPathInside` does, so a path that differs only in
 * letter case on Windows counts as the same path.
 *
 * @param {string} projectRoot
 * @param {string} target
 * @param {Pick<typeof nodePath, "join" | "relative" | "isAbsolute" | "sep">} [pathRules] The
 *   platform's path rules; tests pass `path.win32`.
 */
export function isTransactionTarget(projectRoot, target, pathRules = nodePath) {
  const samePath = (/** @type {string} */ path) => pathRules.relative(path, target) === "";
  // Windows strips a trailing space or dot from each path segment, so such a segment would name
  // another path there; it is refused on every platform, so a journal is read the same way
  // everywhere. No catalog path ends a segment that way.
  const segments = pathRules.relative(projectRoot, target).split(pathRules.sep);
  if (segments.some((segment) => segment.endsWith(" ") || segment.endsWith("."))) return false;
  return (
    TRANSACTION_TARGET_FILES.some((file) => samePath(pathRules.join(projectRoot, file))) ||
    TRANSACTION_TARGET_FOLDERS.some((folder) => {
      const root = pathRules.join(projectRoot, folder);
      return !samePath(root) && isPathInside(root, target, pathRules);
    })
  );
}

/**
 * Ends each message that refuses a journal, because `apply`, every `artifacts` command, and
 * `eject` recover the journal first and stay blocked until it is gone.
 */
const JOURNAL_REFUSAL_REMEDY = `Calavera does not roll this journal back. Restore the files it names by hand if needed, using the backups in ${TRANSACTION_ROOT}, then remove ${TRANSACTION_PATH}.`;

/**
 * Moves each staged path to its target through a journal that
 * `recoverArtifactTransaction` rolls back. Refuses, before anything moves, a
 * transaction root outside `.calavera/.transactions`, and an operation whose
 * staged path is outside the transaction root or missing, whose target is
 * outside the project or not a path a transaction may target, or whose target
 * an earlier operation already names, each with its own message.
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
    if (!isTransactionTarget(projectRoot, target)) {
      throw new Error(
        `Artifact transaction operation ${index} targets ${target}, which is not a path an artifact transaction writes.`,
      );
    }
    const earlier = seenTargets.get(target);
    if (earlier !== undefined) {
      throw new Error(
        `Artifact transaction operations ${earlier} and ${index} both target ${target}.`,
      );
    }
    // Recovery refuses nested targets, and targets that differ only in letter case or Unicode
    // normalization, so a commit that wrote them could never be rolled back.
    for (const [other, otherIndex] of seenTargets) {
      if (pathsOverlap(other, target)) {
        throw new Error(
          `Artifact transaction operations ${otherIndex} and ${index} target ${other} and ${target}, the same path or one inside the other.`,
        );
      }
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

  const linked = await linkedJournalPath(projectRoot, normalizedRoot, journalOperations);
  if (linked?.error) throw linked.error;
  if (linked?.link) throw new Error(linkedFolderRefusal(linked.link));
  // #1174: what each move puts at its target, so the rollback can tell an edit made since. It is
  // read after the link check, so it never reads through a refused link.
  for (const operation of journalOperations) {
    Object.assign(operation, { writtenHash: await writtenFingerprint(operation.staged) });
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
  const { transactionRoot, operations } = await readTransactionJournal();
  await refuseEditedRollbackTargets(resolve("."), operations);
  await rollBackArtifactOperations(resolve("."), operations);
  await rm(TRANSACTION_PATH, { force: true });
  await rm(transactionRoot, { recursive: true, force: true });
}

/** A SHA-256 digest as `writtenFingerprint` writes it: 64 lowercase hexadecimal digits. */
const SHA256_DIGEST = /^[0-9a-f]{64}$/;

/**
 * A SHA-256 digest of everything at `path`, which it never follows when it is a symbolic link:
 * the kind of each entry, its path below `path`, the mode bits of a file or folder, a file's bytes,
 * and a link's target, so an edited, added, removed, retyped, or re-permissioned entry, even an
 * empty folder, gives another digest. The commit records it for each staged path, and the move
 * keeps all of it, so an unchanged target still matches (#1174).
 *
 * The mode bits are `mode & 0o7777`: on POSIX the permission bits and the setuid, setgid, and
 * sticky bits. On Windows, Node reports `0o666`, or `0o444` when the read-only attribute is set,
 * and no execute bit, so there the digest catches a change to the read-only attribute. A link's
 * own mode is left out, because Linux cannot change it and the rollback never reads through it.
 *
 * @param {string} path
 */
export async function writtenFingerprint(path) {
  const hash = createHash("sha256");
  // One JSON line per entry, so each entry's path alone places it in the tree.
  const record = (/** @type {(string | number)[]} */ entry) =>
    hash.update(`${JSON.stringify(entry)}\n`);
  /** @param {string} current @param {string} name */
  const add = async (current, name) => {
    const stats = await lstat(current);
    if (stats.isSymbolicLink()) {
      record(["link", name, await readlink(current)]);
    } else if (stats.isDirectory()) {
      record(["folder", name, stats.mode & 0o7777]);
      for (const child of (await readdir(current)).sort()) {
        await add(join(current, child), name === "" ? child : `${name}/${child}`);
      }
    } else if (stats.isFile()) {
      const bytes = createHash("sha256")
        .update(await readFile(current))
        .digest("hex");
      record(["file", name, stats.mode & 0o7777, bytes]);
    } else {
      record(["other", name]);
    }
  };
  await add(path, "");
  return hash.digest("hex");
}

/**
 * The remedy that ends the message of a rollback that refuses to replace or remove edited paths.
 * Moving a path out of the project keeps its edits, and the rollback then has nothing there to
 * replace or remove, so it can run; deleting the path discards the edits the same way.
 */
const EDITED_ROLLBACK_REMEDY =
  "To keep the edits, move each of these paths out of the project, then run the Calavera command again: the rollback then restores or removes the rest, and you can copy the edits back. To discard the edits, delete each of these paths instead, then run the Calavera command again.";

/**
 * Refuses, before the rollback changes anything, when it would replace or remove a target that is
 * not exactly what the stopped operation wrote there (#1174; brief C8: local edits are preserved).
 * The rollback replaces or removes a target that has a backup or did not exist before; such a
 * target that is gone is fine, and one that exists must match the operation's `writtenHash`. A
 * journal from a Calavera version that did not record `writtenHash` cannot show that a target is
 * unchanged, so every such target that exists stops the rollback, named apart from the edited ones.
 * A target the check cannot read stops it too, with the error code, and the error is the cause.
 * The message names project paths only, never text from a file. A process that edits a target
 * between this check and the rollback's step is not detected.
 *
 * @param {string} projectRoot
 * @param {{ target: string, backup: string, hadTarget: boolean, writtenHash?: string }[]} operations
 */
async function refuseEditedRollbackTargets(projectRoot, operations) {
  const changed = [];
  const unrecorded = [];
  /** @type {{ path: string, error: unknown }[]} */
  const unreadable = [];
  for (const operation of operations) {
    // The same test the rollback's step makes before it replaces or removes the target.
    if (operation.hadTarget && !(await fileExists(operation.backup))) continue;
    const path = relative(projectRoot, operation.target);
    try {
      if (!(await pathExists(operation.target))) continue;
      if (operation.writtenHash === undefined) {
        unrecorded.push(path);
      } else if ((await writtenFingerprint(operation.target)) !== operation.writtenHash) {
        changed.push(path);
      }
    } catch (error) {
      unreadable.push({ path, error });
    }
  }
  const reasons = [];
  if (changed.length > 0) {
    reasons.push(
      `it would replace or remove paths that changed after the stopped operation wrote them: ${changed.join(", ")}`,
    );
  }
  if (unrecorded.length > 0) {
    reasons.push(
      `the journal does not record what the stopped operation wrote, so Calavera cannot tell whether these paths changed since: ${unrecorded.join(", ")}`,
    );
  }
  for (const { path, error } of unreadable) {
    const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "an error";
    reasons.push(
      `reading ${path} to compare it with what the stopped operation wrote failed with ${code}`,
    );
  }
  if (reasons.length === 0) return;
  const errors = unreadable.map(({ error }) => error);
  throw new Error(
    `The artifact transaction rollback stopped before changing anything, because ${reasons.join(", and ")}. ${EDITED_ROLLBACK_REMEDY}`,
    errors.length === 0
      ? undefined
      : { cause: errors.length === 1 ? errors[0] : new AggregateError(errors) },
  );
}

/**
 * Whether anything, a symbolic link included, is at `path`. Unlike `fileExists`, a link whose
 * target is missing counts, because the rollback would remove it.
 *
 * @param {string} path
 */
async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * Rolls back the operations of a journal that `readTransactionJournal` accepted, last first: each
 * target with a backup gets its backup back, and each target that did not exist before is
 * removed. Before each step, it stops when a folder above the target is a symbolic link, with a
 * message that says which operations it already rolled back (#1193).
 *
 * @param {string} projectRoot
 * @param {{ target: string, backup: string, hadTarget: boolean }[]} operations
 */
export async function rollBackArtifactOperations(projectRoot, operations) {
  for (const [index, operation] of [...operations.entries()].reverse()) {
    // An earlier step may have moved a backup that is a symbolic link into place, for example on
    // a file system that treats two spellings the journal checks cannot tell apart as one name,
    // so the folders are checked again before each step.
    let link;
    try {
      link = await linkedFolder(projectRoot, dirname(operation.target));
    } catch (error) {
      throw new Error(
        rollbackStoppedMessage(
          index,
          operations.length,
          uncheckedFolders(projectRoot, operation.target, error),
        ),
        { cause: error },
      );
    }
    if (link !== null) {
      throw new Error(
        rollbackStoppedMessage(
          index,
          operations.length,
          `${relative(projectRoot, operation.target)} lies below the symbolic link ${relative(projectRoot, link)}`,
        ),
      );
    }
    // A step that fails throws its own error unchanged: callers report it as the rollback failure
    // and tell the person to retry the rollback.
    if (await fileExists(operation.backup)) {
      await rm(operation.target, { recursive: true, force: true });
      await mkdir(dirname(operation.target), { recursive: true });
      await rename(operation.backup, operation.target);
    } else if (!operation.hadTarget) {
      await rm(operation.target, { recursive: true, force: true });
    }
  }
}

/**
 * The message for a rollback that stopped before operation `index` of `count`, last first, so
 * operations after `index` were rolled back and operations up to `index` were not.
 *
 * @param {number} index
 * @param {number} count
 * @param {string} reason
 */
function rollbackStoppedMessage(index, count, reason) {
  const last = count - 1;
  let done = "It rolled back no operation yet.";
  if (index === last - 1) done = `It already rolled back operation ${last}.`;
  if (index < last - 1) done = `It already rolled back operations ${index + 1} to ${last}.`;
  return `The artifact transaction rollback stopped before operation ${index}, because ${reason}. ${done} Calavera does not roll the rest of this journal back. A symbolic link on the way may be one the rollback moved into place from a backup, so replace every link on the paths of the targets of operations 0 to ${index} with a real folder before you restore those files by hand from the backups in ${TRANSACTION_ROOT}, then remove ${TRANSACTION_PATH}.`;
}

/**
 * Reads the pending artifact transaction's journal without writing, and checks every path it
 * names: staged files and backups stay in the transaction root, and each target is a path a
 * transaction may target (`isTransactionTarget`), so never the project root, a parent folder of
 * it, or a file outside the paths a transaction writes (#1193). No folder between the project root
 * and the transaction root, a backup, or a target may be a symbolic link, because the rollback
 * would then remove or move files outside the project, and no target may equal or lie inside
 * another. Throws on a journal that fails a check; a message names operations by their index and
 * paths by their project path, and quotes nothing else from the journal. The checks run before the
 * rollback moves anything, and `rollBackArtifactOperations` checks for a symbolic link again before
 * each step; a process that replaces a folder with a link between that check and the step's `rm`
 * or `rename` is not detected.
 */
async function readTransactionJournal() {
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
  const operations = journal.operations.map((operation, index) => {
    if (
      !operation ||
      typeof operation !== "object" ||
      typeof operation.staged !== "string" ||
      typeof operation.target !== "string" ||
      typeof operation.backup !== "string" ||
      typeof operation.hadTarget !== "boolean" ||
      ("writtenHash" in operation &&
        (typeof operation.writtenHash !== "string" || !SHA256_DIGEST.test(operation.writtenHash)))
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
    if (!isTransactionTarget(projectRoot, target)) {
      const path = relative(projectRoot, target);
      throw new Error(
        `Artifact transaction journal operation ${index} targets ${path === "" ? "the project root" : path}, which is not a path an artifact transaction writes. ${JOURNAL_REFUSAL_REMEDY}`,
      );
    }
    /** @type {string | undefined} */
    const writtenHash = operation.writtenHash;
    return { staged, target, backup, hadTarget: operation.hadTarget, writtenHash };
  });
  // A target equal to or inside another one is refused: the rollback could otherwise move a
  // backup, which may be a symbolic link, into a folder that a later step removes files through.
  for (const [index, { target }] of operations.entries()) {
    for (const [earlier, other] of operations.slice(0, index).entries()) {
      if (pathsOverlap(other.target, target)) {
        throw new Error(
          `Artifact transaction journal operations ${earlier} and ${index} target ${relative(projectRoot, other.target)} and ${relative(projectRoot, target)}, the same path or one inside the other. ${JOURNAL_REFUSAL_REMEDY}`,
        );
      }
    }
  }
  const linked = await linkedJournalPath(projectRoot, transactionRoot, operations);
  if (linked?.error) {
    const subject =
      linked.index === null
        ? "the artifact transaction root"
        : `artifact transaction journal operation ${linked.index}`;
    throw new Error(
      `Calavera cannot check ${subject}, because ${uncheckedFolders(projectRoot, linked.path, linked.error)}. ${JOURNAL_REFUSAL_REMEDY}`,
      { cause: linked.error },
    );
  }
  if (linked?.link) {
    throw new Error(journalLinkRefusal(projectRoot, linked.path, linked.link));
  }
  return { transactionRoot, operations };
}

/**
 * Why the folders above `path` could not be checked for a symbolic link, naming the error code
 * only, so no text from the file system or the journal beyond the path reaches the message.
 *
 * @param {string} projectRoot
 * @param {string} path
 * @param {unknown} error
 */
function uncheckedFolders(projectRoot, path, error) {
  const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "an error";
  return `checking the folders above ${relative(projectRoot, path)} for a symbolic link failed with ${code}`;
}

/**
 * The message that refuses a journal whose `path` lies below the symbolic link `link`.
 *
 * @param {string} projectRoot
 * @param {string} path
 * @param {string} link
 */
function journalLinkRefusal(projectRoot, path, link) {
  return `Artifact transaction journal path ${relative(projectRoot, path)} lies below the symbolic link ${relative(projectRoot, link)}. ${JOURNAL_REFUSAL_REMEDY}`;
}

/**
 * Whether `a` and `b` are the same path or one lies inside the other on a file system that
 * ignores letter case and Unicode normalization, such as the default APFS on macOS. Both paths
 * are compared folded on every platform, so a journal is refused the same way wherever it is
 * read (#1193): decomposed, lower-cased, upper-cased, and lower-cased again, then composed. That
 * merges the case pairs APFS merges and lower-casing alone misses, such as `ß`, `ẞ`, and `ss`,
 * final and other sigma, and ligatures. It also merges dotless `ı` with `i`, which APFS keeps
 * apart, so such a pair is refused although it would be safe. A fold can still miss aliases, such
 * as Windows short names, so the rollback also checks for a symbolic link before each step.
 *
 * @param {string} a
 * @param {string} b
 */
function pathsOverlap(a, b) {
  const fold = (/** @type {string} */ path) =>
    path.normalize("NFD").toLowerCase().toUpperCase().toLowerCase().normalize("NFC");
  const foldedA = fold(a);
  const foldedB = fold(b);
  return isPathInside(foldedA, foldedB) || isPathInside(foldedB, foldedA);
}

/**
 * The first path of an artifact transaction that lies below a symbolic link, with that link, or
 * whose folders cannot be checked, with that error, together with the index of its operation
 * (null for the transaction root), or null when every path is fine. The paths are the transaction root, each target, and each backup; the path
 * itself is not checked, because removing or replacing a symbolic link changes only the link. The
 * commit and the rollback both call it, so the commit never writes a journal the rollback refuses
 * (#1193, owner decision of 2026-11-23).
 *
 * @param {string} projectRoot
 * @param {string} transactionRoot
 * @param {{ target: string, backup: string }[]} operations
 * @returns {Promise<{ path: string, index: number | null, link: string | null, error: unknown } | null>}
 */
async function linkedJournalPath(projectRoot, transactionRoot, operations) {
  for (const { path, index } of [
    { path: transactionRoot, index: null },
    ...operations.flatMap(({ target, backup }, index) => [
      { path: target, index },
      { path: backup, index },
    ]),
  ]) {
    let link;
    try {
      link = await linkedFolder(projectRoot, dirname(path));
    } catch (error) {
      return { path, index, link: null, error };
    }
    if (link !== null) return { path, index, link, error: null };
  }
  return null;
}

/**
 * The message that refuses to write artifacts through the symbolic link at the absolute path
 * `link` (#1193, owner decision of 2026-11-23).
 *
 * @param {string} link
 */
function linkedFolderRefusal(link) {
  const path = relative(resolve("."), link);
  return `Calavera does not write artifacts through the symbolic link ${path}. Replace ${path} with a real folder, then run the command again.`;
}

/**
 * Refuses, before an install, an update, or a cache block writes anything, when a folder that an
 * artifact transaction stages into or targets below is a symbolic link or lies below one.
 * `commitArtifactTransaction` refuses the same links again before it moves anything, so this check
 * only makes the command stop before it writes the cache block, the registry cache, or the staging
 * folder. The registry cache folder itself is not checked, because no transaction targets it. A
 * targeted update checks the outputs of every selection it stages again, including those whose
 * files do not change.
 *
 * @param {string[]} folders Project paths of the folders the command writes into.
 */
async function refuseLinkedArtifactFolders(folders) {
  const projectRoot = resolve(".");
  for (const folder of folders) {
    const link = await linkedFolder(projectRoot, resolve(folder));
    if (link !== null) throw new Error(linkedFolderRefusal(link));
  }
}

/**
 * The project folders an artifact transaction that installs the AI items of `recipe` stages into or
 * targets below: the transaction folder, each selection's package folder, and the folder of each
 * AI artifact output.
 *
 * @param {{ ai?: unknown }} recipe
 * @param {{ id: string }[]} selections
 */
function artifactInstallFolders(recipe, selections) {
  return [
    TRANSACTION_ROOT,
    ...selections.map(({ id }) => join(PACKAGE_PATH, id)),
    ...resolveAiArtifacts(recipe).flatMap((artifact) =>
      aiArtifactOutputPaths(artifact).map(dirname),
    ),
  ];
}

/**
 * The first folder from below `projectRoot` down to `folder`, both included, that is a symbolic
 * link, or null when none is. Stops at the first folder that does not exist, because nothing below
 * it exists either. Throws when it cannot check a folder, for example because a file stands where
 * a folder would be or a folder cannot be read, so the caller stops before it changes anything.
 *
 * @param {string} projectRoot
 * @param {string} folder An absolute path inside `projectRoot`.
 * @returns {Promise<string | null>}
 */
async function linkedFolder(projectRoot, folder) {
  let current = projectRoot;
  for (const name of relative(projectRoot, folder).split(sep).filter(Boolean)) {
    current = join(current, name);
    let stats;
    try {
      stats = await lstat(current);
    } catch (error) {
      if (/** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") return null;
      throw error;
    }
    if (stats.isSymbolicLink()) return current;
  }
  return null;
}
