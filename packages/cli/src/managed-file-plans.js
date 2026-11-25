// @ts-check
// The managed files apply writes for a recipe's integrations, and the rule that decides whether an
// existing file at a managed path would stop apply. Apply, clean, and the project phase that every
// doctor reads (ADR-0020, Decision 3) use this module, so the doctors' verdict on a managed file
// cannot drift from what apply does with it.
import { HTML_VALIDATE_IGNORE_PATH, htmlValidateIgnoreText } from "./ignore-lines.js";
import { githubRepositoryControlManagedFiles } from "./github-repository-controls.js";
import { GITHUB_REPOSITORY_CONTROLS_ID } from "./github-repository-controls-options.js";
import {
  HTML_VALIDATE_WRAPPER_PATH,
  managedFileDeclarations,
  STRYKER_CONFIG_PATH,
} from "./project-inspection.js";
import { selectedTestRunner } from "./stryker-options.js";
import { CALAVERA_EDITORCONFIG, renderEditorConfig } from "./utils/editorconfig.js";
import { readBoundedTemplate } from "./utils/fs.js";
import { formatGeneratedText } from "./utils/generated-text.js";
import { isPlainObject } from "./utils/guards.js";
import { textHash } from "./utils/hash.js";
import { projectFormatterLoader } from "./utils/project-formatter.js";
import { unique } from "./utils/unique.js";
import { formatterVitePlusStatus, vitePlusInstallDirectory } from "./vite-plus-detection.js";

/**
 * @typedef {import("./index.js").Integration} Integration
 * @typedef {import("./state.js").ManagedFileState} ManagedFileState
 * @typedef {import("./vite-plus-detection.js").VitePlusDetection} VitePlusDetection
 */

const HTML_VALIDATE_WRAPPER_TEMPLATE = new URL("./templates/lint-html.mjs", import.meta.url);
// A file that does not exist, so Stryker skips its tsconfig preprocessing (createStrykerConfig).
const STRYKER_SKIPPED_TSCONFIG = "stryker-skips-tsconfig-preprocessing.json";
// The arguments the tap runner passes to node for each test file: the tap reporter, which the
// runner parses, then Stryker's coverage hook and the test file (#736). These are the runner's
// defaults in 10.1.1 (dist/schema/tap-runner-options.json); the config states them so that the
// dry run shows them and a change of default cannot change what runs.
const STRYKER_TAP_NODE_ARGS = ["--test-reporter=tap", "-r", "{{hookFile}}", "{{testFile}}"];
// With the runner's default, forceBail: true, the tap runner kills a test process once it reads the
// process's first failure. The coverage hook then writes Stryker's result file into the process's
// current directory, so when the kill lands while a test is inside another folder, a temporary
// project for example, the runner cannot find the file and reports the mutant as a runtime error
// instead of killed (#1088, as in this repository's own config, #985). Turning it off lets each test
// file run to its end, which costs time on a file that kills a mutant; Stryker still stops at the
// first failing file.
const STRYKER_TAP_FORCE_BAIL = false;

function createHtmlValidateWrapper() {
  return readBoundedTemplate(HTML_VALIDATE_WRAPPER_TEMPLATE, "HTML Validate wrapper");
}

function createEditorConfig() {
  return renderEditorConfig(CALAVERA_EDITORCONFIG);
}

/**
 * @param {Integration[]} integrations
 * @param {Record<string, unknown>} [integrationOptions]
 * @returns {{ extends: string[], ignoreFiles: string[], plugins: string[], rules: Record<string, unknown> }}
 */
function createStylelintConfig(integrations, integrationOptions = {}) {
  /** @type {{ extends: string[], ignoreFiles: string[], plugins: string[], rules: Record<string, unknown> }} */
  const config = {
    extends: [],
    ignoreFiles: [
      "coverage/**",
      "dist/**",
      "**/dist/**",
      "**/dist-types/**",
      "dist-web/**",
      "node_modules/**",
      // Agent worktrees are full checkouts of other branches, so their files are not this project's.
      ".claude/worktrees/**",
    ],
    plugins: [],
    rules: {},
  };

  for (const integration of integrations) {
    if (!integration.stylelint) {
      continue;
    }

    config.extends.push(...(integration.stylelint.extends ?? []));
    config.plugins.push(...(integration.stylelint.plugins ?? []));
    config.rules = {
      ...config.rules,
      ...integration.stylelint.rules,
    };
  }

  config.extends = unique(config.extends);
  config.plugins = unique(config.plugins);

  const baselineOptions = integrationOptions["stylelint-baseline"];
  if (baselineOptions) {
    config.rules["plugin/use-baseline"] = [true, baselineOptions];
  }

  return config;
}

/**
 * @param {Integration[]} integrations
 * @returns {{ extends: string[], rules: Record<string, unknown> }}
 */
function createHtmlValidateConfig(integrations) {
  return {
    extends: unique(integrations.flatMap((integration) => integration.htmlValidate?.extends ?? [])),
    rules: Object.assign(
      {},
      ...integrations.map((integration) => integration.htmlValidate?.rules ?? {}),
    ),
  };
}

function createReactDoctorConfig() {
  return {
    offline: true,
  };
}

function createKnipConfig() {
  return {
    $schema: "https://unpkg.com/knip@6/schema.json",
    ignore: [".agents/**"],
    ignoreExportsUsedInFile: true,
  };
}

/**
 * The managed `stryker.config.json` (#734), verified with Stryker 10.1.1 in a `vp create` library
 * under pnpm, npm, Yarn 4, and Bun with the Vitest runner, and with the tap runner on node:test
 * tests (#736). The config names the runner the recipe selects, because Stryker's default command
 * runner reports a timeout for every mutant of a slow suite and counts those as detected
 * (ADR-0014), and lists it in `plugins`, because pnpm's strict `node_modules` layout hides it from
 * Stryker's default plugin lookup. The tap runner also gets the test files, the node arguments,
 * and forceBail turned off.
 *
 * @param {import("./stryker-options.js").SelectedTestRunner} runner
 */
export function createStrykerConfig(runner) {
  return {
    $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
    testRunner: runner.strykerTestRunner,
    plugins: runner.dependencies,
    ...(runner.strykerTestRunner === "tap"
      ? {
          tap: {
            testFiles: runner.testFiles,
            nodeArgs: STRYKER_TAP_NODE_ARGS,
            forceBail: STRYKER_TAP_FORCE_BAIL,
          },
        }
      : {}),
    // WORKAROUND(@stryker-mutator/core): tsconfig preprocessing calls the TypeScript JS API, which TypeScript 7 removed, and vp create projects use TypeScript 7; a missing file skips it | upstream: https://github.com/stryker-mutator/stryker-js/issues/6111
    tsconfigFile: STRYKER_SKIPPED_TSCONFIG,
    reporters: ["clear-text", "html"],
  };
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function sortJsonValue(value) {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, sortJsonValue(item)]),
    );
  }

  return value;
}

/**
 * @param {string} path
 * @param {string} installedContents
 * @param {string} targetContents
 * @returns {boolean}
 */
function jsonContentsMatch(path, installedContents, targetContents) {
  if (!path.endsWith(".json")) {
    return false;
  }

  try {
    return (
      JSON.stringify(sortJsonValue(JSON.parse(installedContents))) ===
      JSON.stringify(sortJsonValue(JSON.parse(targetContents)))
    );
  } catch {
    return false;
  }
}

/**
 * The text of each integration's managed files, by path. Which files exist, and the order apply
 * writes them in, come from `managedFileDeclarations` in project-inspection.js (#458).
 *
 * @type {Record<string, (integration: Integration, integrations: Integration[], integrationOptions: Record<string, unknown>) => Record<string, string>>}
 */
const managedFileContents = {
  editorconfig: () => ({ ".editorconfig": createEditorConfig() }),
  stylelint: (_integration, integrations, integrationOptions) => ({
    ".stylelintrc.json": `${JSON.stringify(createStylelintConfig(integrations, integrationOptions), null, 2)}\n`,
  }),
  "html-validate": (_integration, integrations) => ({
    ".htmlvalidate.json": `${JSON.stringify(createHtmlValidateConfig(integrations), null, 2)}\n`,
    [HTML_VALIDATE_IGNORE_PATH]: htmlValidateIgnoreText(integrations),
    [HTML_VALIDATE_WRAPPER_PATH]: createHtmlValidateWrapper(),
  }),
  "react-doctor": () => ({
    "react-doctor.config.json": `${JSON.stringify(createReactDoctorConfig(), null, 2)}\n`,
  }),
  knip: () => ({ "knip.json": `${JSON.stringify(createKnipConfig(), null, 2)}\n` }),
  stryker: (stryker, _integrations, integrationOptions) => {
    const runner = /** @type {import("./stryker-options.js").SelectedTestRunner} */ (
      selectedTestRunner(stryker, integrationOptions)
    );
    return {
      [STRYKER_CONFIG_PATH]: `${JSON.stringify(createStrykerConfig(runner), null, 2)}\n`,
    };
  },
  [GITHUB_REPOSITORY_CONTROLS_ID]: (_integration, integrations, integrationOptions) =>
    Object.fromEntries(
      githubRepositoryControlManagedFiles(
        integrationOptions[GITHUB_REPOSITORY_CONTROLS_ID],
        integrations,
      ).map(({ path, contents }) => [path, contents]),
    ),
};

/**
 * @param {Integration[]} integrations
 * @param {Record<string, unknown>} [integrationOptions]
 * @returns {{ path: string, contents: string }[]}
 */
export function plannedManagedFiles(integrations, integrationOptions = {}) {
  return managedFileDeclarations.flatMap(({ integration: id, files }) => {
    const integration = integrations.find((selected) => selected.id === id);
    if (!integration) {
      return [];
    }

    const createContents = managedFileContents[id];
    if (!createContents) {
      throw new Error(`Calavera declares managed files for ${id} but has no contents for them.`);
    }

    const contentsByPath = createContents(integration, integrations, integrationOptions);
    // A file with contents but no declaration would never be written, so it stops the plan.
    const undeclared = Object.keys(contentsByPath).filter(
      (path) => !files.some((file) => file.path === path),
    );
    if (undeclared.length > 0) {
      throw new Error(
        `Calavera has contents for ${undeclared.join(", ")} but does not declare them for ${id}.`,
      );
    }

    return files.map(({ path }) => {
      const contents = contentsByPath[path];
      if (contents === undefined) {
        throw new Error(`Calavera declares ${path} for ${id} but has no contents for it.`);
      }
      return { path, contents };
    });
  });
}

/**
 * The managed files with the text apply writes: each JSON and Markdown file formatted by the
 * project's formatter (#669).
 *
 * @param {{ path: string, contents: string }[]} plans
 * @param {() => Promise<import("./utils/project-formatter.js").ProjectFormatter>} loadFormatter
 * @returns {Promise<{ path: string, contents: string }[]>}
 */
export async function formatManagedFilePlans(plans, loadFormatter) {
  return Promise.all(
    plans.map(async (plan) => ({
      ...plan,
      contents: await formatGeneratedText(plan.path, plan.contents, loadFormatter),
    })),
  );
}

/**
 * How the file on disk at a managed path compares with what apply would write there, by the rule
 * `assertSafeManagedFileWrite` and `inspectManagedFilePlan` both apply. `accepted` means apply
 * writes over it without stopping: the contents equal the planned contents, the hash equals the
 * state record's, or the JSON values are equal. `edited` is a recorded file apply stops on, and
 * `unrecorded` a file without a record apply stops on, as not recorded as Calavera-managed.
 *
 * @param {string} path
 * @param {string} installedContents
 * @param {string} plannedContents The planned contents, formatted as apply writes them.
 * @param {ManagedFileState | undefined} stateFile
 * @returns {"accepted" | "edited" | "unrecorded"}
 */
export function managedFileDifference(path, installedContents, plannedContents, stateFile) {
  const installedHash = textHash(installedContents);
  if (
    installedHash === textHash(plannedContents) ||
    stateFile?.hash === installedHash ||
    jsonContentsMatch(path, installedContents, plannedContents)
  ) {
    return "accepted";
  }
  return stateFile ? "edited" : "unrecorded";
}

/**
 * The formatter loader for the managed files apply writes into `directory`, which the phase
 * function also uses, so the doctors load the formatter whenever apply would (ADR-0020, Decision
 * 3). Under create-here the formatter follows the parent's verdict, as the install and the quality
 * script do (#961), so the parent's vp check accepts the files apply writes. When apply also
 * writes Calavera's .editorconfig, formatting stops if that file would change the settings the
 * formatter uses, because the formatter can only read the settings on disk.
 *
 * @param {string} directory
 * @param {VitePlusDetection} detection
 * @param {{ id: string }[]} integrations
 */
export function managedFileFormatterLoader(directory, detection, integrations) {
  return projectFormatterLoader(directory, formatterVitePlusStatus(detection), {
    editorConfig: integrations.some(({ id }) => id === "editorconfig")
      ? CALAVERA_EDITORCONFIG
      : undefined,
    installDirectory: vitePlusInstallDirectory(detection),
  });
}
