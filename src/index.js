#!/usr/bin/env node
// @ts-check
import { existsSync } from "node:fs";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { cancel, confirm, intro, isCancel, multiselect, select, spinner } from "@clack/prompts";
import { execa } from "execa";

import {
  assertAiSourceExists,
  buildAiApplyResult,
  hashAiInstall,
  resolveAiArtifacts,
} from "./ai/artifacts.js";
import { integrationCatalog } from "./catalog.js";
import {
  createEmptyState,
  managedFileStateForPath,
  managedFilesFromState,
  normalizeState,
  optionalStringArray,
} from "./state.js";
import { buildRecipe, profileDefaults } from "./recipe.js";
import { FileWriteError } from "./utils/file-write-error.js";
import { fileExists, readJSON, writeJSON } from "./utils/fs.js";
import { isNotEmptyString, isPlainObject } from "./utils/guards.js";
import { textHash } from "./utils/hash.js";
import { logger } from "./utils/logger.js";

/**
 * @typedef {"npm" | "pnpm" | "yarn" | "bun"} PackageManager
 * @typedef {import("./ai/artifacts.js").AiArtifactState} AiArtifactState
 * @typedef {import("./state.js").CalaveraState} CalaveraState
 * @typedef {import("./state.js").ManagedFileState} ManagedFileState
 *
 * @typedef {object} CliOptions
 * @property {string} command
 * @property {string} config
 * @property {boolean} dryRun
 * @property {boolean} json
 * @property {boolean} noInstall
 * @property {boolean} assumeYes
 * @property {PackageManager} [packageManager]
 * @property {string} [profile]
 *
 * @typedef {object} PackageManagerCommands
 * @property {[string, string[]]} init
 * @property {(dependencies: string[]) => [string, string[]]} installDev
 * @property {(script: string) => string} run
 *
 * @typedef {object} PackageJSON
 * @property {Record<string, string | boolean>} [scripts]
 * @property {string} [packageManager]
 * @property {{ packageManager?: { name?: string } | Array<{ name?: string }> }} [devEngines]
 *
 * @typedef {object} Integration
 * @property {string} id
 * @property {string} [label]
 * @property {string} [group]
 * @property {string} [platform]
 * @property {string} [plugin]
 * @property {string} [status]
 * @property {string[]} [dependencies]
 * @property {string[]} [includes]
 * @property {{ extends?: string[], plugins?: string[], rules?: Record<string, unknown> }} [stylelint]
 *
 * @typedef {object} Recipe
 * @property {string} [$schema]
 * @property {number} [version]
 * @property {string} [profile]
 * @property {PackageManager} [packageManager]
 * @property {string[]} [integrations]
 * @property {Record<string, boolean>} [scripts]
 * @property {unknown} [ai]
 *
 * @typedef {{ type: string, path: string, category?: "ai", aiType?: string, name?: string, reason?: string, scripts?: string[], removedDefaultTestScript?: boolean }} Change
 *
 * @typedef {object} ApplyResult
 * @property {"apply"} command
 * @property {boolean} dryRun
 * @property {PackageManager} packageManager
 * @property {string[]} dependencies
 * @property {string[]} integrations
 * @property {Change[]} changes
 * @property {string[]} pointers
 *
 * @typedef {object} CleanResult
 * @property {"clean"} command
 * @property {boolean} [dryRun]
 * @property {Change[]} changes
 * @property {string} message
 *
 * @typedef {object} DoctorResult
 * @property {"doctor"} command
 * @property {boolean} ok
 * @property {{ level: "error" | "warning", message: string }[]} issues
 *
 * @typedef {object} InitResult
 * @property {"init"} command
 * @property {string} config
 * @property {boolean} dryRun
 * @property {Recipe} recipe
 *
 * @typedef {ApplyResult | CleanResult | DoctorResult | InitResult} CommandResult
 */

const CONFIG_FILE = "calavera.config.json";
const STATE_FILE = ".calavera/state.json";
const SCRIPT_SOURCE_EXTENSIONS = ["js", "jsx", "ts", "tsx", "mjs", "cjs"];
const TSC_INCLUDE_PATTERNS = SCRIPT_SOURCE_EXTENSIONS.map((extension) => `src/**/*.${extension}`);

/** @type {Record<PackageManager, PackageManagerCommands>} */
const packageManagerCommands = {
  npm: {
    init: ["npm", ["init", "-y"]],
    installDev: (dependencies) => ["npm", ["install", "--save-dev", ...dependencies]],
    run: (script) => `npm run ${script}`,
  },
  pnpm: {
    init: ["pnpm", ["init"]],
    installDev: (dependencies) => ["pnpm", ["add", "--save-dev", ...dependencies]],
    run: (script) => `pnpm ${script}`,
  },
  yarn: {
    init: ["yarn", ["init", "-y"]],
    installDev: (dependencies) => ["yarn", ["add", "--dev", ...dependencies]],
    run: (script) => `yarn ${script}`,
  },
  bun: {
    init: ["bun", ["init", "-y"]],
    installDev: (dependencies) => ["bun", ["add", "--dev", ...dependencies]],
    run: (script) => `bun run ${script}`,
  },
};

/** @type {PackageManager[]} */
const supportedPackageManagers = /** @type {PackageManager[]} */ (
  Object.keys(packageManagerCommands)
);
const args = process.argv.slice(2);

/**
 * @param {string} packageManager
 * @returns {never}
 */
function exitUnsupportedPackageManager(packageManager) {
  logger.error(
    `Unsupported package manager "${packageManager}". Supported package managers: ${supportedPackageManagers.join(", ")}.`,
  );
  process.exit(1);
  throw new Error(`Unsupported package manager "${packageManager}".`);
}

/**
 * @param {string | undefined} packageManager
 * @returns {PackageManager}
 */
function assertSupportedPackageManager(packageManager) {
  if (
    !packageManager ||
    !supportedPackageManagers.includes(/** @type {PackageManager} */ (packageManager))
  ) {
    exitUnsupportedPackageManager(packageManager ?? "<missing>");
  }

  return /** @type {PackageManager} */ (packageManager);
}

/**
 * @param {string[]} rawArgs
 * @returns {CliOptions}
 */
function parseArgs(rawArgs) {
  /** @type {CliOptions} */
  const parsed = {
    command: rawArgs[0]?.startsWith("-") ? "init" : (rawArgs[0] ?? "init"),
    config: CONFIG_FILE,
    dryRun: false,
    json: false,
    noInstall: false,
    assumeYes: false,
  };

  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--config") {
      parsed.config = rawArgs[index + 1] ?? CONFIG_FILE;
      index += 1;
    } else if (arg === "--dry-run") {
      parsed.dryRun = true;
    } else if (arg === "--json") {
      parsed.json = true;
    } else if (arg === "--no-install") {
      parsed.noInstall = true;
    } else if (arg === "--yes") {
      parsed.assumeYes = true;
    } else if (arg === "--package-manager") {
      parsed.packageManager = assertSupportedPackageManager(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--profile") {
      parsed.profile = rawArgs[index + 1] ?? undefined;
      index += 1;
    }
  }

  return parsed;
}

/**
 * @returns {Promise<PackageJSON>}
 */
async function readPackageJSONIfPresent() {
  const packageJSONPath = resolve("package.json");

  if (await fileExists(packageJSONPath)) {
    return /** @type {Promise<PackageJSON>} */ (readJSON(packageJSONPath));
  }

  return {};
}

/**
 * @param {string} path
 * @returns {Promise<Recipe>}
 */
async function readRecipe(path) {
  const recipe = await readJSON(path);

  if (!isPlainObject(recipe)) {
    throw new Error(`${path} must contain a JSON object.`);
  }

  optionalStringArray(recipe.integrations, `${path} integrations`);

  if (Object.hasOwn(recipe, "packageManager") && !isNotEmptyString(recipe.packageManager)) {
    throw new Error(`${path} packageManager must be a non-empty string.`);
  }

  if (Object.hasOwn(recipe, "scripts") && !isPlainObject(recipe.scripts)) {
    throw new Error(`${path} scripts must be an object.`);
  }

  return /** @type {Recipe} */ (recipe);
}

/**
 * @param {Array<string | null | undefined | false>} values
 * @returns {string[]}
 */
function unique(values) {
  return [...new Set(values.filter(isNotEmptyString))];
}

/**
 * @returns {Promise<CalaveraState>}
 */
async function readStateIfPresent() {
  if (!(await fileExists(STATE_FILE))) {
    return createEmptyState();
  }

  return normalizeState(await readJSON(STATE_FILE));
}

/**
 * @param {Recipe} recipe
 * @returns {Integration[]}
 */
function resolveIntegrations(recipe) {
  const selected = new Set(recipe.integrations ?? []);

  for (const integration of /** @type {Integration[]} */ (integrationCatalog)) {
    if (selected.has(integration.id)) {
      for (const includes of integration.includes ?? []) {
        selected.add(includes);
      }
    }
  }

  return /** @type {Integration[]} */ (integrationCatalog).filter((integration) =>
    selected.has(integration.id),
  );
}

/**
 * @param {PackageJSON} [packageJSON]
 * @returns {PackageManager}
 */
function detectPackageManager(packageJSON = {}) {
  if (packageJSON.packageManager?.startsWith("pnpm")) {
    return "pnpm";
  }

  if (packageJSON.packageManager?.startsWith("yarn")) {
    return "yarn";
  }

  if (packageJSON.packageManager?.startsWith("bun")) {
    return "bun";
  }

  const devPackageManagers = [packageJSON.devEngines?.packageManager]
    .flat()
    .flatMap((packageManager) =>
      packageManager && typeof packageManager.name === "string" ? [packageManager.name] : [],
    );
  const devPackageManager = devPackageManagers.find((packageManager) =>
    supportedPackageManagers.includes(/** @type {PackageManager} */ (packageManager)),
  );

  if (devPackageManager) {
    return /** @type {PackageManager} */ (devPackageManager);
  }

  if (existsSync("pnpm-lock.yaml") || existsSync("shrinkwrap.yaml")) {
    return "pnpm";
  }

  if (existsSync("yarn.lock")) {
    return "yarn";
  }

  if (existsSync("bun.lockb")) {
    return "bun";
  }

  if (existsSync("package-lock.json")) {
    return "npm";
  }

  return "npm";
}

/**
 * @param {PackageJSON} packageJSON
 * @returns {boolean}
 */
function removeDefaultTestScript(packageJSON) {
  const defaultNpmTestScript = 'echo "Error: no test specified" && exit 1';

  if (packageJSON.scripts?.test === defaultNpmTestScript) {
    delete packageJSON.scripts.test;
    return true;
  }

  return false;
}

/**
 * @param {PackageManager} packageManager
 * @param {boolean} dryRun
 * @param {boolean} assumeYes
 * @param {boolean} json
 * @returns {Promise<PackageJSON>}
 */
async function ensurePackageJSON(packageManager, dryRun, assumeYes, json) {
  const supportedPackageManager = assertSupportedPackageManager(packageManager);
  const packageJSONPath = resolve("package.json");

  if (await fileExists(packageJSONPath)) {
    return /** @type {Promise<PackageJSON>} */ (readJSON(packageJSONPath));
  }

  if (!assumeYes) {
    const createPackageJSON = await confirm({
      message:
        "No package.json found. Calavera needs one to manage tooling. Create a default package.json?",
    });

    if (!createPackageJSON || isCancel(createPackageJSON)) {
      cancel("Setup cancelled");
      process.exit(0);
    }
  }

  if (!dryRun) {
    const [command, commandArgs] = packageManagerCommands[supportedPackageManager].init;
    const spin = json ? null : spinner();
    spin?.start("Creating package.json...");
    await execa(command, commandArgs, { stderr: "inherit" });
    spin?.stop("Created package.json");
  }

  return dryRun ? { scripts: {} } : /** @type {Promise<PackageJSON>} */ (readJSON(packageJSONPath));
}

/**
 * @param {string} label
 * @param {string[]} extensions
 * @param {string} command
 * @returns {string}
 */
function runIfFiles(label, extensions, command) {
  return `node .calavera/run-if-files.mjs "${label}" "${extensions.join(",")}" -- ${command}`;
}

/**
 * @param {string} label
 * @param {string[]} extensions
 * @param {string} command
 * @returns {string}
 */
function runChangedFiles(label, extensions, command) {
  return `node .calavera/run-changed-files.mjs "${label}" "${extensions.join(",")}" -- ${command}`;
}

/**
 * @param {Recipe} recipe
 * @param {Integration[]} integrations
 * @param {PackageManager} packageManager
 * @returns {Record<string, string>}
 */
function buildScripts(recipe, integrations, packageManager) {
  const supportedPackageManager = assertSupportedPackageManager(packageManager);
  /** @param {string} id */
  const has = (id) => integrations.some((integration) => integration.id === id);
  const usesOxlint = has("oxlint");
  const usesESLint = has("eslint");
  const usesStylelint = has("stylelint");
  const usesOxfmt = has("oxfmt");
  const usesPrettier = has("prettier");
  const usesReactDoctor = has("react-doctor");
  const usesTypeScript = has("typescript");
  const cssExtensions = ["css", "scss"];
  const reactExtensions = ["js", "jsx", "ts", "tsx"];

  const lintParts = [
    usesOxlint ? runIfFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "oxlint .") : null,
    usesESLint ? runIfFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "eslint .") : null,
    usesStylelint ? runIfFiles("CSS", cssExtensions, 'stylelint "**/*.{css,scss}"') : null,
  ].filter(Boolean);

  const lintFixParts = [
    usesOxlint
      ? runIfFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "oxlint --fix .")
      : null,
    usesESLint
      ? runIfFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "eslint --fix .")
      : null,
    usesStylelint ? runIfFiles("CSS", cssExtensions, 'stylelint "**/*.{css,scss}" --fix') : null,
  ].filter(Boolean);

  const lintChangedParts = [
    usesOxlint
      ? runChangedFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "oxlint")
      : null,
    usesESLint
      ? runChangedFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "eslint")
      : null,
    usesStylelint ? runChangedFiles("CSS", cssExtensions, "stylelint") : null,
  ].filter(Boolean);

  const lintFixChangedParts = [
    usesOxlint
      ? runChangedFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "oxlint --fix")
      : null,
    usesESLint
      ? runChangedFiles("JavaScript/TypeScript", SCRIPT_SOURCE_EXTENSIONS, "eslint --fix")
      : null,
    usesStylelint ? runChangedFiles("CSS", cssExtensions, "stylelint --fix") : null,
  ].filter(Boolean);

  /** @type {Record<string, string>} */
  const scripts = {};

  if (recipe.scripts?.lint && lintParts.length > 0) {
    scripts.lint = lintParts.join(" && ");
  }

  if (recipe.scripts?.["lint:fix"] && lintFixParts.length > 0) {
    scripts["lint:fix"] = lintFixParts.join(" && ");
  }

  if (recipe.scripts?.["lint:changed"] && lintChangedParts.length > 0) {
    scripts["lint:changed"] = lintChangedParts.join(" && ");
  }

  if (recipe.scripts?.["lint:fix:changed"] && lintFixChangedParts.length > 0) {
    scripts["lint:fix:changed"] = lintFixChangedParts.join(" && ");
  }

  if (recipe.scripts?.format) {
    if (usesOxfmt) {
      scripts.format = runIfFiles(
        "JavaScript/TypeScript",
        SCRIPT_SOURCE_EXTENSIONS,
        "oxfmt --write .",
      );
    } else if (usesPrettier) {
      scripts.format = "prettier --write .";
    }
  }

  if (recipe.scripts?.["format:changed"]) {
    if (usesOxfmt) {
      scripts["format:changed"] = runChangedFiles(
        "JavaScript/TypeScript",
        SCRIPT_SOURCE_EXTENSIONS,
        "oxfmt --write",
      );
    } else if (usesPrettier) {
      scripts["format:changed"] = runChangedFiles(
        "Prettier-supported",
        [
          "css",
          "html",
          "js",
          "jsx",
          "json",
          "jsonc",
          "md",
          "mjs",
          "scss",
          "ts",
          "tsx",
          "yaml",
          "yml",
        ],
        "prettier --write",
      );
    }
  }

  if (recipe.scripts?.["format:check"]) {
    if (usesOxfmt) {
      scripts["format:check"] = runIfFiles(
        "JavaScript/TypeScript",
        SCRIPT_SOURCE_EXTENSIONS,
        "oxfmt --check .",
      );
    } else if (usesPrettier) {
      scripts["format:check"] = "prettier --check .";
    }
  }

  if (recipe.scripts?.["format:check:changed"]) {
    if (usesOxfmt) {
      scripts["format:check:changed"] = runChangedFiles(
        "JavaScript/TypeScript",
        SCRIPT_SOURCE_EXTENSIONS,
        "oxfmt --check",
      );
    } else if (usesPrettier) {
      scripts["format:check:changed"] = runChangedFiles(
        "Prettier-supported",
        [
          "css",
          "html",
          "js",
          "jsx",
          "json",
          "jsonc",
          "md",
          "mjs",
          "scss",
          "ts",
          "tsx",
          "yaml",
          "yml",
        ],
        "prettier --check",
      );
    }
  }

  if (recipe.scripts?.typecheck && usesTypeScript) {
    scripts.typecheck = runIfFiles(
      "JavaScript/TypeScript",
      SCRIPT_SOURCE_EXTENSIONS,
      "tsc --noEmit",
    );
  }

  if (usesReactDoctor) {
    scripts["react:doctor"] = runIfFiles("React", reactExtensions, "react-doctor --offline");
    scripts["react:doctor:diff"] = runIfFiles(
      "React",
      reactExtensions,
      "react-doctor --offline --diff",
    );
  }

  if (recipe.scripts?.quality) {
    const qualityScripts = [
      "lint",
      "format:check",
      usesTypeScript && recipe.scripts?.typecheck ? "typecheck" : null,
      usesReactDoctor ? "react:doctor" : null,
    ]
      .filter(isNotEmptyString)
      .filter((script) => Boolean(scripts[script]));

    scripts.quality = qualityScripts
      .map((script) => packageManagerCommands[supportedPackageManager].run(script))
      .join(" && ");
  }

  if (recipe.scripts?.["quality:changed"]) {
    const qualityChangedScripts = [
      "lint:changed",
      "format:check:changed",
      usesReactDoctor ? "react:doctor:diff" : null,
    ]
      .filter(isNotEmptyString)
      .filter((script) => Boolean(scripts[script]));

    if (qualityChangedScripts.length > 0) {
      scripts["quality:changed"] = qualityChangedScripts
        .map((script) => packageManagerCommands[supportedPackageManager].run(script))
        .join(" && ");
    }
  }

  return scripts;
}

function createRunIfFilesHelper() {
  return `#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import { spawn } from "node:child_process";

const ignoredDirectories = new Set([
  ".calavera",
  ".git",
  "coverage",
  "dist",
  "dist-web",
  "node_modules",
]);

const [label, extensionList, separator, ...command] = process.argv.slice(2);

if (separator !== "--" || command.length === 0) {
  console.info("Usage: run-if-files <label> <extensions> -- <command>");
  process.exit(1);
}

const extensions = new Set(
  extensionList.split(",").map((extension) => \`.\${extension.trim()}\`),
);

async function hasMatchingFile(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      if (await hasMatchingFile(join(directory, entry.name))) {
        return true;
      }
    } else if (extensions.has(extname(entry.name))) {
      return true;
    }
  }

  return false;
}

if (!(await hasMatchingFile(process.cwd()))) {
  console.info(\`No \${label} files found. Skipping.\`);
  process.exit(0);
}

const child = spawn(command[0], command.slice(1), {
  env: {
    ...process.env,
    PATH: [join(process.cwd(), "node_modules", ".bin"), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.info(\`Failed to start "\${command[0]}": \${error.message}\`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.info(\`Command stopped by signal \${signal}.\`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
`;
}

function createRunChangedFilesHelper() {
  return `#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { delimiter, extname, join, normalize } from "node:path";

const ignoredDirectories = new Set([
  ".calavera",
  ".git",
  "coverage",
  "dist",
  "dist-web",
  "node_modules",
]);

const [label, extensionList, separator, ...command] = process.argv.slice(2);

if (separator !== "--" || command.length === 0) {
  console.info("Usage: run-changed-files <label> <extensions> -- <command>");
  process.exit(1);
}

const extensions = new Set(
  extensionList.split(",").map((extension) => \`.\${extension.trim()}\`),
);

function git(args, allowFailure = false) {
  const result = spawnSync("git", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status === 0) {
    return result.stdout;
  }

  if (allowFailure) {
    return "";
  }

  console.info(result.stderr.trim() || \`Failed to run git \${args.join(" ")}.\`);
  process.exit(1);
}

function gitFiles(args) {
  return git(args, true)
    .split("\\n")
    .map((file) => file.trim())
    .filter(Boolean);
}

function defaultBaseRef() {
  return (
    process.env.CALAVERA_CHANGED_BASE ||
    git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], true).trim() ||
    "HEAD"
  );
}

function isIgnored(file) {
  return normalize(file)
    .split(/[\\\\/]+/)
    .some((part) => ignoredDirectories.has(part));
}

if (git(["rev-parse", "--is-inside-work-tree"], true).trim() !== "true") {
  console.info("Changed-file scripts require a Git working tree.");
  process.exit(1);
}

const baseRef = defaultBaseRef();
const baseDiff =
  baseRef === "HEAD"
    ? gitFiles(["diff", "--name-only", "--diff-filter=ACMR", "--relative", "HEAD"])
    : gitFiles(["diff", "--name-only", "--diff-filter=ACMR", "--relative", \`\${baseRef}...HEAD\`]);

const changedFiles = [
  ...baseDiff,
  ...gitFiles(["diff", "--name-only", "--diff-filter=ACMR", "--relative"]),
  ...gitFiles(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "--relative"]),
  ...gitFiles(["ls-files", "--others", "--exclude-standard"]),
];

const files = [...new Set(changedFiles)].filter(
  (file) => extensions.has(extname(file)) && !isIgnored(file),
);

if (files.length === 0) {
  console.info(\`No changed \${label} files found. Skipping.\`);
  process.exit(0);
}

const child = spawn(command[0], [...command.slice(1), ...files], {
  env: {
    ...process.env,
    PATH: [join(process.cwd(), "node_modules", ".bin"), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.info(\`Failed to start "\${command[0]}": \${error.message}\`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.info(\`Command stopped by signal \${signal}.\`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
`;
}

function createEditorConfig() {
  return `root = true

[*]
charset = utf-8
end_of_line = lf
insert_final_newline = true
indent_style = space
indent_size = 2
trim_trailing_whitespace = true
`;
}

/**
 * @param {Integration[]} integrations
 * @returns {{ plugins: string[], rules: Record<string, unknown> }}
 */
function createOxlintConfig(integrations) {
  const pluginNames = integrations
    .filter((integration) => integration.platform === "oxlint-plugin")
    .map((integration) => integration.plugin);

  return {
    plugins: unique(pluginNames),
    rules: {},
  };
}

/**
 * @param {Integration[]} integrations
 * @returns {string}
 */
function createESLintConfig(integrations) {
  const useTypeScript = integrations.some((integration) => integration.id === "typescript-eslint");
  const usePrettier = integrations.some(
    (integration) => integration.id === "eslint-config-prettier",
  );

  const imports = [
    'import js from "@eslint/js";',
    'import globals from "globals";',
    useTypeScript ? 'import tseslint from "typescript-eslint";' : null,
    usePrettier ? 'import eslintConfigPrettier from "eslint-config-prettier";' : null,
  ].filter(Boolean);

  const configs = [
    "js.configs.recommended",
    useTypeScript ? "...tseslint.configs.strictTypeChecked" : null,
    useTypeScript ? "...tseslint.configs.stylisticTypeChecked" : null,
    usePrettier ? "eslintConfigPrettier" : null,
  ].filter(Boolean);

  const baseConfig = `{
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.nodeBuiltin,
      },${
        useTypeScript
          ? `
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },`
          : ""
      }
    },
    rules: {
      "no-console": ["error", { allow: ["clear", "info"] }],
    },
  }`;

  if (useTypeScript) {
    return `${imports.join("\n")}

export default tseslint.config(
  ${configs.join(",\n  ")},
  ${baseConfig},
);
`;
  }

  return `${imports.join("\n")}

export default [
  ${configs.join(",\n  ")},
  ${baseConfig},
];
`;
}

/**
 * @param {Integration[]} integrations
 * @returns {{ extends: string[], ignoreFiles: string[], plugins: string[], rules: Record<string, unknown> }}
 */
function createStylelintConfig(integrations) {
  /** @type {{ extends: string[], ignoreFiles: string[], plugins: string[], rules: Record<string, unknown> }} */
  const config = {
    extends: [],
    ignoreFiles: ["coverage/**", "dist/**", "dist-web/**", "node_modules/**"],
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

  return config;
}

function createTSConfig() {
  return {
    compilerOptions: {
      allowJs: true,
      esModuleInterop: true,
      forceConsistentCasingInFileNames: true,
      isolatedModules: true,
      module: "ESNext",
      moduleResolution: "bundler",
      noEmit: true,
      noUncheckedIndexedAccess: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      strict: true,
      target: "ESNext",
      types: ["node"],
      verbatimModuleSyntax: true,
    },
    include: TSC_INCLUDE_PATTERNS,
    exclude: ["node_modules"],
  };
}

function createReactDoctorConfig() {
  return {
    offline: true,
  };
}

/**
 * @param {Integration[]} integrations
 * @returns {boolean}
 */
function usesRunIfFilesHelper(integrations) {
  return integrations.some((integration) =>
    ["eslint", "oxfmt", "oxlint", "react-doctor", "stylelint", "typescript"].includes(
      integration.id,
    ),
  );
}

/**
 * @param {Recipe} recipe
 * @param {Integration[]} integrations
 * @returns {boolean}
 */
function usesRunChangedFilesHelper(recipe, integrations) {
  const usesChangedScript = [
    "lint:changed",
    "lint:fix:changed",
    "format:changed",
    "format:check:changed",
  ].some((script) => recipe.scripts?.[script]);

  return (
    usesChangedScript &&
    integrations.some((integration) =>
      ["eslint", "oxfmt", "oxlint", "prettier", "stylelint"].includes(integration.id),
    )
  );
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {CalaveraState} previousState
 */
async function assertSafeManagedFileWrite(path, contents, previousState) {
  if (!(await fileExists(path))) {
    return;
  }

  const targetHash = textHash(contents);
  const installedHash = textHash(await readFile(path, "utf8"));

  if (installedHash === targetHash) {
    return;
  }

  const stateFile = managedFileStateForPath(previousState, path);

  if (stateFile?.hash === installedHash) {
    return;
  }

  const reason = stateFile
    ? `It appears to have local edits (installed=${installedHash}, state=${stateFile.hash}).`
    : "It is not recorded as Calavera-managed.";

  throw new Error(`Refusing to overwrite existing managed file: ${path}. ${reason}`);
}

/**
 * @param {{ path: string, contents: string }[]} filePlans
 * @param {CalaveraState} previousState
 */
async function assertSafeManagedFileWrites(filePlans, previousState) {
  for (const filePlan of filePlans) {
    await assertSafeManagedFileWrite(filePlan.path, filePlan.contents, previousState);
  }
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {CalaveraState} previousState
 * @returns {Promise<ManagedFileState>}
 */
async function writeManagedFile(path, contents, dryRun, changes, previousState) {
  changes.push({ type: "write", path });

  const managedFile = {
    path,
    hash: textHash(contents),
  };

  if (dryRun) {
    return managedFile;
  }

  await assertSafeManagedFileWrite(path, contents, previousState);

  const directory = dirname(path);
  if (directory !== ".") {
    await mkdir(directory, { recursive: true });
  }

  await writeFile(path, contents);

  return managedFile;
}

/**
 * @param {string} path
 * @param {unknown} value
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {CalaveraState} previousState
 * @returns {Promise<ManagedFileState>}
 */
async function writeManagedJSONFile(path, value, dryRun, changes, previousState) {
  return writeManagedFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    dryRun,
    changes,
    previousState,
  );
}

/**
 * @param {Recipe} recipe
 * @param {Integration[]} integrations
 * @returns {{ path: string, contents: string }[]}
 */
function plannedManagedFiles(recipe, integrations) {
  const plans = [];

  if (integrations.some((integration) => integration.id === "editorconfig")) {
    plans.push({ path: ".editorconfig", contents: createEditorConfig() });
  }

  if (usesRunIfFilesHelper(integrations)) {
    plans.push({ path: ".calavera/run-if-files.mjs", contents: createRunIfFilesHelper() });
  }

  if (usesRunChangedFilesHelper(recipe, integrations)) {
    plans.push({
      path: ".calavera/run-changed-files.mjs",
      contents: createRunChangedFilesHelper(),
    });
  }

  if (integrations.some((integration) => integration.id === "oxlint")) {
    plans.push({
      path: "oxlint.json",
      contents: `${JSON.stringify(createOxlintConfig(integrations), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "eslint")) {
    plans.push({ path: "eslint.config.js", contents: createESLintConfig(integrations) });
  }

  if (integrations.some((integration) => integration.id === "prettier")) {
    plans.push({ path: ".prettierrc.json", contents: `${JSON.stringify({}, null, 2)}\n` });
    plans.push({
      path: ".prettierignore",
      contents: "node_modules\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\nbun.lockb\n",
    });
  }

  if (integrations.some((integration) => integration.id === "stylelint")) {
    plans.push({
      path: ".stylelintrc.json",
      contents: `${JSON.stringify(createStylelintConfig(integrations), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "react-doctor")) {
    plans.push({
      path: "react-doctor.config.json",
      contents: `${JSON.stringify(createReactDoctorConfig(), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "typescript")) {
    plans.push({
      path: "tsconfig.json",
      contents: `${JSON.stringify(createTSConfig(), null, 2)}\n`,
    });
  }

  return plans;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<ApplyResult>}
 */
async function applyRecipe(options) {
  const configPath = resolve(options.config);
  const recipe = await readRecipe(configPath);
  const previousState = await readStateIfPresent();
  const integrations = resolveIntegrations(recipe);
  const dependencyList = unique(
    integrations.flatMap((integration) => integration.dependencies ?? []),
  );
  const detectedPackageJSON = await readPackageJSONIfPresent();
  const packageManager = assertSupportedPackageManager(
    options.packageManager ?? recipe.packageManager ?? detectPackageManager(detectedPackageJSON),
  );
  const packageJSON = await ensurePackageJSON(
    packageManager,
    options.dryRun,
    options.assumeYes,
    options.json,
  );
  const scripts = buildScripts(recipe, integrations, packageManager);
  const changes = [];
  /** @type {ManagedFileState[]} */
  const managedFiles = [];
  const removedDefaultTestScript = removeDefaultTestScript(packageJSON);
  const managedFilePlans = plannedManagedFiles(recipe, integrations);

  if (!options.dryRun) {
    await assertSafeManagedFileWrites(managedFilePlans, previousState);
  }

  const aiResult = await buildAiApplyResult(recipe, options, previousState);

  packageJSON.scripts = {
    ...packageJSON.scripts,
    ...scripts,
  };
  changes.push({
    type: "update",
    path: "package.json",
    scripts: Object.keys(scripts),
    removedDefaultTestScript,
  });

  if (integrations.some((integration) => integration.id === "editorconfig")) {
    managedFiles.push(
      await writeManagedFile(
        ".editorconfig",
        createEditorConfig(),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (usesRunIfFilesHelper(integrations)) {
    managedFiles.push(
      await writeManagedFile(
        ".calavera/run-if-files.mjs",
        createRunIfFilesHelper(),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (usesRunChangedFilesHelper(recipe, integrations)) {
    managedFiles.push(
      await writeManagedFile(
        ".calavera/run-changed-files.mjs",
        createRunChangedFilesHelper(),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "oxlint")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "oxlint.json",
        createOxlintConfig(integrations),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "eslint")) {
    managedFiles.push(
      await writeManagedFile(
        "eslint.config.js",
        createESLintConfig(integrations),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "prettier")) {
    managedFiles.push(
      await writeManagedJSONFile(".prettierrc.json", {}, options.dryRun, changes, previousState),
    );
    managedFiles.push(
      await writeManagedFile(
        ".prettierignore",
        "node_modules\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\nbun.lockb\n",
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "stylelint")) {
    managedFiles.push(
      await writeManagedJSONFile(
        ".stylelintrc.json",
        createStylelintConfig(integrations),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "react-doctor")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "react-doctor.config.json",
        createReactDoctorConfig(),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "typescript")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "tsconfig.json",
        createTSConfig(),
        options.dryRun,
        changes,
        previousState,
      ),
    );
  }

  if (!options.dryRun) {
    await writeJSON("package.json", packageJSON, false);
  }

  if (!options.dryRun) {
    await mkdir(".calavera", { recursive: true });
    await writeJSON(
      STATE_FILE,
      {
        version: 1,
        profile: recipe.profile,
        integrations: integrations.map((integration) => integration.id),
        files: managedFiles.map((file) => file.path),
        managedFiles,
        aiArtifacts: aiResult.artifacts,
      },
      false,
    );
  }

  if (dependencyList.length > 0 && !options.noInstall && !options.dryRun) {
    const [command, commandArgs] =
      packageManagerCommands[packageManager].installDev(dependencyList);
    const spin = spinner();
    spin.start("Installing development dependencies...");
    await execa(command, commandArgs, { stderr: "inherit" });
    spin.stop("Dependencies installed");
  }

  return {
    command: "apply",
    dryRun: options.dryRun,
    packageManager,
    dependencies: dependencyList,
    integrations: integrations.map((integration) => integration.id),
    changes: [...changes, ...aiResult.changes],
    pointers: aiResult.pointers,
  };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<InitResult>}
 */
async function initRecipe(options) {
  if (!options.json) {
    console.clear();
    intro("Compose your Calavera tooling recipe");
  }

  const profile =
    options.profile ??
    (await select({
      message: "Choose a tooling profile",
      options: [
        { value: "modern", label: "Modern", hint: "Oxlint, Oxfmt, Stylelint" },
        {
          value: "classic",
          label: "Classic",
          hint: "ESLint, Prettier, Stylelint",
        },
        { value: "minimal", label: "Minimal", hint: "EditorConfig only" },
      ],
    }));

  if (isCancel(profile)) {
    cancel("Setup cancelled");
    process.exit(0);
  }

  const profileName = typeof profile === "string" ? profile : "modern";
  const defaults = profileDefaults[profileName] ?? profileDefaults.modern;
  const optionalOptions = /** @type {Integration[]} */ (integrationCatalog)
    .filter((integration) => integration.status !== "required")
    .map((integration) => ({
      value: integration.id,
      label: integration.label,
      hint: `${integration.group} · ${integration.status}`,
    }));

  const selected =
    options.assumeYes || options.profile
      ? defaults
      : await multiselect({
          message: "Choose integration packs",
          options: optionalOptions,
          initialValues: defaults,
          required: true,
        });

  if (isCancel(selected)) {
    cancel("Setup cancelled");
    process.exit(0);
  }

  if (
    !Array.isArray(selected) ||
    !selected.every((integration) => typeof integration === "string")
  ) {
    throw new Error("Selected integration values must be strings.");
  }

  const detectedPackageJSON = await readPackageJSONIfPresent();
  const packageManager = assertSupportedPackageManager(
    options.packageManager ?? detectPackageManager(detectedPackageJSON),
  );
  const recipe = buildRecipe(profileName, selected, packageManager);

  await writeJSON(options.config, recipe, options.dryRun);

  return {
    command: "init",
    config: options.config,
    dryRun: options.dryRun,
    recipe,
  };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<DoctorResult>}
 */
async function doctor(options) {
  const hasConfig = await fileExists(options.config);
  const hasPackageJSON = await fileExists("package.json");
  /** @type {{ level: "error" | "warning", message: string }[]} */
  const issues = [];

  if (!hasConfig) {
    issues.push({
      level: "error",
      message: `Missing ${options.config}. Run create-project-calavera init first.`,
    });
  }

  if (!hasPackageJSON) {
    issues.push({
      level: "warning",
      message: "Missing package.json. Calavera can create one during apply.",
    });
  }

  if (hasConfig) {
    const recipe = await readRecipe(options.config);
    const integrations = resolveIntegrations(recipe);
    const aiArtifacts = resolveAiArtifacts(recipe);
    const expectedFiles = [
      integrations.some((integration) => integration.id === "editorconfig")
        ? ".editorconfig"
        : null,
      integrations.some((integration) => integration.id === "oxlint") ? "oxlint.json" : null,
      integrations.some((integration) => integration.id === "eslint") ? "eslint.config.js" : null,
      integrations.some((integration) => integration.id === "prettier") ? ".prettierrc.json" : null,
      integrations.some((integration) => integration.id === "prettier") ? ".prettierignore" : null,
      integrations.some((integration) => integration.id === "stylelint")
        ? ".stylelintrc.json"
        : null,
      integrations.some((integration) => integration.id === "react-doctor")
        ? "react-doctor.config.json"
        : null,
      integrations.some((integration) => integration.id === "typescript") ? "tsconfig.json" : null,
      usesRunIfFilesHelper(integrations) ? ".calavera/run-if-files.mjs" : null,
      usesRunChangedFilesHelper(recipe, integrations) ? ".calavera/run-changed-files.mjs" : null,
    ].filter(isNotEmptyString);

    for (const file of expectedFiles) {
      if (!(await fileExists(file))) {
        issues.push({
          level: "warning",
          message: `Missing managed file: ${file}. Run create-project-calavera apply to regenerate managed files.`,
        });
      }
    }

    for (const artifact of aiArtifacts) {
      await assertAiSourceExists(artifact.type, artifact.sourcePath, artifact.index);

      if (!(await fileExists(artifact.path))) {
        issues.push({
          level: "warning",
          message: `Missing managed AI ${artifact.type}: ${artifact.path}. Run create-project-calavera apply to regenerate managed AI artifacts.`,
        });
      }
    }
  }

  return {
    command: "doctor",
    ok: issues.every((issue) => issue.level !== "error"),
    issues,
  };
}

/**
 * @param {Recipe} recipe
 * @param {Integration[]} integrations
 * @returns {string[]}
 */
function expectedManagedFiles(recipe, integrations) {
  return [
    integrations.some((integration) => integration.id === "editorconfig") ? ".editorconfig" : null,
    integrations.some((integration) => integration.id === "oxlint") ? "oxlint.json" : null,
    integrations.some((integration) => integration.id === "eslint") ? "eslint.config.js" : null,
    integrations.some((integration) => integration.id === "prettier") ? ".prettierrc.json" : null,
    integrations.some((integration) => integration.id === "prettier") ? ".prettierignore" : null,
    integrations.some((integration) => integration.id === "stylelint") ? ".stylelintrc.json" : null,
    integrations.some((integration) => integration.id === "react-doctor")
      ? "react-doctor.config.json"
      : null,
    integrations.some((integration) => integration.id === "typescript") ? "tsconfig.json" : null,
    usesRunIfFilesHelper(integrations) ? ".calavera/run-if-files.mjs" : null,
    usesRunChangedFilesHelper(recipe, integrations) ? ".calavera/run-changed-files.mjs" : null,
  ].filter(isNotEmptyString);
}

/**
 * @param {CliOptions} options
 * @returns {Promise<CleanResult>}
 */
async function clean(options) {
  const hasState = await fileExists(STATE_FILE);

  if (!hasState) {
    return {
      command: "clean",
      changes: [],
      message: "No Calavera state found. Nothing to clean.",
    };
  }

  const state = await readStateIfPresent();
  const recipe = (await fileExists(options.config))
    ? await readRecipe(options.config)
    : { integrations: [] };
  const integrations = resolveIntegrations(recipe);
  const expectedAiPaths = new Set(resolveAiArtifacts(recipe).map((artifact) => artifact.path));
  const expectedFiles = new Set(expectedManagedFiles(recipe, integrations));
  const staleFiles = managedFilesFromState(state).filter((file) => !expectedFiles.has(file.path));
  const staleAiArtifacts = state.aiArtifacts.filter(
    (artifact) => !expectedAiPaths.has(artifact.path),
  );
  /** @type {ManagedFileState[]} */
  const staleFilesSafeToRemove = [];
  /** @type {Array<ManagedFileState & { reason?: string, installedHash?: string }>} */
  const staleFilesWithLocalEdits = [];
  /** @type {AiArtifactState[]} */
  const staleAiArtifactsSafeToRemove = [];
  /** @type {Array<AiArtifactState & { installedHash: string }>} */
  const staleAiArtifactsWithLocalEdits = [];

  for (const file of staleFiles) {
    if (!(await fileExists(file.path))) {
      staleFilesSafeToRemove.push(file);
      continue;
    }

    if (!file.hash) {
      staleFilesWithLocalEdits.push({
        ...file,
        reason:
          "Managed file has legacy state without a hash; run apply before clean can remove it safely.",
      });
      continue;
    }

    const installedHash = textHash(await readFile(file.path, "utf8"));

    if (installedHash === file.hash) {
      staleFilesSafeToRemove.push(file);
    } else {
      staleFilesWithLocalEdits.push({
        ...file,
        installedHash,
      });
    }
  }

  for (const artifact of staleAiArtifacts) {
    if (!(await fileExists(artifact.path))) {
      staleAiArtifactsSafeToRemove.push(artifact);
      continue;
    }

    const installedHash = await hashAiInstall(artifact.type, artifact.path, artifact.target);

    if (installedHash === artifact.hash) {
      staleAiArtifactsSafeToRemove.push(artifact);
    } else {
      staleAiArtifactsWithLocalEdits.push({
        ...artifact,
        installedHash,
      });
    }
  }

  if (staleFilesSafeToRemove.length === 0 && staleAiArtifactsSafeToRemove.length === 0) {
    return {
      command: "clean",
      changes: [
        ...staleFilesWithLocalEdits.map((file) => ({
          type: "skip",
          path: file.path,
          reason:
            file.reason ??
            `Managed file has local edits (installed=${file.installedHash}, state=${file.hash}).`,
        })),
        ...staleAiArtifactsWithLocalEdits.map((artifact) => ({
          type: "skip",
          path: artifact.path,
          reason: `AI artifact has local edits (installed=${artifact.installedHash}, state=${artifact.hash}).`,
        })),
      ],
      message:
        staleFilesWithLocalEdits.length > 0 || staleAiArtifactsWithLocalEdits.length > 0
          ? "No stale managed items were safe to remove. Some stale items have local edits."
          : "No stale managed files found.",
    };
  }

  if (!options.assumeYes && !options.dryRun) {
    const staleCount = staleFilesSafeToRemove.length + staleAiArtifactsSafeToRemove.length;
    const shouldClean = await confirm({
      message: `Remove ${staleCount} stale Calavera-managed item(s)?`,
    });

    if (!shouldClean || isCancel(shouldClean)) {
      return {
        command: "clean",
        changes: [],
        message: "Clean cancelled.",
      };
    }
  }

  const changes = [
    ...staleFilesSafeToRemove.map((file) => ({ type: "delete", path: file.path })),
    ...staleFilesWithLocalEdits.map((file) => ({
      type: "skip",
      path: file.path,
      reason:
        file.reason ??
        `Managed file has local edits (installed=${file.installedHash}, state=${file.hash}).`,
    })),
    ...staleAiArtifactsSafeToRemove.map((artifact) => ({
      type: "delete",
      path: artifact.path,
      category: "ai",
      aiType: artifact.type,
      name: artifact.name,
    })),
    ...staleAiArtifactsWithLocalEdits.map((artifact) => ({
      type: "skip",
      path: artifact.path,
      category: "ai",
      aiType: artifact.type,
      name: artifact.name,
      reason: `AI artifact has local edits (installed=${artifact.installedHash}, state=${artifact.hash}).`,
    })),
  ];

  if (!options.dryRun) {
    for (const file of staleFilesSafeToRemove) {
      if (await fileExists(file.path)) {
        await unlink(file.path);
      }
    }

    for (const artifact of staleAiArtifactsSafeToRemove) {
      await rm(artifact.path, { force: true, recursive: true });
    }

    await writeJSON(
      STATE_FILE,
      {
        ...state,
        files: managedFilesFromState(state)
          .filter((file) => expectedFiles.has(file.path))
          .map((file) => file.path),
        managedFiles: managedFilesFromState(state).filter((file) => expectedFiles.has(file.path)),
        aiArtifacts: state.aiArtifacts.filter((artifact) => expectedAiPaths.has(artifact.path)),
      },
      false,
    );
  }

  return {
    command: "clean",
    dryRun: options.dryRun,
    changes,
    message: options.dryRun
      ? "Dry run complete. No files were removed."
      : "Removed stale managed files.",
  };
}

/**
 * @param {CommandResult} result
 * @param {boolean} [asJSON]
 */
function printResult(result, asJSON = false) {
  if (asJSON) {
    console.info(JSON.stringify(result, null, 2));
    return;
  }

  if (result.command === "doctor") {
    if (result.issues.length === 0) {
      logger.success("Calavera doctor found no issues.");
      return;
    }

    for (const issue of result.issues) {
      logger[issue.level === "error" ? "error" : "warn"](issue.message);
    }
    return;
  }

  if (result.command === "clean") {
    logger.info(result.message);
    return;
  }

  if (result.command === "apply" && result.dryRun) {
    logger.info("Calavera apply dry run complete. No files were changed.");
    logger.info(`Package manager: ${result.packageManager}`);

    if (result.integrations.length > 0) {
      logger.info(`Integrations: ${result.integrations.join(", ")}`);
    }

    if (result.dependencies.length > 0) {
      logger.info(`Dev dependencies: ${result.dependencies.join(", ")}`);
    } else {
      logger.info("Dev dependencies: none");
    }

    for (const change of result.changes) {
      if (change.type === "write") {
        logger.info(
          change.category === "ai"
            ? `Would write AI ${change.aiType} ${change.name} to ${change.path}`
            : `Would write ${change.path}`,
        );
      }

      if (change.type === "update") {
        logger.info(`Would update ${change.path}`);

        if (change.scripts && change.scripts.length > 0) {
          logger.info(`Would add scripts: ${change.scripts.join(", ")}`);
        }

        if (change.removedDefaultTestScript) {
          logger.info("Would remove the default npm test placeholder script");
        }
      }
    }

    for (const pointer of result.pointers ?? []) {
      logger.info(`Pointer: ${pointer}`);
    }

    return;
  }

  logger.success(`Calavera ${result.command} complete.`);

  if (result.command === "apply") {
    for (const pointer of result.pointers) {
      logger.info(pointer);
    }
  }
}

async function main() {
  const options = parseArgs(args);

  if (options.command === "init") {
    printResult(await initRecipe(options), options.json);
    return;
  }

  if (options.command === "apply") {
    printResult(await applyRecipe(options), options.json);
    return;
  }

  if (options.command === "doctor") {
    printResult(await doctor(options), options.json);
    return;
  }

  if (options.command === "update") {
    printResult(await applyRecipe(options), options.json);
    return;
  }

  if (options.command === "clean") {
    printResult(await clean(options), options.json);
    return;
  }

  logger.error(`Unknown command: ${options.command}`);
  process.exitCode = 1;
}

main().catch((error) => {
  if (error instanceof FileWriteError) {
    logger.error(error.message);
    logger.error(error.cause);
  } else {
    logger.error(error);
  }
  process.exitCode = 1;
});
