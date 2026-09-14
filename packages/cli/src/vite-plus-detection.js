// @ts-check
import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative } from "node:path";

import { parse as parseYAML } from "yaml";

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
 * Climbs from a directory to the filesystem root, yielding every level
 * including the starting one.
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
 * The one upward walk both callers share. It climbs from a directory to the
 * filesystem root, reads each `package.json` once, and yields only the
 * manifests it could read and parse, skipping the rest exactly as `vp` skips
 * them.
 *
 * @param {string} directory
 * @returns {AsyncGenerator<{ manifestPath: string, manifest: Record<string, unknown> }>}
 */
async function* readableManifests(directory) {
  for (const current of directoryAndAncestors(directory)) {
    const manifestPath = join(current, "package.json");
    const manifest = await readManifest(manifestPath);

    if (manifest) {
      yield { manifestPath, manifest };
    }
  }
}

/**
 * Walks upward from the inspected directory looking for the nearest manifest
 * that declares `vite-plus`.
 *
 * @param {string} projectDirectory
 * @returns {Promise<{ manifestPath: string, manifest: Record<string, unknown> } | undefined>}
 */
async function findDeclaringManifest(projectDirectory) {
  for await (const entry of readableManifests(projectDirectory)) {
    if (declaresVitePlus(entry.manifest)) {
      return entry;
    }
  }

  return undefined;
}

/**
 * Finds the nearest readable manifest strictly above the inspected directory,
 * and reports whether it, or anything above it, declares `vite-plus`. One
 * climb answers both questions: the first manifest yielded is the nearest one,
 * and the walk continues only to learn whether any level declares the
 * dependency.
 *
 * @param {string} projectDirectory
 * @returns {Promise<{ manifestPath: string, status: "managed" | "unmanaged" } | undefined>}
 */
async function findAncestorVerdict(projectDirectory) {
  const parent = dirname(projectDirectory);
  if (parent === projectDirectory) {
    return undefined;
  }

  /** @type {string | undefined} */
  let nearestManifestPath;

  for await (const entry of readableManifests(parent)) {
    nearestManifestPath ??= entry.manifestPath;

    if (declaresVitePlus(entry.manifest)) {
      return { manifestPath: nearestManifestPath, status: "managed" };
    }
  }

  if (!nearestManifestPath) {
    return undefined;
  }

  return { manifestPath: nearestManifestPath, status: "unmanaged" };
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
 * Reads `catalog.vite` from a package manager companion file. A file that
 * cannot be parsed as YAML carries no pin this function can report, so it
 * reads as no pin rather than as a failure.
 *
 * @param {string} source
 */
function catalogPinsVitePlusCore(source) {
  let document;

  try {
    document = parseYAML(source);
  } catch {
    return false;
  }

  return isVitePlusCorePin(asRecord(asRecord(document).catalog).vite);
}

/**
 * The pin signal is one signal with four locations, so a project reads the
 * same whichever of pnpm, npm, Yarn, or Bun it uses: `overrides.vite` or
 * `resolutions.vite` in the manifest that stopped the walk, or `catalog.vite`
 * in `pnpm-workspace.yaml` or `.yarnrc.yml` next to that manifest.
 *
 * @param {{ manifest: Record<string, unknown>, directory: string }} pin
 */
async function hasVitePlusCorePin({ manifest, directory }) {
  if (
    isVitePlusCorePin(asRecord(manifest.overrides).vite) ||
    isVitePlusCorePin(asRecord(manifest.resolutions).vite)
  ) {
    return true;
  }

  for (const fileName of catalogFileNames) {
    let source;

    try {
      source = await readFile(join(directory, fileName), "utf8");
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
 * Collects the corroborating signals, in the precedence order ADR-0001
 * defines, from whatever is readable. The configuration signal needs only the
 * inspected directory, so it is the one signal that can be computed when the
 * inspected directory has no readable manifest of its own; the pin and the
 * script signals both read that manifest, so in the `"unknown"` case they are
 * skipped and both arguments are absent.
 *
 * @param {string} projectDirectory
 * @param {{
 *   ownManifest?: Record<string, unknown>,
 *   pin?: { manifest: Record<string, unknown>, directory: string }
 * }} readable
 * @returns {Promise<VitePlusDetection["corroborating"]>}
 */
async function collectCorroborating(projectDirectory, { ownManifest, pin } = {}) {
  /** @type {VitePlusDetection["corroborating"]} */
  const corroborating = [];

  if (await hasVitePlusConfigImport(projectDirectory)) {
    corroborating.push("vite-plus-config-import");
  }

  if (pin && (await hasVitePlusCorePin(pin))) {
    corroborating.push("vite-plus-core-pin");
  }

  if (ownManifest && hasVpScripts(ownManifest)) {
    corroborating.push("vp-scripts");
  }

  return corroborating;
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
  const corroborating = await collectCorroborating(projectDirectory, {
    ownManifest,
    pin: declaring
      ? { manifest: declaring.manifest, directory: dirname(declaring.manifestPath) }
      : { manifest: ownManifest, directory: projectDirectory },
  });

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
 * `vp` climbs, and what it finds is reported in `ancestor`.
 *
 * @param {string} projectDirectory
 * @returns {Promise<VitePlusDetection>}
 */
async function buildUnknownDetection(projectDirectory) {
  const corroborating = await collectCorroborating(projectDirectory, {});
  const ancestor = await findAncestorVerdict(projectDirectory);

  if (!ancestor) {
    return { status: "unknown", corroborating };
  }

  return { status: "unknown", corroborating, ancestor };
}
