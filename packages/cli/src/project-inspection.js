import { REPOSITORY_CONTROLS_SCRIPT_PATH } from "./github-repository-controls-options.js";
import { HTML_VALIDATE_IGNORE_PATH } from "./ignore-lines.js";

// html-validate exits 1 when no file matches, so lint:html runs it through
// this managed wrapper, which passes when there is nothing to check (#644).
export const HTML_VALIDATE_WRAPPER_PATH = "scripts/lint-html.mjs";

export const packageManagerLockfiles = Object.freeze({
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml", "shrinkwrap.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
});

export const STRYKER_CONFIG_PATH = "stryker.config.json";

/**
 * The one declaration of the files Calavera writes and tracks for each integration (#458). Apply
 * writes them in this order; inspection and clean plan the same files through apply's planner, and
 * doctor checks that they exist.
 *
 * `existingConfigFiles` lists the paths inspection reports as an existing configuration when they
 * differ from the files Calavera writes.
 *
 * @type {readonly { integration: string, files: { path: string }[], existingConfigFiles?: string[] }[]}
 */
export const managedFileDeclarations = Object.freeze([
  { integration: "editorconfig", files: [{ path: ".editorconfig" }] },
  { integration: "stylelint", files: [{ path: ".stylelintrc.json" }] },
  {
    integration: "html-validate",
    files: [
      { path: ".htmlvalidate.json" },
      { path: HTML_VALIDATE_IGNORE_PATH },
      { path: HTML_VALIDATE_WRAPPER_PATH },
    ],
  },
  { integration: "react-doctor", files: [{ path: "react-doctor.config.json" }] },
  { integration: "knip", files: [{ path: "knip.json" }] },
  {
    integration: "stryker",
    files: [{ path: STRYKER_CONFIG_PATH }],
    // Every name Stryker 10.1.1 reads (SUPPORTED_CONFIG_FILE_NAMES), in the order it tries them, so
    // a config of the person's own, which Stryker would read before stryker.config.json, is reported.
    existingConfigFiles: ["", "."].flatMap((prefix) =>
      [".conf", ".config"].flatMap((suffix) =>
        ["json", "js", "mjs", "cjs"].map((extension) => `${prefix}stryker${suffix}.${extension}`),
      ),
    ),
  },
  {
    integration: "github-repository-controls",
    files: [
      { path: ".github/repository-controls.json" },
      { path: ".github/dependabot.yml" },
      { path: REPOSITORY_CONTROLS_SCRIPT_PATH },
      { path: "docs/repository-controls.md" },
    ],
  },
]);

/**
 * The managed files of the selected integrations, in the order apply writes them, each with the
 * integration that declares it.
 *
 * @param {Iterable<string>} integrationIds
 */
export function declaredManagedFiles(integrationIds) {
  const selected = new Set(integrationIds);
  return managedFileDeclarations
    .filter(({ integration }) => selected.has(integration))
    .flatMap(({ integration, files }) => files.map(({ path }) => ({ integration, path })));
}

// Inspection lists each integration's existing configs in the order apply writes the integrations
// (#926). Within an integration, `existingConfigFiles` keeps its own order.
export const integrationConfigFiles = Object.freeze(
  Object.fromEntries(
    managedFileDeclarations.map(({ integration, files, existingConfigFiles }) => [
      integration,
      existingConfigFiles ?? files.map(({ path }) => path),
    ]),
  ),
);

export const projectInspectionFiles = Object.freeze([
  "package.json",
  "calavera.config.json",
  ...Object.values(packageManagerLockfiles).flat(),
  ...Object.values(integrationConfigFiles).flat(),
  "vite.config.js",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs",
  "astro.config.mjs",
  "svelte.config.js",
]);
