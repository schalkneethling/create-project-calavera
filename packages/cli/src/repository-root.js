// @ts-check
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { integrationCatalog } from "./catalog.js";
import { projectLocalCommandCatalog } from "./recipe.js";

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
    if (existsSync(join(current, ".git"))) {
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
  const selectedIds = new Set(integrations.map(({ id }) => id));
  const rootOnly = integrationCatalog.find(
    (integration) => integration.appliesAt === "repository-root" && selectedIds.has(integration.id),
  );

  if (!rootOnly) {
    return;
  }

  const project = resolve(projectDirectory);
  const root = findRepositoryRoot(project) ?? project;

  if (root === project) {
    return;
  }

  const command = projectLocalCommandCatalog[packageManager].applyDryRun;
  throw new Error(
    `${rootOnly.id} applies at the repository root, not in a workspace member. This project is ${project}; the repository root is ${root}. Run Calavera there (cd ${root} && ${command}), or remove ${rootOnly.id} from this recipe.`,
  );
}
