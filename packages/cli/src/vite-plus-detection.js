// @ts-check
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

/**
 * @typedef {{
 *   status: "managed" | "unmanaged" | "unknown",
 *   signal?: "vite-plus-dependency",
 *   manifestPath?: string,
 *   corroborating: Array<"vite-plus-config-import" | "vite-plus-core-pin" | "vp-scripts">,
 *   ancestor?: { manifestPath: string, status: "managed" | "unmanaged" }
 * }} VitePlusDetection
 */

/**
 * Configuration file names read from the inspected directory only. Ancestor
 * directories are never searched, so a workspace member without a
 * configuration file of its own records no configuration signal.
 */
export const viteConfigFileNames = Object.freeze([
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.cjs",
  "vite.config.ts",
  "vite.config.mts",
  "vite.config.cts",
]);

/** Corroborating finding kinds, in the precedence order ADR-0001 defines. */
export const corroboratingKinds = Object.freeze([
  "vite-plus-config-import",
  "vite-plus-core-pin",
  "vp-scripts",
]);

const catalogFileNames = Object.freeze(["pnpm-workspace.yaml", ".yarnrc.yml"]);
const vitePlusCorePinPrefix = "npm:@voidzero-dev/vite-plus-core@";
const scriptSeparators = /&&|\|\||;|\|/;

/**
 * Reads and parses a `package.json`. Missing files, unreadable files, and
 * unparseable files are all reported the same way, as `vp` itself reports
 * them: by returning nothing.
 *
 * @param {string} manifestPath
 * @returns {Promise<Record<string, unknown> | undefined>}
 */
async function readManifest(manifestPath) {
  let contents;

  try {
    contents = await readFile(manifestPath, "utf8");
  } catch {
    return undefined;
  }

  try {
    const parsed = JSON.parse(contents);
    return parsed && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** @param {unknown} value */
function asRecord(value) {
  return value && typeof value === "object" ? /** @type {Record<string, unknown>} */ (value) : {};
}

/**
 * The primary signal. Only `dependencies` and `devDependencies` count, and the
 * declared value is ignored, so a version range, a `catalog:` reference, and a
 * `workspace:` protocol all match.
 *
 * @param {Record<string, unknown>} manifest
 */
function declaresVitePlus(manifest) {
  return (
    Object.hasOwn(asRecord(manifest.dependencies), "vite-plus") ||
    Object.hasOwn(asRecord(manifest.devDependencies), "vite-plus")
  );
}

/**
 * Climbs from a directory to the filesystem root, yielding the directory of
 * every level including the starting one.
 *
 * @param {string} directory
 */
function* directoryAndAncestors(directory) {
  let current = directory;

  while (true) {
    yield current;

    const parent = dirname(current);
    if (parent === current) {
      return;
    }

    current = parent;
  }
}

/**
 * Walks upward from the inspected directory looking for the nearest manifest
 * that declares `vite-plus`, skipping manifests that cannot be read or parsed.
 *
 * @param {string} projectDirectory
 * @returns {Promise<{ manifestPath: string, manifest: Record<string, unknown> } | undefined>}
 */
async function findDeclaringManifest(projectDirectory) {
  for (const directory of directoryAndAncestors(projectDirectory)) {
    const manifestPath = join(directory, "package.json");
    const manifest = await readManifest(manifestPath);

    if (manifest && declaresVitePlus(manifest)) {
      return { manifestPath, manifest };
    }
  }

  return undefined;
}

/**
 * Finds the nearest readable manifest strictly above the inspected directory,
 * and reports whether it, or anything above it, declares `vite-plus`.
 *
 * @param {string} projectDirectory
 * @returns {Promise<{ manifestPath: string, status: "managed" | "unmanaged" } | undefined>}
 */
async function findAncestorVerdict(projectDirectory) {
  const parent = dirname(projectDirectory);
  if (parent === projectDirectory) {
    return undefined;
  }

  for (const directory of directoryAndAncestors(parent)) {
    const manifestPath = join(directory, "package.json");
    const manifest = await readManifest(manifestPath);

    if (!manifest) {
      continue;
    }

    const declaring = declaresVitePlus(manifest)
      ? { manifestPath }
      : await findDeclaringManifest(directory);

    return { manifestPath, status: declaring ? "managed" : "unmanaged" };
  }

  return undefined;
}

/**
 * Textual search for the `"vite-plus"` import specifier in a configuration
 * file belonging to the inspected directory. A search is enough because the
 * signal corroborates a verdict and never decides one, and the quoted
 * specifier cannot be confused with `"vite"`.
 *
 * @param {string} projectDirectory
 */
async function hasVitePlusConfigImport(projectDirectory) {
  for (const fileName of viteConfigFileNames) {
    let source;

    try {
      source = await readFile(join(projectDirectory, fileName), "utf8");
    } catch {
      continue;
    }

    if (source.includes('"vite-plus"') || source.includes("'vite-plus'")) {
      return true;
    }
  }

  return false;
}

/** @param {unknown} value */
function isVitePlusCorePin(value) {
  return typeof value === "string" && value.startsWith(vitePlusCorePinPrefix);
}

/**
 * Line-oriented search for a `catalog.vite` pin in a package manager
 * companion file. A YAML parser is not needed to read one pin, so none is
 * added as a dependency.
 *
 * @param {string} source
 */
function catalogPinsVitePlusCore(source) {
  let inCatalog = false;

  for (const line of source.split("\n")) {
    if (!line.trim() || line.trimStart().startsWith("#")) {
      continue;
    }

    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      inCatalog = line.trim() === "catalog:";
      continue;
    }

    if (!inCatalog) {
      continue;
    }

    const match = /^\s+vite:\s*(\S+)\s*$/.exec(line);
    if (match && isVitePlusCorePin(match[1].replaceAll('"', "").replaceAll("'", ""))) {
      return true;
    }
  }

  return false;
}

/**
 * The pin signal is one signal with four locations, so a project reads the
 * same whichever of pnpm, npm, Yarn, or Bun it uses: `overrides.vite` or
 * `resolutions.vite` in the manifest that stopped the walk, or `catalog.vite`
 * in `pnpm-workspace.yaml` or `.yarnrc.yml` next to that manifest.
 *
 * @param {Record<string, unknown>} manifest
 * @param {string} manifestDirectory
 */
async function hasVitePlusCorePin(manifest, manifestDirectory) {
  if (
    isVitePlusCorePin(asRecord(manifest.overrides).vite) ||
    isVitePlusCorePin(asRecord(manifest.resolutions).vite)
  ) {
    return true;
  }

  for (const fileName of catalogFileNames) {
    let source;

    try {
      source = await readFile(join(manifestDirectory, fileName), "utf8");
    } catch {
      continue;
    }

    if (catalogPinsVitePlusCore(source)) {
      return true;
    }
  }

  return false;
}

/**
 * True when a command invokes `vp` as a bare command word, meaning at the
 * start of the script or directly after a `&&`, `||`, `;`, or pipe.
 *
 * @param {string} script
 */
function invokesVp(script) {
  return script
    .split(scriptSeparators)
    .some((segment) => segment.trim() === "vp" || segment.trimStart().startsWith("vp "));
}

/** @param {Record<string, unknown>} manifest */
function hasVpScripts(manifest) {
  return Object.values(asRecord(manifest.scripts)).some(
    (script) => typeof script === "string" && invokesVp(script),
  );
}

/**
 * Formats a matching manifest path: relative to the inspected directory when
 * it lies inside it, absolute otherwise, so that a match from an ancestor
 * above the project is visible rather than implied.
 *
 * @param {string} projectDirectory
 * @param {string} manifestPath
 */
function formatManifestPath(projectDirectory, manifestPath) {
  const relativePath = relative(projectDirectory, manifestPath);

  if (!relativePath || relativePath.startsWith("..") || isAbsolute(relativePath)) {
    return manifestPath;
  }

  return relativePath;
}

/**
 * Detects whether a directory is a `vp`-managed project, as decided by
 * ADR-0001. The only input is an absolute project directory path. Detection
 * reads the local filesystem only: no network call, no child process, no
 * `node_modules` resolution, and no global toolchain lookup.
 *
 * @param {string} projectDirectory an absolute path
 * @returns {Promise<VitePlusDetection>}
 */
export async function detectVitePlus(projectDirectory) {
  const ownManifest = await readManifest(join(projectDirectory, "package.json"));

  if (!ownManifest) {
    return buildUnknownDetection(projectDirectory);
  }

  const declaring = await findDeclaringManifest(projectDirectory);
  const pinManifest = declaring ? declaring.manifest : ownManifest;
  const pinDirectory = declaring ? dirname(declaring.manifestPath) : projectDirectory;

  /** @type {VitePlusDetection["corroborating"]} */
  const corroborating = [];

  if (await hasVitePlusConfigImport(projectDirectory)) {
    corroborating.push("vite-plus-config-import");
  }

  if (await hasVitePlusCorePin(pinManifest, pinDirectory)) {
    corroborating.push("vite-plus-core-pin");
  }

  if (hasVpScripts(ownManifest)) {
    corroborating.push("vp-scripts");
  }

  if (!declaring) {
    return { status: "unmanaged", corroborating };
  }

  return {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: formatManifestPath(projectDirectory, declaring.manifestPath),
    corroborating,
  };
}

/**
 * A directory whose own manifest is missing or unparseable is never
 * `"managed"`, whatever its ancestors declare. The walk still runs, exactly as
 * `vp` climbs, and what it finds is reported in `ancestor`. The pin and script
 * signals are skipped because both read the inspected directory's own
 * manifest, which is the file that could not be read.
 *
 * @param {string} projectDirectory
 * @returns {Promise<VitePlusDetection>}
 */
async function buildUnknownDetection(projectDirectory) {
  /** @type {VitePlusDetection["corroborating"]} */
  const corroborating = [];

  if (await hasVitePlusConfigImport(projectDirectory)) {
    corroborating.push("vite-plus-config-import");
  }

  const ancestor = await findAncestorVerdict(projectDirectory);

  if (!ancestor) {
    return { status: "unknown", corroborating };
  }

  return { status: "unknown", corroborating, ancestor };
}
