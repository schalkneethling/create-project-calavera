#!/usr/bin/env node
import { existsSync } from "node:fs";
import { access, constants, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { cancel, confirm, intro, isCancel, multiselect, select, spinner } from "@clack/prompts";
import { execa } from "execa";

import { integrationCatalog } from "./catalog.js";
import { FileWriteError } from "./utils/file-write-error.js";
import { logger } from "./utils/logger.js";

const CONFIG_FILE = "calavera.config.json";
const STATE_FILE = ".calavera/state.json";

const profileDefaults = {
  modern: [
    "editorconfig",
    "typescript",
    "oxlint",
    "oxlint-eslint",
    "oxlint-typescript",
    "oxlint-unicorn",
    "oxlint-oxc",
    "oxfmt",
    "stylelint",
    "stylelint-standard",
    "stylelint-baseline",
  ],
  classic: [
    "editorconfig",
    "typescript",
    "eslint",
    "typescript-eslint",
    "eslint-config-prettier",
    "prettier",
    "stylelint",
    "stylelint-standard",
    "stylelint-baseline",
  ],
  minimal: ["editorconfig"],
};

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

const supportedPackageManagers = Object.keys(packageManagerCommands);
const args = process.argv.slice(2);

function exitUnsupportedPackageManager(packageManager) {
  console.error(
    `Unsupported package manager "${packageManager}". Supported package managers: ${supportedPackageManagers.join(", ")}.`,
  );
  process.exit(1);
}

function assertSupportedPackageManager(packageManager) {
  if (!supportedPackageManagers.includes(packageManager)) {
    exitUnsupportedPackageManager(packageManager);
  }

  return packageManager;
}

function parseArgs(rawArgs) {
  const parsed = {
    command: rawArgs[0]?.startsWith("-") ? "init" : (rawArgs[0] ?? "init"),
    config: CONFIG_FILE,
    dryRun: false,
    json: false,
    noInstall: false,
    yes: false,
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
      parsed.yes = true;
    } else if (arg === "--package-manager") {
      parsed.packageManager = assertSupportedPackageManager(rawArgs[index + 1]);
      index += 1;
    } else if (arg === "--profile") {
      parsed.profile = rawArgs[index + 1];
      index += 1;
    }
  }

  return parsed;
}

async function fileExists(path) {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJSON(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function writeJSON(path, value, dryRun) {
  if (dryRun) {
    return;
  }

  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function resolveIntegrations(recipe) {
  const selected = new Set(recipe.integrations ?? []);

  for (const integration of integrationCatalog) {
    if (selected.has(integration.id)) {
      for (const includes of integration.includes ?? []) {
        selected.add(includes);
      }
    }
  }

  return integrationCatalog.filter((integration) => selected.has(integration.id));
}

function buildRecipe(profile, integrations, packageManager = "npm") {
  return {
    $schema: "https://calavera.dev/schema/calavera.config.schema.json",
    version: 1,
    profile,
    packageManager,
    integrations,
    scripts: {
      lint: true,
      "lint:fix": true,
      format: true,
      "format:check": true,
      typecheck: true,
      check: true,
    },
  };
}

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

function removeDefaultTestScript(packageJSON) {
  const defaultNpmTestScript = 'echo "Error: no test specified" && exit 1';

  if (packageJSON.scripts?.test === defaultNpmTestScript) {
    delete packageJSON.scripts.test;
    return true;
  }

  return false;
}

async function ensurePackageJSON(packageManager, dryRun, yes, json) {
  const supportedPackageManager = assertSupportedPackageManager(packageManager);
  const packageJSONPath = resolve("package.json");

  if (await fileExists(packageJSONPath)) {
    return readJSON(packageJSONPath);
  }

  if (!yes) {
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

  return dryRun ? { scripts: {} } : readJSON(packageJSONPath);
}

function runIfFiles(label, extensions, command) {
  return `node .calavera/run-if-files.mjs "${label}" "${extensions.join(",")}" -- ${command}`;
}

function buildScripts(recipe, integrations, packageManager) {
  const supportedPackageManager = assertSupportedPackageManager(packageManager);
  const has = (id) => integrations.some((integration) => integration.id === id);
  const usesOxlint = has("oxlint");
  const usesESLint = has("eslint");
  const usesStylelint = has("stylelint");
  const usesOxfmt = has("oxfmt");
  const usesPrettier = has("prettier");
  const usesReactDoctor = has("react-doctor");
  const usesTypeScript = has("typescript");
  const jsExtensions = ["js", "jsx", "ts", "tsx", "mjs", "cjs"];
  const cssExtensions = ["css", "scss"];
  const reactExtensions = ["js", "jsx", "ts", "tsx"];
  const tsExtensions = ["ts", "tsx"];

  const lintParts = [
    usesOxlint ? runIfFiles("JavaScript/TypeScript", jsExtensions, "oxlint .") : null,
    usesESLint ? runIfFiles("JavaScript/TypeScript", jsExtensions, "eslint .") : null,
    usesStylelint ? runIfFiles("CSS", cssExtensions, 'stylelint "**/*.{css,scss}"') : null,
  ].filter(Boolean);

  const lintFixParts = [
    usesOxlint ? runIfFiles("JavaScript/TypeScript", jsExtensions, "oxlint --fix .") : null,
    usesESLint ? runIfFiles("JavaScript/TypeScript", jsExtensions, "eslint --fix .") : null,
    usesStylelint ? runIfFiles("CSS", cssExtensions, 'stylelint "**/*.{css,scss}" --fix') : null,
  ].filter(Boolean);

  const scripts = {};

  if (recipe.scripts?.lint && lintParts.length > 0) {
    scripts.lint = lintParts.join(" && ");
  }

  if (recipe.scripts?.["lint:fix"] && lintFixParts.length > 0) {
    scripts["lint:fix"] = lintFixParts.join(" && ");
  }

  if (recipe.scripts?.format) {
    if (usesOxfmt) {
      scripts.format = runIfFiles("JavaScript/TypeScript", jsExtensions, "oxfmt --write .");
    } else if (usesPrettier) {
      scripts.format = "prettier --write .";
    }
  }

  if (recipe.scripts?.["format:check"]) {
    if (usesOxfmt) {
      scripts["format:check"] = runIfFiles(
        "JavaScript/TypeScript",
        jsExtensions,
        "oxfmt --check .",
      );
    } else if (usesPrettier) {
      scripts["format:check"] = "prettier --check .";
    }
  }

  if (recipe.scripts?.typecheck && usesTypeScript) {
    scripts.typecheck = runIfFiles("TypeScript", tsExtensions, "tsc --noEmit");
  }

  if (usesReactDoctor) {
    scripts["react:doctor"] = runIfFiles("React", reactExtensions, "react-doctor --offline");
    scripts["react:doctor:diff"] = runIfFiles(
      "React",
      reactExtensions,
      "react-doctor --offline --diff",
    );
  }

  if (recipe.scripts?.check) {
    scripts.check = [
      "lint",
      "format:check",
      usesTypeScript && recipe.scripts?.typecheck ? "typecheck" : null,
      usesReactDoctor ? "react:doctor" : null,
    ]
      .filter((script) => script && scripts[script])
      .map((script) => packageManagerCommands[supportedPackageManager].run(script))
      .join(" && ");
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

function createOxlintConfig(integrations) {
  const pluginNames = integrations
    .filter((integration) => integration.platform === "oxlint-plugin")
    .map((integration) => integration.plugin);

  return {
    plugins: unique(pluginNames),
    rules: {},
  };
}

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

function createStylelintConfig(integrations) {
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
      verbatimModuleSyntax: true,
    },
    include: ["src/**/*.ts", "src/**/*.tsx"],
    exclude: ["node_modules"],
  };
}

function createReactDoctorConfig() {
  return {
    offline: true,
  };
}

function usesRunIfFilesHelper(integrations) {
  return integrations.some((integration) =>
    ["eslint", "oxfmt", "oxlint", "react-doctor", "stylelint", "typescript"].includes(
      integration.id,
    ),
  );
}

async function writeManagedFile(path, contents, dryRun, changes) {
  changes.push({ type: "write", path });

  if (dryRun) {
    return;
  }

  const directory = dirname(path);
  if (directory !== ".") {
    await mkdir(directory, { recursive: true });
  }

  await writeFile(path, contents);
}

async function applyRecipe(options) {
  const configPath = resolve(options.config);
  const recipe = await readJSON(configPath);
  const integrations = resolveIntegrations(recipe);
  const dependencyList = unique(
    integrations.flatMap((integration) => integration.dependencies ?? []),
  );
  const packageManager = assertSupportedPackageManager(
    options.packageManager ?? recipe.packageManager ?? detectPackageManager(),
  );
  const packageJSON = await ensurePackageJSON(
    packageManager,
    options.dryRun,
    options.yes,
    options.json,
  );
  const scripts = buildScripts(recipe, integrations, packageManager);
  const changes = [];
  const removedDefaultTestScript = removeDefaultTestScript(packageJSON);

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

  if (!options.dryRun) {
    await writeJSON("package.json", packageJSON, false);
  }

  if (integrations.some((integration) => integration.id === "editorconfig")) {
    await writeManagedFile(".editorconfig", createEditorConfig(), options.dryRun, changes);
  }

  if (usesRunIfFilesHelper(integrations)) {
    await writeManagedFile(
      ".calavera/run-if-files.mjs",
      createRunIfFilesHelper(),
      options.dryRun,
      changes,
    );
  }

  if (integrations.some((integration) => integration.id === "oxlint")) {
    await writeJSON("oxlint.json", createOxlintConfig(integrations), options.dryRun);
    changes.push({ type: "write", path: "oxlint.json" });
  }

  if (integrations.some((integration) => integration.id === "eslint")) {
    await writeManagedFile(
      "eslint.config.js",
      createESLintConfig(integrations),
      options.dryRun,
      changes,
    );
  }

  if (integrations.some((integration) => integration.id === "prettier")) {
    await writeJSON(".prettierrc.json", {}, options.dryRun);
    changes.push({ type: "write", path: ".prettierrc.json" });
    await writeManagedFile(
      ".prettierignore",
      "node_modules\npackage-lock.json\npnpm-lock.yaml\nyarn.lock\nbun.lockb\n",
      options.dryRun,
      changes,
    );
  }

  if (integrations.some((integration) => integration.id === "stylelint")) {
    await writeJSON(".stylelintrc.json", createStylelintConfig(integrations), options.dryRun);
    changes.push({ type: "write", path: ".stylelintrc.json" });
  }

  if (integrations.some((integration) => integration.id === "react-doctor")) {
    await writeJSON("react-doctor.config.json", createReactDoctorConfig(), options.dryRun);
    changes.push({ type: "write", path: "react-doctor.config.json" });
  }

  if (integrations.some((integration) => integration.id === "typescript")) {
    await writeJSON("tsconfig.json", createTSConfig(), options.dryRun);
    changes.push({ type: "write", path: "tsconfig.json" });
  }

  if (!options.dryRun) {
    await mkdir(".calavera", { recursive: true });
    await writeJSON(STATE_FILE, {
      version: 1,
      profile: recipe.profile,
      integrations: integrations.map((integration) => integration.id),
      files: changes.filter((change) => change.type === "write").map((change) => change.path),
    });
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
    changes,
  };
}

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

  const defaults = profileDefaults[profile] ?? profileDefaults.modern;
  const optionalOptions = integrationCatalog
    .filter((integration) => integration.status !== "required")
    .map((integration) => ({
      value: integration.id,
      label: integration.label,
      hint: `${integration.group} · ${integration.status}`,
    }));

  const selected =
    options.yes || options.profile
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

  const packageManager = assertSupportedPackageManager(
    options.packageManager ?? detectPackageManager(),
  );
  const recipe = buildRecipe(profile, selected, packageManager);

  await writeJSON(options.config, recipe, options.dryRun);

  return {
    command: "init",
    config: options.config,
    dryRun: options.dryRun,
    recipe,
  };
}

async function doctor(options) {
  const hasConfig = await fileExists(options.config);
  const hasPackageJSON = await fileExists("package.json");
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
    const recipe = await readJSON(options.config);
    const integrations = resolveIntegrations(recipe);
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
    ].filter(Boolean);

    for (const file of expectedFiles) {
      if (!(await fileExists(file))) {
        issues.push({
          level: "warning",
          message: `Missing managed file: ${file}. Run create-project-calavera apply to regenerate managed files.`,
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

function expectedManagedFiles(integrations) {
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
  ].filter(Boolean);
}

async function clean(options) {
  const hasState = await fileExists(STATE_FILE);

  if (!hasState) {
    return {
      command: "clean",
      changes: [],
      message: "No Calavera state found. Nothing to clean.",
    };
  }

  const state = await readJSON(STATE_FILE);
  const recipe = (await fileExists(options.config))
    ? await readJSON(options.config)
    : { integrations: [] };
  const integrations = resolveIntegrations(recipe);
  const expectedFiles = new Set(expectedManagedFiles(integrations));
  const staleFiles = (state.files ?? []).filter((file) => !expectedFiles.has(file));

  if (staleFiles.length === 0) {
    return {
      command: "clean",
      changes: [],
      message: "No stale managed files found.",
    };
  }

  if (!options.yes && !options.dryRun) {
    const shouldClean = await confirm({
      message: `Remove ${staleFiles.length} stale Calavera-managed file(s)?`,
    });

    if (!shouldClean || isCancel(shouldClean)) {
      return {
        command: "clean",
        changes: [],
        message: "Clean cancelled.",
      };
    }
  }

  const changes = staleFiles.map((path) => ({ type: "delete", path }));

  if (!options.dryRun) {
    for (const path of staleFiles) {
      if (await fileExists(path)) {
        await unlink(path);
      }
    }

    await writeJSON(STATE_FILE, {
      ...state,
      files: (state.files ?? []).filter((file) => expectedFiles.has(file)),
    });
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
        logger.info(`Would write ${change.path}`);
      }

      if (change.type === "update") {
        logger.info(`Would update ${change.path}`);

        if (change.scripts.length > 0) {
          logger.info(`Would add scripts: ${change.scripts.join(", ")}`);
        }

        if (change.removedDefaultTestScript) {
          logger.info("Would remove the default npm test placeholder script");
        }
      }
    }

    return;
  }

  logger.success(`Calavera ${result.command} complete.`);
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
