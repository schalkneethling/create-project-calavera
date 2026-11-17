// @ts-check
import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { integrationCatalog } from "./catalog.js";
import { projectLocalCommandCatalog } from "./recipe.js";

/**
 * Whether `directory` contains a `.git` entry. Only a missing entry counts as
 * absence; any other file system error (permissions, I/O) propagates, so a
 * repository root is never mistaken for a plain directory silently.
 *
 * @param {string} directory
 */
function hasGitEntry(directory) {
  try {
    statSync(join(directory, ".git"));
    return true;
  } catch (error) {
    const { code } = /** @type {NodeJS.ErrnoException} */ (error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return false;
    }
    throw error;
  }
}

/**
 * Nearest directory at or above `directory` that contains a `.git` entry: a
 * directory in a regular clone, a file in a git worktree. Reads the file
 * system only; it never spawns git.
 *
 * @param {string} directory
 * @returns {string | undefined} undefined when no ancestor is a git repository
 */
export function findRepositoryRoot(directory) {
  let current = resolve(directory);

  while (true) {
    if (hasGitEntry(current)) {
      return current;
    }

    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

/**
 * Hard stop for a root-only integration (catalog `appliesAt: "repository-root"`)
 * selected in a project that is not the repository root, raised before any
 * file is planned or written. A project that is not yet a git repository
 * counts as its own root.
 *
 * @param {{ id: string }[]} integrations resolved recipe integrations
 * @param {string} projectDirectory
 * @param {keyof typeof projectLocalCommandCatalog} packageManager
 */
export function assertRootOnlyIntegrationsAtRepositoryRoot(
  integrations,
  projectDirectory,
  packageManager,
) {
  const message = rootOnlyIntegrationRefusal(integrations, projectDirectory, packageManager);

  if (message !== undefined) {
    throw new Error(message);
  }
}

/**
 * The message apply's root-only hard stop raises, or undefined when apply would not stop. doctor
 * reports the same message, so the rule and its remedy live in one place (#997).
 *
 * @param {{ id: string }[]} integrations resolved recipe integrations
 * @param {string} projectDirectory
 * @param {keyof typeof projectLocalCommandCatalog} packageManager
 * @returns {string | undefined}
 */
export function rootOnlyIntegrationRefusal(integrations, projectDirectory, packageManager) {
  const selectedIds = new Set(integrations.map(({ id }) => id));
  const rootOnly = integrationCatalog.find(
    (integration) => integration.appliesAt === "repository-root" && selectedIds.has(integration.id),
  );

  if (!rootOnly) {
    return undefined;
  }

  return repositoryRootRefusal(rootOnly.id, "", projectDirectory, packageManager);
}

/**
 * Hard stop for an artifact that writes Git hooks, selected in a project that is not the repository
 * root. Git runs every hook from the repository root, so a hook line that runs a script by its
 * path inside a workspace member would fail on every commit. Raised before any file is planned or
 * written; a project that is not yet a git repository counts as its own root.
 *
 * @param {string[]} artifactIds The selected artifacts that write Git hooks.
 * @param {string} projectDirectory
 * @param {keyof typeof projectLocalCommandCatalog} packageManager
 */
export function assertGitHookArtifactsAtRepositoryRoot(
  artifactIds,
  projectDirectory,
  packageManager,
) {
  const [id] = artifactIds;
  if (id === undefined) {
    return;
  }

  const message = repositoryRootRefusal(
    id,
    " It writes Git hooks, and Git runs every hook from the repository root, so its hook lines would not find their scripts from here.",
    projectDirectory,
    packageManager,
  );

  if (message !== undefined) {
    throw new Error(message);
  }
}

/**
 * The refusal for `id` when `projectDirectory` is not the repository root, or undefined at the
 * root.
 *
 * @param {string} id
 * @param {string} why An extra sentence after the first, or an empty string.
 * @param {string} projectDirectory
 * @param {keyof typeof projectLocalCommandCatalog} packageManager
 * @returns {string | undefined}
 */
function repositoryRootRefusal(id, why, projectDirectory, packageManager) {
  const project = resolve(projectDirectory);
  const root = findRepositoryRoot(project) ?? project;

  if (root === project) {
    return undefined;
  }

  const command = projectLocalCommandCatalog[packageManager].applyDryRun;
  return (
    `${id} applies at the repository root, not in a workspace member.${why} This project is ${project}; the repository root is ${root}. Apply a recipe that selects ${id} from the repository root (cd ${root} && ${command}, adding --config <path> when the recipe is saved elsewhere), or remove ${id} from this recipe.`
  );
}
