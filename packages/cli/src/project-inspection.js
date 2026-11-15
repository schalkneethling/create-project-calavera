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
 * Each file entry takes `checkedByDoctor: false` when the doctor command does not check it.
 * `existingConfigFiles` lists the paths inspection reports as an existing configuration when they
 * differ from the files Calavera writes.
 *
 * @type {readonly { integration: string, files: { path: string, checkedByDoctor?: false }[], existingConfigFiles?: string[] }[]}
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
    // Doctor has never checked these files, unlike every other managed file (#925).
    files: [
      { path: ".github/repository-controls.json", checkedByDoctor: false },
      { path: ".github/dependabot.yml", checkedByDoctor: false },
      { path: REPOSITORY_CONTROLS_SCRIPT_PATH, checkedByDoctor: false },
      { path: "docs/repository-controls.md", checkedByDoctor: false },
    ],
  },
]);

/**
 * The managed files of the selected integrations, in the order apply writes them.
 *
 * @param {Iterable<string>} integrationIds
 */
export function declaredManagedFiles(integrationIds) {
  const selected = new Set(integrationIds);
  return managedFileDeclarations
    .filter(({ integration }) => selected.has(integration))
    .flatMap(({ files }) => files);
}

// The order inspection has always listed existing configs in, which differs from the order apply
// writes them in (#926). Every declared integration needs a place here.
const existingConfigReportOrder = [
  "editorconfig",
  "github-repository-controls",
  "html-validate",
  "knip",
  "react-doctor",
  "stylelint",
  "stryker",
];

export const integrationConfigFiles = Object.freeze(
  Object.fromEntries(
    managedFileDeclarations
      .toSorted(
        (left, right) =>
          existingConfigReportOrder.indexOf(left.integration) -
          existingConfigReportOrder.indexOf(right.integration),
      )
      .map(({ integration, files, existingConfigFiles }) => [
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
