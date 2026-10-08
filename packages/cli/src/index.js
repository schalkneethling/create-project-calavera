// @ts-check
import { existsSync, realpathSync } from "node:fs";
import { glob, mkdir, readFile, readdir, rm, stat, unlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs as parseNodeArgs, stripVTControlCharacters } from "node:util";

import {
  cancel,
  confirm,
  groupMultiselect,
  intro,
  isCancel,
  note,
  outro,
  select,
  spinner,
  text,
} from "@clack/prompts";
import { execa } from "execa";
import { parse as parseYAML } from "yaml";
import packageJson from "../package.json" with { type: "json" };
import { prepareArtifactSources, runArtifactCommand } from "./artifact-lifecycle.js";
import {
  GITHUB_REPOSITORY_CONTROLS_ID,
  githubRepositoryControlManagedFiles,
} from "./github-repository-controls.js";
import { assertRootOnlyIntegrationsAtRepositoryRoot } from "./repository-root.js";
import { detectVitePlus } from "./vite-plus-detection.js";

import {
  aiArtifactOutputPaths,
  assertAiSourceExists,
  buildAiApplyResult,
  hashAiInstall,
  resolveAiArtifacts,
} from "./ai/artifacts.js";
import {
  createEmptyState,
  managedFileStateForPath,
  managedFilesFromState,
  normalizeState,
  optionalStringArray,
} from "./state.js";
import {
  integrationConfigFiles,
  packageManagerLockfiles,
  projectInspectionFiles,
} from "./project-inspection.js";
import {
  assertKnownProfile,
  composeRecipe,
  explainRecipeResponse,
  listAiArtifactOptions,
  listIntegrationOptions,
  packageManagerIdsForRecipe,
  projectLocalCommandCatalog,
  profileIdsForRecipe,
  profileDefaults,
  resolveRecipeIntegrations,
  validateRecipe,
  validateRecipeResponse,
} from "./recipe.js";
import { assertKnownValue } from "./utils/assertions.js";
import { FileWriteError } from "./utils/file-write-error.js";
import { assertWorkspacePath, fileExists, readJSON, writeJSON } from "./utils/fs.js";
import { isNotEmptyString, isPlainObject } from "./utils/guards.js";
import { textHash } from "./utils/hash.js";
import { logger } from "./utils/logger.js";
import {
  createCodexMcpTomlBlock,
  createMcpServersJsonConfig,
  createOpenCodeMcpJsonConfig,
  projectMcpConfigPath,
  writeCodexMcpConfig,
  writeMcpServersJsonConfig,
  writeOpenCodeMcpConfig,
} from "./utils/mcp-config.js";
import { groupedPromptOptions } from "./utils/prompt-options.js";
import { pluralizeCount, style, titleCase } from "./utils/text.js";

/**
 * @typedef {"npm" | "pnpm" | "yarn" | "bun"} PackageManager
 * @typedef {"claude-code" | "codex" | "cursor" | "opencode" | "skip"} McpHarness
 * @typedef {import("./ai/artifacts.js").AiArtifactState} AiArtifactState
 * @typedef {import("./state.js").CalaveraState} CalaveraState
 * @typedef {import("./state.js").ManagedFileState} ManagedFileState
 * @typedef {import("./vite-plus-detection.js").VitePlusDetection} VitePlusDetection
 *
 * @typedef {object} CliOptions
 * @property {string} command
 * @property {string} config
 * @property {boolean} dryRun
 * @property {boolean} json
 * @property {boolean} noInstall
 * @property {boolean} assumeYes
 * @property {boolean} apply
 * @property {boolean} [writeConfig]
 * @property {ArtifactLockEntry[]} [approvedArtifacts] Artifacts a dry run reported it would lock; apply installs them at exactly those versions.
 * @property {PackageManager} [packageManager]
 * @property {"append" | "fallback"} [agentsMd]
 * @property {McpHarness} [mcpHarness]
 * @property {string} [profile]
 * @property {string[]} integrations
 * @property {{ id: string, target?: string }[]} aiArtifacts
 * @property {string[]} reownManagedFiles
 * @property {string} [artifactAction]
 * @property {string} [artifactId]
 * @property {"latest" | "next"} [artifactTag]
 * @property {boolean} [artifactAll]
 * @property {boolean} [checkUpdates]
 * @property {boolean} [init]
 * @property {string[]} [newArgs] Tokens after `--new`, forwarded verbatim to `vp create`.
 * @property {string} [newConfig] Recipe path given with `--config` before `--new`, copied into the scaffold.
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
 * @property {unknown[] | { packages?: unknown }} [workspaces]
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
 * @property {{ extends?: string[], rules?: Record<string, unknown> }} [htmlValidate]
 * @property {{ extends?: string[], plugins?: string[], rules?: Record<string, unknown> }} [stylelint]
 *
 * @typedef {object} Recipe
 * @property {string} [$schema]
 * @property {number} [version]
 * @property {string} [profile]
 * @property {PackageManager} [packageManager]
 * @property {string[]} [integrations]
 * @property {Record<string, unknown>} [integrationOptions]
 * @property {Record<string, boolean>} [scripts]
 * @property {unknown} [ai]
 *
 * @typedef {{ script: string, reason: string }} ScriptOmission
 * @typedef {{ step: string, reason: string }} QualityStepOmission
 * @typedef {{ severity: "info" | "warning" | "error", kind: string, message: string, path?: string }} ProjectInspectionFinding
 * @typedef {{ packageManager?: PackageManager, files: string[], findings: ProjectInspectionFinding[], vitePlus: VitePlusDetection }} ProjectInspection
 * @typedef {{ status: VitePlusDetection["status"], signalConflict: boolean, lines: string[] }} VitePlusReport
 * @typedef {{ reownManagedFiles?: string[] }} ProjectInspectionOptions
 * @typedef {{ scripts: Record<string, string>, omittedScripts: ScriptOmission[], omittedQualitySteps: QualityStepOmission[] }} ScriptPlan
 * @typedef {{ type: string, path: string, action?: "write" | "update" | "scaffold" | "merge", ownership?: "calavera" | "project", category?: "ai", aiType?: string, name?: string, reason?: string, scripts?: string[], omittedScripts?: ScriptOmission[], removedDefaultTestScript?: boolean, renamedScripts?: ScriptRename[], omittedQualitySteps?: QualityStepOmission[] }} Change
 * @typedef {{ script: string, value: string, previous?: string | boolean }} ScriptChange A package.json script apply adds, or changes from `previous`.
 * @typedef {{ from: string, to: string }} ScriptRename
 *
 * @typedef {object} ApplyResult
 * @property {"apply"} command
 * @property {boolean} dryRun
 * @property {PackageManager} packageManager
 * @property {string[]} dependencies
 * @property {string | null} installCommand The command that installs `dependencies`, `vp add -D` in a Vite+-managed project (ADR-0012); null when the recipe has none, or when apply skips the install.
 * @property {string[]} installNotes How apply runs the install command, and what stops it, for the approval boundary.
 * @property {string[]} integrations
 * @property {ProjectInspection} projectInspection
 * @property {VitePlusReport} vitePlus
 * @property {Change[]} changes
 * @property {ScriptChange[]} scriptChanges Each package.json script apply adds or changes, with the value it writes, so the approval boundary shows the command; a script that already has that value is not listed. Kept out of the package.json change, which a dry run reports the same before and after apply.
 * @property {string[]} pointers
 * @property {ArtifactLockEntry[]} autoInstalledArtifacts Selected artifacts that had no lock entry, which apply installs and locks first; a dry run reports the versions it would lock.
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
 * @property {{ ok: boolean, recipe?: Recipe, errors?: string[] }} validation
 * @property {{ integrations: unknown[], dependencies: string[], aiArtifacts: unknown[] }} explanation
 * @property {ApplyResult} [applyDryRun]
 * @property {ApplyResult} [applyResult]
 *
 * @typedef {object} AgentInitResult
 * @property {"agent-init"} command
 * @property {boolean} dryRun
 * @property {PackageManager} packageManager
 * @property {Change[]} changes
 * @property {string[]} pointers
 * @property {string} nextPrompt
 * @property {string[]} nextSteps
 * @property {{ harness: McpHarness, action: "manual" | "write" | "update" | "skip", path?: string, reason?: string }} mcp
 *
 * @typedef {object} NewResult
 * @property {"new"} command
 * @property {boolean} dryRun
 * @property {boolean} confirmed
 * @property {string[]} confirmation
 * @property {string} [target]
 * @property {AgentInitResult} [bootstrap]
 * @property {{ source: string, path: string }} [recipe] The recipe `--config` copied into the scaffold.
 *
 * @typedef {{ command: `artifacts ${string}`, [key: string]: unknown }} ArtifactCommandResult
 * @typedef {import("./artifact-lifecycle.js").ArtifactLockEntry} ArtifactLockEntry
 * @typedef {import("./artifact-lifecycle.js").ArtifactServices} ArtifactServices
 * @typedef {ApplyResult | CleanResult | DoctorResult | InitResult | AgentInitResult | NewResult | ArtifactCommandResult} CommandResult
 */

const CONFIG_FILE = "calavera.config.json";
const COMPOSER_URL = "https://calavera.schalkneethling.com/";
const STATE_FILE = ".calavera/state.json";
const AGENT_BOOTSTRAP_GUIDANCE_FILE = "AGENTS.md";
const AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE = "AGENTS.calavera.md";
const AGENT_BOOTSTRAP_MCP_FILE = ".agents/calavera/mcp.md";
const AGENT_BOOTSTRAP_MARKER = "<!-- calavera-agent-bootstrap -->";
const AGENT_BOOTSTRAP_SECTION_START = "<!-- calavera-agent-bootstrap:start -->";
const AGENT_BOOTSTRAP_SECTION_END = "<!-- calavera-agent-bootstrap:end -->";
const AGENT_BOOTSTRAP_SKILL_RECIPE = {
  ai: [{ type: "skill", src: "skills/calavera" }],
};
const AGENT_BOOTSTRAP_SKILL_PATH = fileURLToPath(new URL("./bootstrap/calavera/", import.meta.url));
const AGENT_BOOTSTRAP_NEXT_PROMPT =
  "Use Calavera for this project. First verify that the Calavera MCP tools are available. If they are not available, stop and help me configure the MCP server before composing or applying anything. Once the tools are available, inspect the current project for existing tooling and possible config conflicts, list the available profiles, integrations, and AI artifacts, compose a recipe, show me the dry-run result, and apply it only after I approve.";
const HTML_VALIDATE_IGNORE = "node_modules/\ndist/\ncoverage/\n";
const VARLOCK_SCHEMA = `# @defaultSensitive=false
# @defaultRequired=infer

# Application environment
# @type=enum(development, staging, production)
# @required
APP_ENV=development
`;
const VARLOCK_GITIGNORE_HEADING = "# Varlock";
const VARLOCK_GITIGNORE_COMMENTS = [
  "# Varlock recommends committing non-local .env.* files.",
  "# Review broader existing ignore rules before opting into that convention.",
];
const VARLOCK_GITIGNORE_LINES = ["!.env.schema", ".env.local", ".env.*.local"];
const VARLOCK_POINTER =
  "Review .env.schema and existing .gitignore rules. Varlock recommends committing non-local .env.* files while keeping .env.local and .env.*.local private.";

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

/**
 * Whether apply delegates to Vite+, both for the development dependency
 * install (ADR-0012) and for the checks the generated `quality` script runs
 * (ADR-0013): the project is managed, or it has no manifest of its own and the
 * nearest ancestor that decides is managed, as in a new workspace member of a
 * Vite+ workspace. The second case keeps ADR-0001's `unknown` verdict for
 * reporting, and only keeps the install away from the package manager on
 * `PATH` (ADR-0012, Decision 1).
 *
 * @param {VitePlusDetection} detection
 */
function delegatesToVitePlus(detection) {
  return (
    detection.status === "managed" ||
    (detection.status === "unknown" && detection.ancestor?.status === "managed")
  );
}

/**
 * The member globs of the workspace whose root is `directory`, as the package
 * manager in use reads them, or nothing when `directory` is not a workspace
 * root. pnpm reads only `packages` in `pnpm-workspace.yaml`, and warns that it
 * does not support the `package.json` field. npm, Yarn, and Bun read
 * `workspaces` in `package.json`, as an array or as an object whose `packages`
 * is an array. An empty list does not make a workspace root, nor does a
 * `pnpm-workspace.yaml` that only holds catalogs, as `vp create vite:library`
 * writes. A missing or unparseable `pnpm-workspace.yaml` counts as absent, as
 * a missing file does in Vite+ detection (ADR-0013, Decision 4).
 *
 * @param {string} directory
 * @param {PackageJSON | undefined} packageJSON
 * @param {PackageManager} packageManager
 * @returns {Promise<string[] | undefined>}
 */
async function workspacePackagePatterns(directory, packageJSON, packageManager) {
  /** @type {unknown} */
  let listed;

  if (packageManager === "pnpm") {
    try {
      listed = parseYAML(await readFile(join(directory, "pnpm-workspace.yaml"), "utf8"))?.packages;
    } catch {
      return undefined;
    }
  } else {
    const workspaces = packageJSON?.workspaces;
    listed = Array.isArray(workspaces) ? workspaces : workspaces?.packages;
  }

  const patterns = Array.isArray(listed)
    ? listed.filter((pattern) => typeof pattern === "string" && pattern.trim() !== "")
    : [];
  return patterns.length > 0 ? patterns : undefined;
}

/**
 * Whether the workspace root or any member defines a `test` script, which is
 * what `vp run -r test` needs: it selects every package, including the root,
 * runs each one's `test` script, and fails with `Task "test" not found` when
 * none has one. Members are found as npm's `@npmcli/map-workspaces` and pnpm
 * find them: each pattern names directories holding a `package.json`; a
 * pattern starting with an odd number of `!` excludes directories, and a
 * leading `./` or `/` is ignored. `node_modules` is never searched. Unlike npm,
 * an exclusion applies whatever its position in the list.
 *
 * @param {string} directory
 * @param {PackageJSON | undefined} packageJSON
 * @param {string[]} patterns
 */
async function workspaceDefinesTestScript(directory, packageJSON, patterns) {
  if (typeof packageJSON?.scripts?.test === "string") {
    return true;
  }

  /** @type {string[]} */
  const included = [];
  /** @type {string[]} */
  const excluded = ["**/node_modules/**"];

  for (const pattern of patterns) {
    const negation = pattern.match(/^!+/)?.[0] ?? "";
    const cleaned = pattern
      .slice(negation.length)
      .replace(/^\.?\/+/, "")
      .replace(/\/+$/, "");
    (negation.length % 2 === 1 ? excluded : included).push(cleaned);
  }

  for await (const manifestPath of glob(
    included.map((pattern) => `${pattern}/package.json`),
    { cwd: directory, exclude: excluded },
  )) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, manifestPath), "utf8"));
      if (typeof manifest?.scripts?.test === "string") {
        return true;
      }
    } catch {
      // An unreadable member manifest defines no script vp run can run.
    }
  }

  return false;
}

/**
 * The Vite+ commands the generated `quality` script runs before Calavera's
 * own scripts when apply delegates to Vite+, `vp check` and then the tests,
 * with any Vite+ step left out and why. A workspace root runs every package's
 * `test` script with `vp run -r test`, the form the `vp create vite:monorepo`
 * template uses, and leaves the step out when no package defines `test`; any
 * other project runs `vp test --passWithNoTests`, so a project without test
 * files passes. A project apply does not delegate to Vite+ gets none
 * (ADR-0013).
 *
 * @param {VitePlusDetection} detection
 * @param {string} directory
 * @param {PackageJSON | undefined} packageJSON
 * @param {PackageManager} packageManager
 * @returns {Promise<{ steps: string[], omittedSteps: QualityStepOmission[] }>}
 */
async function vitePlusQualitySteps(detection, directory, packageJSON, packageManager) {
  if (!delegatesToVitePlus(detection)) {
    return { steps: [], omittedSteps: [] };
  }

  const patterns = await workspacePackagePatterns(directory, packageJSON, packageManager);

  if (!patterns) {
    return { steps: ["vp check", "vp test --passWithNoTests"], omittedSteps: [] };
  }

  if (await workspaceDefinesTestScript(directory, packageJSON, patterns)) {
    return { steps: ["vp check", "vp run -r test"], omittedSteps: [] };
  }

  return {
    steps: ["vp check"],
    omittedSteps: [
      {
        step: "vp run -r test",
        reason:
          'neither the workspace root nor any workspace member defines a test script, so vp run -r test would fail with Task "test" not found.',
      },
    ],
  };
}

/**
 * The commands Calavera put in the Stylelint scripts before 3.0.0, when the
 * recipe could also select Oxlint (removed in 48fb31e, CAL-012) and ESLint
 * (removed in d0a69be, CAL-015). Parts were joined with ` && ` in this order.
 * Releases 1.0.1 to 2.0.6 wrapped each part in the run-if-files helper, which
 * dd40dc3 stopped generating; 2.1.0 to 2.6.0 wrote the parts bare. The current
 * value, Stylelint alone, is the one `buildScripts` plans.
 */
const historicalLintParts = {
  lint: ["oxlint .", "eslint .", 'stylelint "**/*.{css,scss}"'],
  "lint:fix": ["oxlint --fix .", "eslint --fix .", 'stylelint "**/*.{css,scss}" --fix'],
};
const historicalLintPartLabels = ["JavaScript/TypeScript", "JavaScript/TypeScript", "CSS"];
const historicalLintPartExtensions = ["js,jsx,ts,tsx,mjs,cjs", "js,jsx,ts,tsx,mjs,cjs", "css,scss"];
const stylelintPartIndex = 2;

/**
 * The values an earlier release wrote for `script` that apply may rename:
 * each ordered selection of the historical parts that includes the Stylelint
 * part, bare and wrapped in run-if-files. A selection without Stylelint, such
 * as `eslint .`, is not renamed even though a release could have written it,
 * because a user's own script can hold the same value, and renaming it would
 * replace that script with Stylelint (ADR-0013, Decision 6).
 *
 * @param {"lint" | "lint:fix"} script
 */
function historicalLintValues(script) {
  const parts = historicalLintParts[script];
  /** @type {Set<string>} */
  const values = new Set();

  for (let selection = 1; selection < 2 ** parts.length; selection += 1) {
    const indexes = parts.map((_, index) => index).filter((index) => selection & (1 << index));
    if (!indexes.includes(stylelintPartIndex)) {
      continue;
    }
    values.add(indexes.map((index) => parts[index]).join(" && "));
    values.add(
      indexes
        .map(
          (index) =>
            `node .calavera/run-if-files.mjs "${historicalLintPartLabels[index]}" "${historicalLintPartExtensions[index]}" -- ${parts[index]}`,
        )
        .join(" && "),
    );
  }

  return values;
}

/**
 * Generated scripts whose name changed. Before ADR-0013, Calavera wrote the
 * Stylelint scripts as `lint` and `lint:fix`, and the recipe flags that
 * request them still carry those names. `inQuality` marks the script the old
 * `quality` script ran.
 *
 * @type {ReadonlyArray<ScriptRename & { from: "lint" | "lint:fix", inQuality: boolean }>}
 */
const renamedPackageScripts = Object.freeze([
  { from: "lint", to: "lint:styles", inQuality: true },
  { from: "lint:fix", to: "lint:styles:fix", inQuality: false },
]);

/**
 * How apply treats scripts under a name Calavera no longer uses, in a project
 * it applied to before. An old script is Calavera's when its value is exactly
 * the value planned under the new name or one an earlier release wrote
 * (`historicalLintValues`). Calavera's script is renamed, keeping its position,
 * unless the new name already holds a different value, which is the user's:
 * then nothing is renamed or overwritten (`blocked`). Any other old value is
 * the user's and is kept (`kept`). Only names the plan writes are considered
 * (ADR-0013, Decision 6).
 *
 * @param {Record<string, string | boolean>} packageScripts
 * @param {Record<string, string>} plannedScripts
 */
function planScriptRenames(packageScripts, plannedScripts) {
  /** @type {ScriptRename[]} */
  const renamed = [];
  /** @type {Array<ScriptRename & { inQuality: boolean }>} */
  const kept = [];
  /** @type {ScriptRename[]} */
  const blocked = [];

  for (const { from, to, inQuality } of renamedPackageScripts) {
    const value = packageScripts[from];

    if (typeof plannedScripts[to] !== "string" || typeof value !== "string") {
      continue;
    }

    if (value !== plannedScripts[to] && !historicalLintValues(from).has(value)) {
      kept.push({ from, to, inQuality });
    } else if (
      typeof packageScripts[to] === "string" &&
      packageScripts[to] !== plannedScripts[to]
    ) {
      blocked.push({ from, to });
    } else {
      renamed.push({ from, to });
    }
  }

  return { renamed, kept, blocked };
}

/**
 * The command that installs a recipe's development dependencies. When Vite+
 * manages the project, Vite+ installs them with `vp add -D`, so they are
 * installed with the package manager and version the project pins, and the
 * package manager Calavera resolved plays no part; every other project keeps
 * its package manager's own command (ADR-0012).
 *
 * @param {PackageManager} packageManager
 * @param {VitePlusDetection} detection
 * @param {string[]} dependencies
 * @returns {[string, string[]]}
 */
export function devDependencyInstallCommand(packageManager, detection, dependencies) {
  return delegatesToVitePlus(detection)
    ? ["vp", ["add", "-D", ...dependencies]]
    : packageManagerCommands[packageManager].installDev(dependencies);
}

/**
 * A command as it can be pasted into a shell. Arguments that are not plain
 * words are quoted: in single quotes on POSIX shells, where a backslash is
 * not a plain word character, and in cmd-style double quotes on Windows,
 * where it is a path separator, so a Node.js path under `Program Files` stays
 * one argument (ADR-0012, Open questions).
 *
 * @param {[string, string[]]} command
 * @param {NodeJS.Platform} [platform]
 */
export function formatCommand([command, commandArgs], platform = process.platform) {
  const plainWord = platform === "win32" ? /^[\w@%+=:,./\\-]+$/ : /^[\w@%+=:,./-]+$/;

  return [command, ...commandArgs]
    .map((part) => {
      if (plainWord.test(part)) {
        return part;
      }

      return platform === "win32"
        ? `"${part.replaceAll('"', '\\"')}"`
        : `'${part.replaceAll("'", "'\\''")}'`;
    })
    .join(" ");
}

const FAILURE_OUTPUT_LINES = 10;
const FAILURE_OUTPUT_LINE_LENGTH = 300;

/**
 * How a spawned command failed, so a Calavera error is diagnosable without
 * its `cause`: the exit code, the signal, or why it could not start, and the
 * last lines of the standard output Calavera captured, at most
 * FAILURE_OUTPUT_LINES lines of at most FAILURE_OUTPUT_LINE_LENGTH characters
 * each. Standard error is inherited, so the terminal already shows it. The
 * output is not redacted; redaction is tracked in #619.
 *
 * @param {unknown} error
 */
export function describeCommandFailure(error) {
  const failure = isPlainObject(error) ? error : {};
  let outcome;

  if (typeof failure.exitCode === "number") {
    outcome = `It exited with code ${failure.exitCode}.`;
  } else if (typeof failure.signal === "string") {
    outcome = `It was terminated by signal ${failure.signal}.`;
  } else {
    const reason = isNotEmptyString(failure.code)
      ? failure.code
      : error instanceof Error
        ? error.message
        : String(error);
    outcome = `It could not start: ${reason}.`;
  }

  const output =
    typeof failure.stdout === "string"
      ? stripVTControlCharacters(failure.stdout)
          .trim()
          .split("\n")
          .slice(-FAILURE_OUTPUT_LINES)
          .map((line) =>
            line.length > FAILURE_OUTPUT_LINE_LENGTH
              ? `${line.slice(0, FAILURE_OUTPUT_LINE_LENGTH)}… [line truncated]`
              : line,
          )
          .join("\n")
      : "";

  return output ? `${outcome}\nIts last output:\n${output}` : outcome;
}

/**
 * Locates the `vp` bin of the vite-plus package the project itself resolves,
 * the way Node.js resolves any dependency: from the project directory's own
 * `node_modules`, then each ancestor's, so a workspace member finds a
 * vite-plus installed at the workspace root. The bin is started with the
 * running Node.js, so neither `PATH` nor a Windows `.cmd` shim is involved,
 * and a globally installed `vp` of another version is never used
 * (ADR-0012, Decision 2). Each way this can fail has its own message.
 *
 * @param {string} projectDirectory
 * @returns {Promise<string>}
 */
async function resolveProjectVpBin(projectDirectory) {
  let manifestPath;

  try {
    manifestPath = createRequire(join(projectDirectory, "package.json")).resolve(
      "vite-plus/package.json",
    );
  } catch (error) {
    const code = isPlainObject(error) ? error.code : undefined;

    if (code === "MODULE_NOT_FOUND") {
      throw new Error(
        `vite-plus is not installed: no node_modules/vite-plus was found in ${projectDirectory} or any ancestor directory`,
        { cause: error },
      );
    }

    if (code === "ERR_PACKAGE_PATH_NOT_EXPORTED") {
      throw new Error(
        "the installed vite-plus does not export ./package.json, so its vp bin cannot be located",
        { cause: error },
      );
    }

    throw new Error(
      `vite-plus could not be resolved from ${projectDirectory} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  let manifest;

  try {
    manifest = await readJSON(manifestPath);
  } catch (error) {
    throw new Error(`${manifestPath} could not be read`, { cause: error });
  }

  const bins = isPlainObject(manifest) ? manifest.bin : undefined;
  const bin = isPlainObject(bins) ? bins.vp : undefined;

  if (!isNotEmptyString(bin)) {
    throw new Error(`${manifestPath} does not declare a vp bin in its bin field`);
  }

  const packageDirectory = dirname(manifestPath);
  const binPath = resolve(packageDirectory, bin);
  const fromPackage = relative(packageDirectory, binPath);

  if (
    fromPackage === "" ||
    fromPackage === ".." ||
    fromPackage.startsWith(`..${sep}`) ||
    isAbsolute(fromPackage)
  ) {
    throw new Error(`${manifestPath} declares a vp bin outside the vite-plus package: ${bin}`);
  }

  if (!(await fileExists(binPath))) {
    throw new Error(
      `${manifestPath} declares the vp bin ${bin}, but ${binPath} does not exist, so the vite-plus installation is incomplete`,
    );
  }

  return binPath;
}

/**
 * The install apply runs, decided once from one detection made before
 * anything is written, so a dry run and the apply that follows it always name
 * the same command. `spawn` is what apply starts: for `vp`, the project's own
 * vp bin started with the running Node.js; for any other command, that
 * command from `PATH`, as before. When the project's vite-plus cannot be
 * located, `spawn` is undefined and `problem` says why.
 *
 * @param {PackageManager} packageManager
 * @param {VitePlusDetection} detection
 * @param {string[]} dependencies
 * @param {string} projectDirectory
 * @param {{ explicitPackageManager: boolean }} options
 */
async function planDevDependencyInstall(
  packageManager,
  detection,
  dependencies,
  projectDirectory,
  { explicitPackageManager },
) {
  const command = devDependencyInstallCommand(packageManager, detection, dependencies);
  /** @type {string[]} */
  const notes = [];

  if (command[0] !== "vp") {
    return { command, spawn: command, problem: undefined, notes };
  }

  if (explicitPackageManager) {
    notes.push(
      `The package manager given to Calavera (${packageManager}) does not change this command: Vite+ installs with the package manager the project pins.`,
    );
  }

  if (detection.status === "unknown") {
    notes.push(
      `This directory has no package.json; apply creates one with ${formatCommand(packageManagerCommands[packageManager].init)}.`,
    );
  }

  try {
    const vpBin = await resolveProjectVpBin(projectDirectory);
    /** @type {[string, string[]]} */
    const spawn = [process.execPath, [vpBin, ...command[1]]];
    notes.push(
      `Vite+ runs this with the package manager the project pins; apply runs it as: ${formatCommand(spawn)}`,
    );
    return { command, spawn, problem: undefined, notes };
  } catch (error) {
    const problem = new Error(
      `Vite+ manages this project, so Calavera installs development dependencies with the project's own vp add, but ${error instanceof Error ? error.message : String(error)}. Install the project's dependencies, then run apply again; or run apply with --no-install and add these development dependencies yourself: ${dependencies.join(", ")}. Calavera stopped before writing anything.`,
      { cause: error },
    );
    notes.push(`Apply with the install stops before writing anything: ${problem.message}`);
    return { command, spawn: undefined, problem, notes };
  }
}

/** @type {PackageManager[]} */
const supportedPackageManagers = /** @type {PackageManager[]} */ (
  Object.keys(packageManagerCommands)
);
/** @type {McpHarness[]} */
const supportedMcpHarnesses = ["claude-code", "codex", "cursor", "opencode", "skip"];
const supportedProfiles = profileIdsForRecipe();
const recipePackageManagers = packageManagerIdsForRecipe();
const args = process.argv.slice(2);
/** @type {import("node:util").ParseArgsOptionsConfig} */
const cliParseOptions = {
  config: { type: "string" },
  apply: { type: "boolean" },
  "dry-run": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  init: { type: "boolean" },
  json: { type: "boolean" },
  "agents-md": { type: "string" },
  "mcp-harness": { type: "string" },
  "no-install": { type: "boolean" },
  yes: { type: "boolean" },
  "package-manager": { type: "string" },
  profile: { type: "string" },
  integration: { type: "string", multiple: true, default: [] },
  integrations: { type: "string", multiple: true, default: [] },
  tool: { type: "string", multiple: true, default: [] },
  tools: { type: "string", multiple: true, default: [] },
  "ai-artifact": { type: "string", multiple: true, default: [] },
  "ai-artifacts": { type: "string", multiple: true, default: [] },
  "reown-managed-file": { type: "string", multiple: true, default: [] },
  "reown-managed-files": { type: "string", multiple: true, default: [] },
  tag: { type: "string", default: "latest" },
  all: { type: "boolean" },
  "check-updates": { type: "boolean" },
};

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function listFlagValues(value) {
  return (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * @param {unknown[]} values
 * @returns {string[]}
 */
function collectListValues(...values) {
  return values.flatMap((value) =>
    Array.isArray(value)
      ? value.flatMap((item) => (typeof item === "string" ? listFlagValues(item) : []))
      : typeof value === "string"
        ? listFlagValues(value)
        : [],
  );
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function optionalStringValue(value) {
  return typeof value === "string" ? value : undefined;
}

/**
 * @param {string} value
 * @returns {{ id: string, target?: string }}
 */
function parseAiArtifactFlag(value) {
  const separatorIndex = value.indexOf("@");

  if (separatorIndex <= 0 || separatorIndex === value.length - 1) {
    return { id: value };
  }

  return {
    id: value.slice(0, separatorIndex),
    target: value.slice(separatorIndex + 1),
  };
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
    throw new Error(
      `Invalid package manager: ${packageManager ?? "<missing>"}. Allowed values: ${supportedPackageManagers.join(", ")}.`,
    );
  }

  return /** @type {PackageManager} */ (packageManager);
}

/**
 * @param {string | undefined} harness
 * @returns {McpHarness}
 */
function assertSupportedMcpHarness(harness) {
  if (!harness || !supportedMcpHarnesses.includes(/** @type {McpHarness} */ (harness))) {
    throw new Error(
      `Invalid MCP harness: ${harness ?? "<missing>"}. Allowed values: ${supportedMcpHarnesses.join(", ")}.`,
    );
  }

  return /** @type {McpHarness} */ (harness);
}

/**
 * @param {string[]} rawArgs
 * @returns {CliOptions}
 */
export function parseArgs(rawArgs) {
  // `--new` ends Calavera's own arguments (ADR-0010). The split happens before
  // `--` tokens are removed, so a `--` meant for `vp create` survives.
  const newIndex = rawArgs.findIndex((arg) => arg.trim() === "--new");
  const ownArgs = newIndex === -1 ? rawArgs : rawArgs.slice(0, newIndex);
  const args = ownArgs.filter((arg) => arg.trim() !== "--");
  const { values, positionals } = parseNodeArgs({
    args,
    options: cliParseOptions,
    allowPositionals: true,
  });
  const profile = optionalStringValue(values.profile);
  const packageManager = optionalStringValue(values["package-manager"]);
  const agentsMd = optionalStringValue(values["agents-md"]);
  const mcpHarness = optionalStringValue(values["mcp-harness"]);
  const artifactTag = optionalStringValue(values.tag) ?? "latest";
  assertKnownValue("tag", artifactTag, ["latest", "next"]);
  /** @type {CliOptions} */
  const parsed = {
    command: values.help
      ? "help"
      : newIndex !== -1
        ? "new"
        : values.init
          ? "agent-init"
          : (positionals[0] ?? "init"),
    config: optionalStringValue(values.config) ?? CONFIG_FILE,
    dryRun: values["dry-run"] === true,
    json: values.json === true,
    noInstall: values["no-install"] === true,
    assumeYes: values.yes === true,
    apply: values.apply === true,
    integrations: collectListValues(
      values.integration,
      values.integrations,
      values.tool,
      values.tools,
    ),
    aiArtifacts: collectListValues(values["ai-artifact"], values["ai-artifacts"]).map(
      parseAiArtifactFlag,
    ),
    reownManagedFiles: collectListValues(
      values["reown-managed-file"],
      values["reown-managed-files"],
    ),
    artifactAction: positionals[1],
    artifactId: positionals[2],
    artifactTag: /** @type {"latest" | "next"} */ (artifactTag),
    artifactAll: values.all === true,
    checkUpdates: values["check-updates"] === true,
    init: values.init === true,
  };

  if (newIndex !== -1) {
    parsed.newArgs = rawArgs.slice(newIndex + 1);

    const newConfig = optionalStringValue(values.config);

    if (newConfig !== undefined) {
      parsed.newConfig = newConfig;
    }
  }

  if (profile !== undefined) {
    assertKnownProfile(profile);
    parsed.profile = profile;
  }

  if (packageManager !== undefined) {
    parsed.packageManager = assertSupportedPackageManager(packageManager);
  }

  if (agentsMd !== undefined) {
    assertKnownValue("agents-md", agentsMd, ["append", "fallback"]);
    parsed.agentsMd = /** @type {"append" | "fallback"} */ (agentsMd);
  }

  if (mcpHarness !== undefined) {
    parsed.mcpHarness = assertSupportedMcpHarness(mcpHarness);
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
 * @param {PackageJSON} [packageJSON]
 * @returns {PackageManager | undefined}
 */
function detectPackageManager(packageJSON = {}) {
  if (packageJSON.packageManager?.startsWith("npm")) {
    return "npm";
  }

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

  if (packageManagerLockfiles.pnpm.some((path) => existsSync(path))) {
    return "pnpm";
  }

  if (packageManagerLockfiles.yarn.some((path) => existsSync(path))) {
    return "yarn";
  }

  if (packageManagerLockfiles.bun.some((path) => existsSync(path))) {
    return "bun";
  }

  if (packageManagerLockfiles.npm.some((path) => existsSync(path))) {
    return "npm";
  }

  return undefined;
}

/**
 * @param {Recipe} recipe
 * @param {Partial<CliOptions>} applyOptions
 * @param {PackageJSON} packageJSON
 * @returns {PackageManager}
 */
function resolveApplyPackageManager(recipe, applyOptions, packageJSON) {
  const packageManager =
    applyOptions.packageManager ?? detectPackageManager(packageJSON) ?? recipe.packageManager;

  if (packageManager) {
    return assertSupportedPackageManager(packageManager);
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

    try {
      await execa(command, commandArgs, { stderr: "inherit" });
    } catch (error) {
      // A spinner left running keeps its timer alive, and the process never exits.
      spin?.error("Could not create package.json");
      throw new Error(
        `Calavera could not create package.json with ${formatCommand([command, commandArgs])}, so it stopped before applying the recipe. ${describeCommandFailure(error)}`,
        { cause: error },
      );
    }

    spin?.stop("Created package.json");
  }

  return dryRun ? { scripts: {} } : /** @type {Promise<PackageJSON>} */ (readJSON(packageJSONPath));
}

/**
 * @param {Recipe} recipe
 * @param {Integration[]} integrations
 * @param {PackageManager} packageManager
 * @param {{ steps: string[], omittedSteps: QualityStepOmission[] }} vitePlusQuality the Vite+ commands `quality` runs first, and those left out, from `vitePlusQualitySteps`
 * @returns {ScriptPlan}
 */
function buildScripts(recipe, integrations, packageManager, vitePlusQuality) {
  const supportedPackageManager = assertSupportedPackageManager(packageManager);
  /** @param {string} id */
  const has = (id) => integrations.some((integration) => integration.id === id);
  const usesStylelint = has("stylelint");
  const usesReactDoctor = has("react-doctor");
  const usesKnip = has("knip");
  const usesHtmlValidate = has("html-validate");
  const usesVarlock = has("varlock");
  const usesGithubRepositoryControls = has(GITHUB_REPOSITORY_CONTROLS_ID);

  const lintParts = [usesStylelint ? 'stylelint "**/*.{css,scss}"' : null].filter(Boolean);

  const lintFixParts = [usesStylelint ? 'stylelint "**/*.{css,scss}" --fix' : null].filter(Boolean);

  /** @type {Record<string, string>} */
  const scripts = {};
  /** @type {ScriptOmission[]} */
  const omittedScripts = [];
  /** @type {QualityStepOmission[]} */
  const omittedQualitySteps = [];

  if (recipe.scripts?.lint && lintParts.length > 0) {
    scripts["lint:styles"] = lintParts.join(" && ");
  } else if (recipe.scripts?.lint) {
    omittedScripts.push({
      script: "lint:styles",
      reason:
        "lint:styles was requested by the recipe's lint flag, but no CSS linting integration is selected.",
    });
  }

  if (recipe.scripts?.["lint:fix"] && lintFixParts.length > 0) {
    scripts["lint:styles:fix"] = lintFixParts.join(" && ");
  } else if (recipe.scripts?.["lint:fix"]) {
    omittedScripts.push({
      script: "lint:styles:fix",
      reason:
        "lint:styles:fix was requested by the recipe's lint:fix flag, but no fix-capable CSS linting integration is selected.",
    });
  }

  if (usesReactDoctor) {
    scripts["react:doctor"] = "react-doctor --offline";
    scripts["react:doctor:diff"] = "react-doctor --offline --diff";
  }

  if (usesKnip) {
    scripts.knip = "knip";
  }

  if (usesHtmlValidate) {
    scripts["lint:html"] = 'html-validate "**/*.html"';
  }

  if (usesVarlock) {
    scripts["env:load"] = "varlock load";
  }

  if (usesGithubRepositoryControls) {
    scripts["repo:controls:check"] = "node scripts/repository-controls.mjs";
    scripts["repo:controls:apply"] = "node scripts/repository-controls.mjs --apply";
  }

  if (recipe.scripts?.quality) {
    const qualityScripts = [
      "lint:styles",
      usesHtmlValidate ? "lint:html" : null,
      usesKnip ? "knip" : null,
      usesReactDoctor ? "react:doctor" : null,
      usesVarlock ? "env:load" : null,
    ]
      .filter(isNotEmptyString)
      .filter((script) => Boolean(scripts[script]));

    // Without a Calavera script to aggregate, quality would only repeat Vite+
    // commands, so it is omitted as before (ADR-0013).
    if (qualityScripts.length > 0) {
      scripts.quality = [
        ...vitePlusQuality.steps,
        ...qualityScripts.map((script) =>
          packageManagerCommands[supportedPackageManager].run(script),
        ),
      ].join(" && ");
      omittedQualitySteps.push(...vitePlusQuality.omittedSteps);
    } else {
      omittedScripts.push({
        script: "quality",
        reason: "quality was requested but no generated scripts are available to aggregate.",
      });
    }
  }

  return { scripts, omittedScripts, omittedQualitySteps };
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

function createAgentBootstrapGuidanceBody() {
  return `# Calavera Agent Guidance

- Use Calavera when the user wants to inspect, compose, preview, apply, or update project tooling.
- Verify the Calavera MCP tools are available before composing a recipe.
- Prefer the Calavera MCP server over hand-authoring \`calavera.config.json\`.
- If the Calavera MCP tools are not available, stop and help the user register the MCP server from \`${AGENT_BOOTSTRAP_MCP_FILE}\`, then reload the agent session if the MCP host requires it.
- Do not inspect npm cache internals or import Calavera source files from a package cache as a substitute for MCP setup.
- Inspect existing project tooling before composing a recipe and raise likely config conflicts early.
- If likely conflicts exist, pause before applying changes. List each conflict as a hard stop or a migration decision the user can approve, and use \`dry_run_apply\` to show concrete impact when adoption still looks possible.
- Start with \`inspect_project\`, \`list_profiles\`, \`list_integrations\`, and \`list_ai_artifacts\`; use \`describe_integration\` when the user asks for more information or an option needs explanation.
- Compose recipes with \`compose_recipe\`, validate them with \`validate_recipe\`, and explain the selected integrations with \`explain_recipe\`.
- Always present \`dry_run_apply\` output to the user before changing files.
- Call \`apply_recipe\` only after the user explicitly approves the dry-run result.
- If the MCP transport closes or reports \`-32000\` during or immediately after \`apply_recipe\`, treat the outcome as unknown instead of failed. Inspect \`calavera.config.json\`, \`.calavera/state.json\`, generated files, and package metadata before retrying the apply.
- Treat files listed by \`dry_run_apply\` as Calavera-managed outputs. Do not hand-write or edit them; let \`apply_recipe\` or \`create-project-calavera apply\` create them after approval.
- Use AskUserTool or the agent client's equivalent when available for profile choices, conflict decisions, and apply approval.

MCP setup notes live in \`${AGENT_BOOTSTRAP_MCP_FILE}\`.
`;
}

function createAgentBootstrapGuidance() {
  return `${AGENT_BOOTSTRAP_MARKER}
${createAgentBootstrapGuidanceBody()}`;
}

function createAgentBootstrapGuidanceSection() {
  return `${AGENT_BOOTSTRAP_SECTION_START}
${createAgentBootstrapGuidanceBody().trimEnd()}
${AGENT_BOOTSTRAP_SECTION_END}
`;
}

/**
 * Runs one bin of a package through the package manager's runner. The runner
 * names both the package and the bin, because a runner given only the name of
 * a package with several bins cannot tell which one to run.
 *
 * @param {PackageManager} packageManager
 * @param {string} packageSpecifier
 * @param {string} bin
 * @returns {{ command: string, args: string[] }}
 */
function createPackageRunnerCommand(packageManager, packageSpecifier, bin) {
  switch (packageManager) {
    case "pnpm":
      return { command: "pnpm", args: ["dlx", "--package", packageSpecifier, bin] };
    case "yarn":
      return { command: "yarn", args: ["dlx", "--package", packageSpecifier, bin] };
    case "bun":
      return { command: "bunx", args: ["--package", packageSpecifier, bin] };
    default:
      return { command: "npx", args: ["--package", packageSpecifier, bin] };
  }
}

/**
 * @param {PackageManager} packageManager
 * @returns {{ command: string, args: string[] }}
 */
function createMcpLaunchCommand(packageManager) {
  return createPackageRunnerCommand(
    packageManager,
    `create-project-calavera@${packageJson.version}`,
    "create-project-calavera-mcp",
  );
}

/**
 * The command `--new` spawns, per ADR-0010 Decision 1.
 *
 * @param {PackageManager} packageManager
 * @param {string[]} forwardedArgs
 * @returns {{ command: string, args: string[] }}
 */
export function createVpCreateCommand(packageManager, forwardedArgs) {
  const runner = createPackageRunnerCommand(packageManager, "vite-plus", "vp");

  return { command: runner.command, args: [...runner.args, "create", ...forwardedArgs] };
}

/**
 * Quotes a token for display when a shell would otherwise split or expand it.
 *
 * @param {string} token
 * @returns {string}
 */
function quoteShellToken(token) {
  return /^[\w@%+=:,./^~-]+$/.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * @param {{ command: string, args: string[] }} launchCommand
 * @returns {string}
 */
function formatShellCommand(launchCommand) {
  return [launchCommand.command, ...launchCommand.args].map(quoteShellToken).join(" ");
}

function createMcpManualCommandReference() {
  return supportedPackageManagers
    .map((packageManager) => {
      const commands = projectLocalCommandCatalog[packageManager];
      return `- ${commands.label}: \`${formatShellCommand(createMcpLaunchCommand(packageManager))}\``;
    })
    .join("\n");
}

/**
 * @param {{ command: string, args: string[] }} launchCommand
 * @returns {string}
 */
function createMcpServerConfigSnippet(launchCommand) {
  return JSON.stringify(createMcpServersJsonConfig(launchCommand), null, 2);
}

/**
 * @param {PackageManager} packageManager
 * @returns {string}
 */
function createAgentBootstrapMcpInstructions(packageManager) {
  const commands = projectLocalCommandCatalog[packageManager];
  const launchCommand = createMcpLaunchCommand(packageManager);
  const mcpConfig = createMcpServerConfigSnippet(launchCommand);
  const codexConfig = createCodexMcpTomlBlock(launchCommand).trimEnd();
  const opencodeConfig = JSON.stringify(createOpenCodeMcpJsonConfig(launchCommand), null, 2);
  const shellCommand = formatShellCommand(launchCommand);
  const manualCommandReference = createMcpManualCommandReference();

  return `# Calavera MCP Setup

Calavera can configure MCP automatically during \`--init\` for one project-local
agent harness. It never writes global/user MCP config. If you skipped
auto-config or need to repair a setup manually, use the project-local target for
your harness.

This project's detected package manager is ${commands.label}; the launch command
is:

\`\`\`bash
${shellCommand}
\`\`\`

## Project-local targets

### Claude Code: \`.mcp.json\`

\`\`\`json
${mcpConfig}
\`\`\`

### Cursor: \`.cursor/mcp.json\`

\`\`\`json
${mcpConfig}
\`\`\`

### Codex: \`.codex/config.toml\`

\`\`\`toml
${codexConfig}
\`\`\`

### OpenCode: \`opencode.json\`

\`\`\`json
${opencodeConfig}
\`\`\`

Project-local MCP servers should be registered from the project root. Using the
package manager declared by the project avoids package-manager preflight
failures before Calavera can start, such as npm rejecting a Bun-managed project
through \`devEngines.packageManager\`.

When configuring an MCP server manually, choose the command that matches the
project's package manager:

${manualCommandReference}

After registration, reload or restart the agent session if your MCP host does not
discover new tools dynamically. Confirm the Calavera tools are visible before
composing a recipe.

Do not work around missing MCP tools by reading npm cache internals or importing
Calavera source files from package cache paths. That bypasses the supported MCP
setup and can use the wrong cached package version.

## Command syntax for agents

\`npm create\` uses \`--\` to forward flags to Calavera:

\`\`\`bash
npm create project-calavera -- --init
npm create project-calavera apply -- --dry-run
\`\`\`

Do not use \`npm create project-calavera --init\`; npm treats \`--init\` as its own
option and Calavera falls back to the recipe CLI.

Direct binary launchers such as \`npx --package\` and MCP server registrations
do not need an extra \`--\` before Calavera flags:

\`\`\`bash
npx --package create-project-calavera@${packageJson.version} create-project-calavera --help
${shellCommand}
\`\`\`

## Bun temp and cache directories

If a Bun-based MCP launch fails before Calavera starts with
\`error: bun is unable to write files to tempdir: PermissionDenied\`, configure
the MCP host to give that server a writable temp directory. Set \`TMPDIR\` to an
absolute path that exists and is writable by the MCP host process, such as an
absolute path to a project-local \`.calavera/tmp\` directory.

If Bun can write temp files but cannot populate its package cache, also set
\`BUN_INSTALL_CACHE_DIR\` to an absolute writable directory, such as an absolute
path to \`.calavera/bun-install-cache\`. Keep these environment overrides on Bun
MCP registrations only; they are recovery settings for restricted hosts, not
part of the default Calavera MCP config.

## Calavera MCP workflow

Use the tools in this order when they are available:

1. \`inspect_project\`
2. \`list_profiles\`
3. \`list_integrations\`
4. \`describe_integration\`
5. \`list_ai_artifacts\`
6. \`compose_recipe\`
7. \`validate_recipe\`
8. \`explain_recipe\`
9. \`dry_run_apply\`
10. \`apply_recipe\`

\`dry_run_apply\` is the review boundary. Show its inspection findings, omitted
script explanations, ownership notes, and planned file changes to the user, then
wait for explicit approval before calling \`apply_recipe\`.

\`apply_recipe.writeConfig: false\` only skips writing \`calavera.config.json\`.
Do not use it to bypass managed-file conflicts, stale state hashes, or an
unapproved dry-run result.

If the MCP transport closes or reports \`-32000\` during or immediately after
\`apply_recipe\`, treat the apply outcome as unknown instead of failed. Inspect
\`calavera.config.json\`, \`.calavera/state.json\`, generated files, and package
metadata before retrying the apply.

Before composing a recipe, call \`inspect_project\` or inspect the project for existing tooling files such as \`package.json\`, \`calavera.config.json\`, \`.editorconfig\`, and \`.stylelintrc.json\`. Mention likely conflicts or local conventions before proposing changes. If conflicts exist, say whether they are hard stops or migration decisions, then use \`dry_run_apply\` to show the impact when adoption is still possible.

If the MCP server cannot be registered, use the hosted Web UI to compose and download a recipe:

https://calavera.schalkneethling.com

Then run \`${commands.applyDryRun}\` and ask for approval before running \`${commands.applyRecipe}\`.

Suggested first prompt:

> ${AGENT_BOOTSTRAP_NEXT_PROMPT}
`;
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
    ignoreExportsUsedInFile: true,
  };
}

/**
 * @param {string} existing
 * @returns {string | undefined}
 */
function mergeVarlockGitignore(existing) {
  const existingLines = new Set(existing.split("\n").map((line) => line.trim()));
  const missingLines = VARLOCK_GITIGNORE_LINES.filter((line) => !existingLines.has(line));

  if (missingLines.length === 0) {
    return undefined;
  }

  const section = [
    existingLines.has(VARLOCK_GITIGNORE_HEADING) ? null : VARLOCK_GITIGNORE_HEADING,
    ...VARLOCK_GITIGNORE_COMMENTS.filter((line) => !existingLines.has(line)),
    ...missingLines,
  ].filter(isNotEmptyString);
  const prefix = existing.trimEnd();
  return `${prefix ? `${prefix}\n\n` : ""}${section.join("\n")}\n`;
}

/**
 * @returns {Promise<Array<{ type: "write" | "update", path: string, action: "scaffold" | "merge", contents: string }>>}
 */
async function planVarlockProjectFiles() {
  const plans = [];

  if (!(await fileExists(".env.schema"))) {
    plans.push({
      type: /** @type {const} */ ("write"),
      path: ".env.schema",
      action: /** @type {const} */ ("scaffold"),
      contents: VARLOCK_SCHEMA,
    });
  }

  const existingGitignore = (await fileExists(".gitignore"))
    ? await readFile(".gitignore", "utf8")
    : "";
  const gitignore = mergeVarlockGitignore(existingGitignore);
  if (gitignore !== undefined) {
    plans.push({
      type: /** @type {const} */ ("update"),
      path: ".gitignore",
      action: /** @type {const} */ ("merge"),
      contents: gitignore,
    });
  }

  return plans;
}

/**
 * @param {Array<{ type: "write" | "update", path: string, action: "scaffold" | "merge", contents: string }>} plans
 * @param {boolean} dryRun
 * @param {Change[]} changes
 */
async function applyVarlockProjectFiles(plans, dryRun, changes) {
  for (const plan of plans) {
    changes.push({
      type: plan.type,
      path: plan.path,
      action: plan.action,
      ownership: "project",
    });
    if (!dryRun) await writeFile(plan.path, plan.contents);
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function realpathIfPresent(path) {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * @param {string} path
 * @returns {string}
 */
function normalizeManagedFilePath(path) {
  const pathWithPlatformSeparators = path.replace(/\\/g, "/");
  const projectRoot = realpathIfPresent(resolve("."));
  const absolutePath = realpathIfPresent(resolve(pathWithPlatformSeparators));
  return relative(projectRoot, absolutePath).replace(/\\/g, "/");
}

/**
 * @param {string[]} paths
 * @returns {Set<string>}
 */
function normalizeManagedFilePathSet(paths) {
  return new Set(paths.map(normalizeManagedFilePath));
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 */
async function assertSafeManagedFileWrite(path, contents, previousState, reownManagedFiles) {
  if (!(await fileExists(path))) {
    return;
  }

  const installedContents = await readFile(path, "utf8");
  const targetHash = textHash(contents);
  const installedHash = textHash(installedContents);

  if (installedHash === targetHash) {
    return;
  }

  const stateFile = managedFileStateForPath(previousState, path);

  if (stateFile?.hash === installedHash) {
    return;
  }

  if (jsonContentsMatch(path, installedContents, contents)) {
    return;
  }

  if (stateFile && reownManagedFiles.has(normalizeManagedFilePath(path))) {
    return;
  }

  const reason = stateFile
    ? `It appears to have local edits (installed=${installedHash}, state=${stateFile.hash}).`
    : "It is not recorded as Calavera-managed.";

  throw new Error(`Refusing to overwrite existing managed file: ${path}. ${reason}`);
}

/**
 * A managed file is unchanged when its contents on disk are exactly the
 * planned contents and Calavera state records that same hash for it.
 *
 * @param {string} path
 * @param {string} contents
 * @param {CalaveraState} previousState
 * @returns {Promise<boolean>}
 */
async function managedFileUnchanged(path, contents, previousState) {
  if (!(await fileExists(path))) {
    return false;
  }

  const installedHash = textHash(await readFile(path, "utf8"));

  return (
    installedHash === textHash(contents) &&
    managedFileStateForPath(previousState, path)?.hash === installedHash
  );
}

/**
 * @param {string} path
 * @param {unknown} value
 * @returns {Promise<boolean>}
 */
async function jsonFileUnchanged(path, value) {
  if (!(await fileExists(path))) {
    return false;
  }

  return (await readFile(path, "utf8")) === `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * @param {{ path: string, contents: string }[]} filePlans
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 */
async function assertSafeManagedFileWrites(filePlans, previousState, reownManagedFiles) {
  for (const filePlan of filePlans) {
    await assertSafeManagedFileWrite(
      filePlan.path,
      filePlan.contents,
      previousState,
      reownManagedFiles,
    );
  }
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
 * @param {string} path
 * @param {string} contents
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 * @returns {Promise<ManagedFileState>}
 */
async function writeManagedFile(path, contents, dryRun, changes, previousState, reownManagedFiles) {
  const unchanged = await managedFileUnchanged(path, contents, previousState);
  changes.push({
    type: unchanged ? "unchanged" : "write",
    path,
    action: "write",
    ownership: "calavera",
  });

  const managedFile = {
    path,
    hash: textHash(contents),
  };

  if (dryRun || unchanged) {
    return managedFile;
  }

  await assertSafeManagedFileWrite(path, contents, previousState, reownManagedFiles);

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
 * @param {Set<string>} reownManagedFiles
 * @returns {Promise<ManagedFileState>}
 */
async function writeManagedJSONFile(
  path,
  value,
  dryRun,
  changes,
  previousState,
  reownManagedFiles,
) {
  return writeManagedFile(
    path,
    `${JSON.stringify(value, null, 2)}\n`,
    dryRun,
    changes,
    previousState,
    reownManagedFiles,
  );
}

/**
 * @param {Integration[]} integrations
 * @param {Record<string, unknown>} [integrationOptions]
 * @returns {{ path: string, contents: string }[]}
 */
function plannedManagedFiles(integrations, integrationOptions = {}) {
  const plans = [];

  if (integrations.some((integration) => integration.id === "editorconfig")) {
    plans.push({ path: ".editorconfig", contents: createEditorConfig() });
  }

  if (integrations.some((integration) => integration.id === "stylelint")) {
    plans.push({
      path: ".stylelintrc.json",
      contents: `${JSON.stringify(createStylelintConfig(integrations, integrationOptions), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "html-validate")) {
    plans.push({
      path: ".htmlvalidate.json",
      contents: `${JSON.stringify(createHtmlValidateConfig(integrations), null, 2)}\n`,
    });
    plans.push({ path: ".htmlvalidateignore", contents: HTML_VALIDATE_IGNORE });
  }

  if (integrations.some((integration) => integration.id === "react-doctor")) {
    plans.push({
      path: "react-doctor.config.json",
      contents: `${JSON.stringify(createReactDoctorConfig(), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === "knip")) {
    plans.push({
      path: "knip.json",
      contents: `${JSON.stringify(createKnipConfig(), null, 2)}\n`,
    });
  }

  if (integrations.some((integration) => integration.id === GITHUB_REPOSITORY_CONTROLS_ID)) {
    plans.push(
      ...githubRepositoryControlManagedFiles(integrationOptions[GITHUB_REPOSITORY_CONTROLS_ID]),
    );
  }

  return plans;
}

/**
 * @param {string} path
 * @returns {Promise<boolean>}
 */
async function projectFileExists(path) {
  return fileExists(resolve(path));
}

/**
 * Whether Calavera state records `path` with the hash of its contents on
 * disk, which makes it Calavera's own file rather than an existing config.
 *
 * @param {string} path
 * @param {CalaveraState} previousState
 * @returns {Promise<boolean>}
 */
async function managedFileMatchesState(path, previousState) {
  const stateFile = managedFileStateForPath(previousState, path);

  return stateFile !== undefined && stateFile.hash === textHash(await readFile(path, "utf8"));
}

/**
 * @param {{ path: string, contents: string }} filePlan
 * @param {CalaveraState} previousState
 * @param {Set<string>} reownManagedFiles
 * @returns {Promise<ProjectInspectionFinding | undefined>}
 */
async function inspectManagedFilePlan(filePlan, previousState, reownManagedFiles) {
  if (!(await projectFileExists(filePlan.path))) {
    return undefined;
  }

  const targetHash = textHash(filePlan.contents);
  const installedContents = await readFile(filePlan.path, "utf8");
  const installedHash = textHash(installedContents);

  if (installedHash === targetHash) {
    return undefined;
  }

  const stateFile = managedFileStateForPath(previousState, filePlan.path);

  if (stateFile?.hash === installedHash) {
    return undefined;
  }

  if (jsonContentsMatch(filePlan.path, installedContents, filePlan.contents)) {
    return undefined;
  }

  if (stateFile && reownManagedFiles.has(normalizeManagedFilePath(filePlan.path))) {
    return {
      severity: "warning",
      kind: "managed-file-reown",
      path: filePlan.path,
      message: `${filePlan.path} has local edits relative to Calavera state; this run will treat the current contents as an approved managed-file baseline before applying the recipe.`,
    };
  }

  return {
    severity: "error",
    kind: "managed-file-conflict",
    path: filePlan.path,
    message: `${filePlan.path} already exists and is not a matching Calavera-managed file; review, remove, or migrate it before applying this recipe.`,
  };
}

/**
 * Builds the `inspect_project` findings for a Vite+ detection result, per
 * ADR-0001's "What inspect_project reports" section.
 *
 * @param {VitePlusDetection} detection
 * @returns {ProjectInspectionFinding[]}
 */
function vitePlusFindings(detection) {
  if (detection.status === "managed") {
    const corroborationSuffix =
      detection.corroborating.length > 0
        ? ` Corroborating signals: ${detection.corroborating.join(", ")}.`
        : "";

    return [
      {
        severity: "info",
        kind: "vite-plus-managed",
        path: detection.manifestPath,
        message: `This project is managed by Vite+, matched via the ${detection.signal} signal at ${detection.manifestPath}.${corroborationSuffix}`,
      },
    ];
  }

  if (detection.status === "unmanaged") {
    /** @type {ProjectInspectionFinding[]} */
    const findings = [
      {
        severity: "info",
        kind: "vite-plus-unmanaged",
        message:
          "This project is not managed by Vite+; no vite-plus dependency was found in this manifest or any ancestor manifest.",
      },
    ];

    if (detection.corroborating.length > 0) {
      findings.push({
        severity: "warning",
        kind: "vite-plus-signal-conflict",
        message: `The project is unmanaged by Vite+, but the following corroborating signals were found: ${detection.corroborating.join(", ")}; confirm whether the vite-plus dependency was removed intentionally.`,
      });
    }

    return findings;
  }

  const ancestorSuffix = detection.ancestor
    ? ` The nearest ancestor manifest, ${detection.ancestor.manifestPath}, is ${detection.ancestor.status}.`
    : "";

  return [
    {
      severity: "warning",
      kind: "vite-plus-detection-unknown",
      path: "package.json",
      message: `package.json could not be read, so Vite+ management could not be determined.${ancestorSuffix}`,
    },
  ];
}

const VITE_PLUS_PROVIDES_STATEMENT =
  "JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera.";
const VITE_PLUS_UNMANAGED_STATEMENT =
  "Calavera provides no JavaScript or TypeScript toolchain; run vp create or vp migrate to adopt Vite+.";

/**
 * Builds the Vite+ report that `explain_recipe`, `compose_recipe`, and
 * `dry_run_apply` carry, per ADR-0011. The first line states the ADR-0001
 * detection status; a managed project also gets the statement of what Vite+
 * provides instead of Calavera.
 *
 * @param {VitePlusDetection} detection
 * @returns {VitePlusReport}
 */
export function vitePlusReport(detection) {
  const signalConflict = detection.status === "unmanaged" && detection.corroborating.length > 0;

  if (detection.status === "managed") {
    return {
      status: detection.status,
      signalConflict,
      lines: [
        `Vite+ detection: managed. This project is vp-managed (${detection.signal} signal at ${detection.manifestPath}).`,
        VITE_PLUS_PROVIDES_STATEMENT,
      ],
    };
  }

  if (detection.status === "unmanaged") {
    return {
      status: detection.status,
      signalConflict,
      lines: [
        "Vite+ detection: unmanaged. No vite-plus dependency was found in this manifest or any ancestor manifest.",
        ...(signalConflict
          ? [
              `Vite+ signal conflict: found ${detection.corroborating.join(", ")} without a vite-plus dependency; confirm whether the vite-plus dependency was removed intentionally.`,
            ]
          : []),
        VITE_PLUS_UNMANAGED_STATEMENT,
      ],
    };
  }

  const ancestorSuffix = detection.ancestor
    ? ` The nearest ancestor manifest, ${detection.ancestor.manifestPath}, is ${detection.ancestor.status}.`
    : "";

  return {
    status: detection.status,
    signalConflict,
    lines: [
      `Vite+ detection: unknown. package.json could not be read, so Vite+ management could not be determined.${ancestorSuffix}`,
    ],
  };
}

/**
 * Detects Vite+ management for the current working directory and returns the
 * ADR-0011 report.
 *
 * @returns {Promise<VitePlusReport>}
 */
export async function reportVitePlus() {
  return vitePlusReport(await detectVitePlus(process.cwd()));
}

/**
 * @param {Recipe} [recipe]
 * @param {ProjectInspectionOptions} [options]
 * @returns {Promise<ProjectInspection>}
 */
export async function inspectProject(recipe, options = {}) {
  /** @type {PackageJSON} */
  let packageJSON = {};
  /** @type {ProjectInspectionFinding | undefined} */
  let unparseableManifest;

  try {
    packageJSON = await readPackageJSONIfPresent();

    if (!isPlainObject(packageJSON)) {
      throw new SyntaxError("package.json must contain a JSON object");
    }
  } catch (error) {
    // Inspection is read-only, so a broken manifest becomes a finding. Apply
    // still stops on it. The cause stays in the message for diagnosis.
    if (!(error instanceof SyntaxError)) {
      throw error;
    }

    packageJSON = {};
    unparseableManifest = {
      severity: "error",
      kind: "package-json-unparseable",
      path: "package.json",
      message: `package.json could not be parsed: ${error.message}. Findings that depend on its contents are omitted until it is fixed.`,
    };
  }

  const previousState = await readStateIfPresent();
  const reownManagedFiles = normalizeManagedFilePathSet(options.reownManagedFiles ?? []);
  const packageManager = unparseableManifest ? undefined : detectPackageManager(packageJSON);
  const integrations = recipe ? resolveRecipeIntegrations(recipe) : [];
  const integrationIds = new Set(integrations.map((integration) => integration.id));
  /** @type {string[]} */
  const files = [];
  /** @type {ProjectInspectionFinding[]} */
  const findings = unparseableManifest ? [unparseableManifest] : [];

  for (const path of projectInspectionFiles) {
    if (await projectFileExists(path)) {
      files.push(path);
    }
  }

  if (packageManager) {
    findings.push({
      severity: "info",
      kind: "package-manager",
      message: `Detected ${packageManager} as the project package manager.`,
    });
  }

  const vitePlus = await detectVitePlus(process.cwd());
  findings.push(...vitePlusFindings(vitePlus));

  const presentLockfiles = Object.values(packageManagerLockfiles)
    .flat()
    .filter((path) => files.includes(path));

  if (presentLockfiles.length > 1) {
    findings.push({
      severity: "warning",
      kind: "multiple-lockfiles",
      message: `Multiple package-manager lockfiles are present: ${presentLockfiles.join(", ")}. Confirm which package manager owns installs before applying.`,
    });
  }

  if (recipe?.packageManager && packageManager && recipe.packageManager !== packageManager) {
    findings.push({
      severity: "warning",
      kind: "package-manager-mismatch",
      path: "package.json",
      message: `The recipe uses ${recipe.packageManager}, but project inspection detected ${packageManager}; this is a migration decision that should be approved before applying.`,
    });
  }

  const packageScripts = packageJSON.scripts ?? {};
  // Only the values of the scripts compared below are read from this plan, and
  // none of them depends on the Vite+ steps of quality, so none are planned.
  const plannedScripts =
    recipe && !unparseableManifest && (await fileExists(STATE_FILE))
      ? buildScripts(recipe, integrations, resolveApplyPackageManager(recipe, {}, packageJSON), {
          steps: [],
          omittedSteps: [],
        }).scripts
      : {};
  // plannedScripts is empty before the first apply, so nothing is renamed then.
  const scriptRenames = planScriptRenames(packageScripts, plannedScripts);
  const blockedNames = new Set(scriptRenames.blocked.map(({ to }) => to));
  for (const scriptName of [
    "lint:styles",
    "lint:styles:fix",
    "repo:controls:check",
    "repo:controls:apply",
  ]) {
    // The recipe flag that requests a Stylelint script keeps the old name.
    const flag = renamedPackageScripts.find(({ to }) => to === scriptName)?.from;
    const managedByRecipe = scriptName.startsWith("repo:controls:")
      ? integrationIds.has(GITHUB_REPOSITORY_CONTROLS_ID)
      : flag && recipe?.scripts?.[flag];
    // After an apply, a script that already has the value this recipe sets
    // is Calavera's own and is not replaced. A blocked rename is reported
    // below, and apply does not replace that script either.
    if (
      managedByRecipe &&
      !blockedNames.has(scriptName) &&
      typeof packageScripts[scriptName] === "string" &&
      packageScripts[scriptName] !== plannedScripts[scriptName]
    ) {
      findings.push({
        severity: "warning",
        kind: "existing-package-script",
        path: "package.json",
        message: `package.json already defines "${scriptName}"; Calavera will replace that script if this recipe is applied.`,
      });
    }
  }

  // ADR-0013, Decision 6: a script under a name Calavera no longer uses.
  for (const { from, to, inQuality } of scriptRenames.kept) {
    findings.push({
      severity: "warning",
      kind: "legacy-package-script",
      path: "package.json",
      message: `package.json defines "${from}", the name Calavera used for this recipe's Stylelint script before it became "${to}". Its value matches no value Calavera wrote for "${from}", so Calavera keeps "${from}" as your own script and writes "${to}" beside it.${
        inQuality && typeof plannedScripts.quality === "string"
          ? ` The generated quality script now runs "${to}" instead of "${from}", so your "${from}" no longer runs as part of quality.`
          : ""
      }`,
    });
  }
  for (const { from, to } of scriptRenames.blocked) {
    findings.push({
      severity: "warning",
      kind: "legacy-package-script-conflict",
      path: "package.json",
      message: `package.json defines "${from}" with a value Calavera wrote, and "${to}" with a value of your own. Calavera does not rename "${from}" to "${to}", because that would overwrite your "${to}"; it keeps both scripts as they are. Until then, the generated quality script runs your "${to}". Rename or remove your "${to}" and apply again to complete the rename.`,
    });
  }

  for (const filePlan of plannedManagedFiles(integrations, recipe?.integrationOptions)) {
    const finding = await inspectManagedFilePlan(filePlan, previousState, reownManagedFiles);

    if (finding) {
      findings.push(finding);
    }
  }

  for (const [integrationId, paths] of Object.entries(integrationConfigFiles)) {
    if (!integrationIds.has(integrationId)) {
      continue;
    }

    for (const path of paths) {
      if (files.includes(path) && !(await managedFileMatchesState(path, previousState))) {
        findings.push({
          severity: "warning",
          kind: "existing-config",
          path,
          message: `${path} already exists; adopting the ${integrationId} integration may be a migration decision rather than a clean scaffold.`,
        });
      }
    }
  }

  return {
    packageManager,
    files,
    findings,
    vitePlus,
  };
}

/**
 * @param {CliOptions} options
 * @returns {Promise<ApplyResult>}
 */
export async function applyRecipe(options) {
  const configPath = resolve(options.config);
  const recipe = await readRecipe(configPath);
  return applyRecipeObject(recipe, options);
}

/**
 * @param {Recipe} recipe
 * @param {Partial<CliOptions>} options
 * @param {ArtifactServices} [artifactServices] Registry access for artifacts that are not yet locked.
 * @returns {Promise<ApplyResult>}
 */
export async function applyRecipeObject(recipe, options = {}, artifactServices = {}) {
  validateRecipe(recipe);

  const applyOptions = {
    dryRun: false,
    json: false,
    noInstall: false,
    assumeYes: false,
    reownManagedFiles: [],
    ...options,
  };
  const previousState = await readStateIfPresent();
  // Only a project Calavera already applied to can have a config or scripts
  // that are unchanged; on a first apply the whole plan is new.
  const previouslyApplied = await fileExists(STATE_FILE);
  const reownManagedFiles = normalizeManagedFilePathSet(applyOptions.reownManagedFiles ?? []);
  const integrations = resolveRecipeIntegrations(recipe);
  const dependencyList = unique(
    integrations.flatMap((integration) => integration.dependencies ?? []),
  );
  const detectedPackageJSON = await readPackageJSONIfPresent();
  const packageManager = resolveApplyPackageManager(recipe, applyOptions, detectedPackageJSON);
  assertRootOnlyIntegrationsAtRepositoryRoot(integrations, process.cwd(), packageManager);
  // The install and the quality script are planned before anything is
  // written, including package.json, from one detection, so the dry run and
  // the apply that follows it name the same command and write the same
  // script, and a project whose vite-plus cannot be located stops here.
  const vitePlusDetection = await detectVitePlus(process.cwd());
  const vitePlusQuality = await vitePlusQualitySteps(
    vitePlusDetection,
    process.cwd(),
    detectedPackageJSON,
    packageManager,
  );
  const installPlan =
    dependencyList.length > 0 && !(applyOptions.noInstall && !applyOptions.dryRun)
      ? await planDevDependencyInstall(
          packageManager,
          vitePlusDetection,
          dependencyList,
          process.cwd(),
          { explicitPackageManager: applyOptions.packageManager !== undefined },
        )
      : undefined;

  if (installPlan?.problem && !applyOptions.dryRun) {
    throw installPlan.problem;
  }

  const packageJSON = await ensurePackageJSON(
    packageManager,
    applyOptions.dryRun,
    applyOptions.assumeYes,
    applyOptions.json,
  );
  const projectInspection = await inspectProject(recipe, {
    reownManagedFiles: applyOptions.reownManagedFiles,
  });
  const scriptPlan = buildScripts(recipe, integrations, packageManager, vitePlusQuality);
  const { scripts, omittedScripts, omittedQualitySteps } = scriptPlan;
  /** @type {Change[]} */
  const changes = [];
  /** @type {ManagedFileState[]} */
  const managedFiles = [];
  const removedDefaultTestScript = removeDefaultTestScript(packageJSON);
  const managedFilePlans = plannedManagedFiles(integrations, recipe.integrationOptions);
  const usesVarlock = integrations.some(({ id }) => id === "varlock");
  const varlockFilePlans = usesVarlock ? await planVarlockProjectFiles() : [];

  await assertSafeManagedFileWrites(managedFilePlans, previousState, reownManagedFiles);

  // Before an auto-install commits, check every selected artifact against the project, so a
  // conflict with an already-locked artifact stops apply before the install changes anything.
  const artifactPlan = await prepareArtifactSources(
    recipe,
    applyOptions.dryRun,
    artifactServices,
    (sources) => buildAiApplyResult(recipe, { dryRun: true }, previousState, sources),
    applyOptions.approvedArtifacts,
  );
  const aiResult = await buildAiApplyResult(
    recipe,
    applyOptions,
    previousState,
    artifactPlan.sources,
  ).finally(artifactPlan.dispose);
  // A dry run plans the auto-installed outputs in both results; apply writes them during the
  // install, so only the install reports them.
  const autoInstalledPaths = new Set(artifactPlan.changes.map(({ path }) => path));
  const aiChanges = [
    ...artifactPlan.changes,
    ...aiResult.changes.filter(({ path }) => !autoInstalledPaths.has(path)),
  ];

  if (applyOptions.writeConfig) {
    const configPath = resolve(applyOptions.config ?? "calavera.config.json");
    const configUnchanged = previouslyApplied && (await jsonFileUnchanged(configPath, recipe));
    changes.push({
      type: configUnchanged ? "unchanged" : "write",
      path: relative(process.cwd(), configPath),
      action: "write",
      ownership: "project",
    });
    await writeJSON(configPath, recipe, applyOptions.dryRun || configUnchanged);
  }

  // ADR-0013, Decision 6: only after an earlier apply is a script under its
  // old name Calavera's to rename. A rename that would overwrite the user's
  // script under the new name does not happen, and that script is not written.
  const { renamed: renamedScripts, blocked: blockedRenames } = previouslyApplied
    ? planScriptRenames(packageJSON.scripts ?? {}, scripts)
    : { renamed: [], blocked: [] };
  for (const { from, to } of blockedRenames) {
    delete scripts[to];
    omittedScripts.push({
      script: to,
      reason: `package.json defines ${to} with a value of your own, and ${from} still has the value Calavera wrote, so Calavera keeps both instead of renaming ${from}; the generated quality script runs your ${to}.`,
    });
  }
  // The values apply writes, against the scripts as they are now. A renamed
  // script is added under its new name.
  /** @type {ScriptChange[]} */
  const scriptChanges = [];
  for (const [script, value] of Object.entries(scripts)) {
    if (!Object.hasOwn(packageJSON.scripts ?? {}, script)) {
      scriptChanges.push({ script, value });
    } else if (packageJSON.scripts?.[script] !== value) {
      scriptChanges.push({ script, value, previous: packageJSON.scripts?.[script] });
    }
  }
  if (renamedScripts.length > 0) {
    // The renamed script keeps the position the old name had.
    const newNames = new Map(renamedScripts.map(({ from, to }) => [from, to]));
    packageJSON.scripts = Object.fromEntries(
      Object.entries(packageJSON.scripts ?? {}).map(([name, value]) => {
        const newName = newNames.get(name);
        return newName ? [newName, scripts[newName] ?? value] : [name, value];
      }),
    );
  }
  const packageJSONUnchanged =
    previouslyApplied &&
    !removedDefaultTestScript &&
    renamedScripts.length === 0 &&
    Object.entries(scripts).every(([name, script]) => packageJSON.scripts?.[name] === script);
  packageJSON.scripts = {
    ...packageJSON.scripts,
    ...scripts,
  };
  changes.push({
    type: packageJSONUnchanged ? "unchanged" : "update",
    path: "package.json",
    action: "update",
    ownership: "project",
    scripts: Object.keys(scripts),
    omittedScripts,
    removedDefaultTestScript,
    ...(renamedScripts.length > 0 ? { renamedScripts } : {}),
    ...(omittedQualitySteps.length > 0 ? { omittedQualitySteps } : {}),
  });

  if (integrations.some((integration) => integration.id === "editorconfig")) {
    managedFiles.push(
      await writeManagedFile(
        ".editorconfig",
        createEditorConfig(),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "stylelint")) {
    managedFiles.push(
      await writeManagedJSONFile(
        ".stylelintrc.json",
        createStylelintConfig(integrations, recipe.integrationOptions),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "html-validate")) {
    managedFiles.push(
      await writeManagedJSONFile(
        ".htmlvalidate.json",
        createHtmlValidateConfig(integrations),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
    managedFiles.push(
      await writeManagedFile(
        ".htmlvalidateignore",
        HTML_VALIDATE_IGNORE,
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "react-doctor")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "react-doctor.config.json",
        createReactDoctorConfig(),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === "knip")) {
    managedFiles.push(
      await writeManagedJSONFile(
        "knip.json",
        createKnipConfig(),
        applyOptions.dryRun,
        changes,
        previousState,
        reownManagedFiles,
      ),
    );
  }

  if (integrations.some((integration) => integration.id === GITHUB_REPOSITORY_CONTROLS_ID)) {
    for (const file of githubRepositoryControlManagedFiles(
      recipe.integrationOptions?.[GITHUB_REPOSITORY_CONTROLS_ID],
    )) {
      managedFiles.push(
        await writeManagedFile(
          file.path,
          file.contents,
          applyOptions.dryRun,
          changes,
          previousState,
          reownManagedFiles,
        ),
      );
    }
  }

  await applyVarlockProjectFiles(varlockFilePlans, applyOptions.dryRun, changes);

  if (!applyOptions.dryRun && !packageJSONUnchanged) {
    await writeJSON("package.json", packageJSON, false);
  }

  if (!applyOptions.dryRun) {
    await mkdir(".calavera", { recursive: true });
    await writeJSON(
      STATE_FILE,
      mergeRecipeIntoState(
        previousState,
        recipe.profile,
        integrations.map((integration) => integration.id),
        managedFiles,
        aiResult.artifacts,
      ),
      false,
    );
  }

  if (installPlan?.spawn && !applyOptions.dryRun) {
    const [command, commandArgs] = installPlan.spawn;
    const spin = applyOptions.json ? null : spinner();
    spin?.start("Installing development dependencies...");

    try {
      await execa(command, commandArgs, { stderr: "inherit" });
    } catch (error) {
      // A spinner left running keeps its timer alive, and the process never exits.
      spin?.error("Could not install development dependencies");
      const written = unique([
        ...[...changes, ...aiChanges]
          .filter(({ type }) => type !== "unchanged")
          .map(({ path }) => path),
        STATE_FILE,
      ]);
      throw new Error(
        [
          "Calavera applied the recipe's files, package.json scripts, configuration, and state, but could not install the recipe's development dependencies, so the tools those scripts run are not installed yet.",
          `Already written: ${written.join(", ")}.`,
          `Install command: ${formatCommand(installPlan.spawn)}`,
          describeCommandFailure(error),
          `To finish the install, run the install command in ${process.cwd()}.`,
        ].join("\n"),
        { cause: error },
      );
    }

    spin?.stop("Dependencies installed");
  }

  return {
    command: "apply",
    dryRun: applyOptions.dryRun,
    packageManager,
    dependencies: dependencyList,
    installCommand: installPlan ? formatCommand(installPlan.command) : null,
    installNotes: installPlan?.notes ?? [],
    integrations: integrations.map((integration) => integration.id),
    projectInspection,
    vitePlus: vitePlusReport(projectInspection.vitePlus),
    changes: [...changes, ...aiChanges],
    scriptChanges,
    pointers: [...aiResult.pointers, ...(usesVarlock ? [VARLOCK_POINTER] : [])],
    autoInstalledArtifacts: artifactPlan.installed,
  };
}

/**
 * @param {CalaveraState} previousState
 * @param {string | undefined} profile
 * @param {string[]} integrations
 * @param {ManagedFileState[]} managedFiles
 * @param {AiArtifactState[]} aiArtifacts
 * @returns {CalaveraState}
 */
function mergeRecipeIntoState(previousState, profile, integrations, managedFiles, aiArtifacts) {
  const managedFilesByPath = new Map(
    managedFilesFromState(previousState).map((file) => [file.path, file]),
  );

  for (const managedFile of managedFiles) {
    managedFilesByPath.set(managedFile.path, managedFile);
  }

  const nextManagedFiles = [...managedFilesByPath.values()];
  const preservesToolingRecipe = managedFiles.length === 0 && aiArtifacts.length > 0;

  return {
    ...previousState,
    version: 1,
    profile: preservesToolingRecipe ? previousState.profile : profile,
    integrations: preservesToolingRecipe ? previousState.integrations : integrations,
    files: nextManagedFiles.map((file) => file.path),
    managedFiles: nextManagedFiles,
    aiArtifacts,
  };
}

/**
 * @param {CalaveraState} previousState
 * @param {AiArtifactState[]} aiArtifacts
 * @returns {CalaveraState}
 */
function mergeAiArtifactsIntoState(previousState, aiArtifacts) {
  const artifactsByPath = new Map(
    previousState.aiArtifacts.map((artifact) => [artifact.path, artifact]),
  );

  for (const artifact of aiArtifacts) {
    artifactsByPath.set(artifact.path, artifact);
  }

  return {
    ...previousState,
    version: 1,
    aiArtifacts: [...artifactsByPath.values()],
  };
}

/**
 * @param {string} path
 * @param {string} contents
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {string} conflictReason
 * @returns {Promise<boolean>}
 */
async function writeBootstrapTextFile(path, contents, dryRun, changes, conflictReason) {
  const targetPath = path.trim();

  if (!targetPath) {
    throw new Error("Bootstrap file path must be a non-empty string.");
  }

  if (await fileExists(targetPath)) {
    const currentContents = await readFile(targetPath, "utf8");

    changes.push({
      type: "skip",
      path: targetPath,
      reason: currentContents === contents ? "Already up to date." : conflictReason,
    });

    return currentContents === contents;
  }

  changes.push({ type: "write", path: targetPath });

  if (!dryRun) {
    const directory = dirname(targetPath);
    if (directory !== ".") {
      await mkdir(directory, { recursive: true });
    }

    await writeFile(targetPath, contents);
  }

  return true;
}

/**
 * @param {string} path
 */
async function assertBootstrapDirectoryAvailable(path) {
  if (!(await fileExists(path))) {
    return;
  }

  const pathStats = await stat(path);

  if (!pathStats.isDirectory()) {
    throw new Error(
      `Cannot write Calavera bootstrap state because ${path} exists and is not a directory.`,
    );
  }
}

/**
 * @param {CliOptions} options
 * @returns {Promise<"append" | "fallback">}
 */
async function resolveAgentBootstrapGuidanceMode(options) {
  if (options.agentsMd) {
    return options.agentsMd;
  }

  if (options.json || options.assumeYes || !process.stdin.isTTY) {
    return "fallback";
  }

  const selected = await select({
    message: `${AGENT_BOOTSTRAP_GUIDANCE_FILE} already exists. How should Calavera add guidance?`,
    options: [
      {
        value: "append",
        label: "Append guidance",
        hint: "Add marked Calavera guidance directly to AGENTS.md",
      },
      {
        value: "fallback",
        label: "Fallback only",
        hint: `Leave AGENTS.md unchanged and write ${AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE}`,
      },
    ],
  });

  exitIfCancel(selected);

  return selected === "append" ? "append" : "fallback";
}

/**
 * @param {CliOptions} options
 * @returns {Promise<McpHarness>}
 */
async function resolveAgentBootstrapMcpHarness(options) {
  if (options.mcpHarness) {
    return options.mcpHarness;
  }

  if (options.json || options.assumeYes || !process.stdin.isTTY) {
    return "skip";
  }

  const selected = await select({
    message: "Configure the Calavera MCP server for which agent harness?",
    options: [
      {
        value: "claude-code",
        label: "Claude Code",
        hint: "Write project .mcp.json",
      },
      {
        value: "codex",
        label: "Codex",
        hint: "Write project .codex/config.toml",
      },
      {
        value: "cursor",
        label: "Cursor",
        hint: "Write project .cursor/mcp.json",
      },
      {
        value: "opencode",
        label: "OpenCode",
        hint: "Write project opencode.json",
      },
      {
        value: "skip",
        label: "Skip auto-config",
        hint: `Use ${AGENT_BOOTSTRAP_MCP_FILE} for manual setup`,
      },
    ],
  });

  exitIfCancel(selected);

  return assertSupportedMcpHarness(typeof selected === "string" ? selected : "skip");
}

/**
 * @param {McpHarness} harness
 * @param {{ command: string, args: string[] }} launchCommand
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @returns {Promise<{ harness: McpHarness, action: "manual" | "write" | "update" | "skip", path?: string, reason?: string }>}
 */
async function writeAgentBootstrapMcpConfig(harness, launchCommand, dryRun, changes) {
  const path = projectMcpConfigPath(harness);

  if (!path) {
    return {
      harness,
      action: "manual",
      reason: `Skipped project MCP auto-config. Follow ${AGENT_BOOTSTRAP_MCP_FILE} for manual setup.`,
    };
  }

  /** @type {"write" | "update" | "skip"} */
  let action;
  const initialChangeCount = changes.length;

  try {
    switch (harness) {
      case "claude-code":
      case "cursor":
        action = await writeMcpServersJsonConfig(path, launchCommand, dryRun, changes);
        break;
      case "codex":
        action = await writeCodexMcpConfig(path, launchCommand, dryRun, changes);
        break;
      case "opencode":
        action = await writeOpenCodeMcpConfig(path, launchCommand, dryRun, changes);
        break;
      default:
        action = "skip";
    }
  } catch (error) {
    changes.splice(initialChangeCount);
    return {
      harness,
      action: "manual",
      reason: `Could not write project MCP config at ${path}: ${
        error instanceof Error ? error.message : String(error)
      }. Follow ${AGENT_BOOTSTRAP_MCP_FILE} for manual setup.`,
    };
  }

  return { harness, action, path };
}

/**
 * @param {string} contents
 * @param {string} section
 * @returns {{ contents: string, changed: boolean }}
 */
function upsertAgentBootstrapGuidanceSection(contents, section) {
  const startIndex = contents.indexOf(AGENT_BOOTSTRAP_SECTION_START);
  const endIndex = contents.indexOf(AGENT_BOOTSTRAP_SECTION_END);

  if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
    return {
      contents: `${contents.trimEnd()}\n\n${section}`,
      changed: true,
    };
  }

  const replaceEndIndex = endIndex + AGENT_BOOTSTRAP_SECTION_END.length;
  const nextContents = `${contents.slice(0, startIndex)}${section.trimEnd()}${contents.slice(
    replaceEndIndex,
  )}`;

  return {
    contents: nextContents,
    changed: nextContents !== contents,
  };
}

/**
 * @param {string} currentGuidance
 * @param {boolean} dryRun
 * @param {Change[]} changes
 * @param {CliOptions} options
 */
async function handleExistingAgentBootstrapGuidance(currentGuidance, dryRun, changes, options) {
  const guidance = createAgentBootstrapGuidance();
  const guidanceSection = createAgentBootstrapGuidanceSection();

  if (currentGuidance.includes(AGENT_BOOTSTRAP_SECTION_START)) {
    const nextGuidance = upsertAgentBootstrapGuidanceSection(currentGuidance, guidanceSection);

    changes.push({
      type: nextGuidance.changed ? "update" : "skip",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: nextGuidance.changed
        ? "Calavera guidance section will be updated."
        : "Calavera guidance section already up to date.",
    });

    if (!dryRun && nextGuidance.changed) {
      await writeFile(AGENT_BOOTSTRAP_GUIDANCE_FILE, nextGuidance.contents);
    }
    return;
  }

  if (currentGuidance.includes(AGENT_BOOTSTRAP_MARKER)) {
    changes.push({
      type: "skip",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: "Calavera guidance already present.",
    });
    return;
  }

  const mode = await resolveAgentBootstrapGuidanceMode(options);

  if (mode === "append") {
    const nextGuidance = upsertAgentBootstrapGuidanceSection(currentGuidance, guidanceSection);

    changes.push({
      type: "update",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: "Append marked Calavera guidance section.",
    });

    if (!dryRun) {
      await writeFile(AGENT_BOOTSTRAP_GUIDANCE_FILE, nextGuidance.contents);
    }
    return;
  }

  changes.push({
    type: "skip",
    path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
    reason: `Existing AGENTS.md left unchanged; Calavera guidance ${dryRun ? "would be" : "was"} written separately.`,
  });

  await writeBootstrapTextFile(
    AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE,
    guidance,
    dryRun,
    changes,
    "Existing fallback Calavera guidance differs and was left unchanged.",
  );
}

/**
 * @param {CliOptions} options
 * @param {Change[]} changes
 */
async function writeAgentBootstrapGuidance(options, changes) {
  const guidance = createAgentBootstrapGuidance();

  if (!(await fileExists(AGENT_BOOTSTRAP_GUIDANCE_FILE))) {
    await writeBootstrapTextFile(
      AGENT_BOOTSTRAP_GUIDANCE_FILE,
      guidance,
      options.dryRun,
      changes,
      "Existing agent guidance differs and was left unchanged.",
    );
    return;
  }

  const currentGuidance = await readFile(AGENT_BOOTSTRAP_GUIDANCE_FILE, "utf8");

  if (currentGuidance === guidance) {
    changes.push({
      type: "skip",
      path: AGENT_BOOTSTRAP_GUIDANCE_FILE,
      reason: "Already up to date.",
    });
    return;
  }

  await handleExistingAgentBootstrapGuidance(currentGuidance, options.dryRun, changes, options);
}

/**
 * @param {Partial<CliOptions>} [options]
 * @returns {Promise<AgentInitResult>}
 */
export async function agentBootstrap(options = {}) {
  /** @type {CliOptions} */
  const bootstrapOptions = {
    command: "agent-init",
    config: CONFIG_FILE,
    dryRun: false,
    json: false,
    noInstall: false,
    assumeYes: false,
    apply: false,
    integrations: [],
    aiArtifacts: [],
    ...options,
    reownManagedFiles: options.reownManagedFiles ?? [],
  };
  const detectedPackageJSON = await readPackageJSONIfPresent();
  const packageManager = assertSupportedPackageManager(
    bootstrapOptions.packageManager ?? detectPackageManager(detectedPackageJSON) ?? "npm",
  );
  const launchCommand = createMcpLaunchCommand(packageManager);

  await assertBootstrapDirectoryAvailable(".calavera");

  const previousState = await readStateIfPresent();
  const aiResult = await buildAiApplyResult(
    AGENT_BOOTSTRAP_SKILL_RECIPE,
    { dryRun: bootstrapOptions.dryRun },
    previousState,
    new Map([["skill-calavera", AGENT_BOOTSTRAP_SKILL_PATH]]),
  );
  /** @type {Change[]} */
  const changes = [...aiResult.changes];

  await writeAgentBootstrapGuidance(bootstrapOptions, changes);
  const mcpHarness = await resolveAgentBootstrapMcpHarness(bootstrapOptions);
  const mcp = await writeAgentBootstrapMcpConfig(
    mcpHarness,
    launchCommand,
    bootstrapOptions.dryRun,
    changes,
  );

  if (mcp.action === "manual") {
    await writeBootstrapTextFile(
      AGENT_BOOTSTRAP_MCP_FILE,
      createAgentBootstrapMcpInstructions(packageManager),
      bootstrapOptions.dryRun,
      changes,
      "Existing Calavera MCP setup notes differ and were left unchanged.",
    );
  }

  const wroteFallbackGuidance = changes.some(
    (change) => change.path === AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE,
  );
  const agentGuidancePointer = wroteFallbackGuidance
    ? `Agent guidance: ${AGENT_BOOTSTRAP_FALLBACK_GUIDANCE_FILE} for manual merge with ${AGENT_BOOTSTRAP_GUIDANCE_FILE}`
    : `Agent guidance: ${AGENT_BOOTSTRAP_GUIDANCE_FILE}`;
  const mcpPointer =
    mcp.action === "manual"
      ? `MCP setup: manual (${AGENT_BOOTSTRAP_MCP_FILE})`
      : `MCP setup: ${mcp.path}`;

  if (!bootstrapOptions.dryRun) {
    await mkdir(".calavera", { recursive: true });
    await writeJSON(
      STATE_FILE,
      mergeAiArtifactsIntoState(previousState, aiResult.artifacts),
      false,
    );
  }

  return {
    command: "agent-init",
    dryRun: bootstrapOptions.dryRun,
    changes,
    pointers: [
      ...aiResult.pointers,
      agentGuidancePointer,
      mcpPointer,
      ...(mcp.action === "manual" ? [`MCP setup notes: ${AGENT_BOOTSTRAP_MCP_FILE}`] : []),
    ],
    nextPrompt: AGENT_BOOTSTRAP_NEXT_PROMPT,
    nextSteps: recipeNextSteps(process.cwd(), packageManager, { changeDirectory: false }),
    packageManager,
    mcp,
  };
}

/**
 * The action block printed after the bootstrap: a project needs a recipe
 * before Calavera changes anything, so it names both ways to get one and the
 * commands that preview and apply it. When the project already has a recipe,
 * it names that file instead. `changeDirectory` adds a `cd` line for `--new`,
 * which leaves the user in the parent directory.
 *
 * @param {string} target Absolute project directory.
 * @param {PackageManager} packageManager
 * @param {{ changeDirectory: boolean }} options
 * @returns {string[]}
 */
function recipeNextSteps(target, packageManager, { changeDirectory }) {
  const commands = projectLocalCommandCatalog[packageManager];
  const run = [
    ...(changeDirectory ? [`cd ${quoteShellToken(target)}`] : []),
    commands.applyDryRun,
    commands.applyRecipe,
  ];
  const recipePath = join(target, CONFIG_FILE);

  if (existsSync(recipePath)) {
    return [
      `Your project has a recipe at ${recipePath}. Calavera has not applied it.`,
      "  Preview it, then apply it after you approve the preview:",
      ...run.map((line) => `    ${line}`),
    ];
  }

  return [
    "Your project needs a recipe before Calavera changes anything.",
    `  Either: open ${target} in your agent and use the prompt above.`,
    `  Or: compose one at ${COMPOSER_URL} and save`,
    `      ${CONFIG_FILE} into ${target}, then:`,
    ...run.map((line) => `        ${line}`),
  ];
}

const NEW_HARD_STOP_SUFFIX =
  "Calavera wrote nothing further, removed nothing, and did not run the --init bootstrap.";

/**
 * @typedef {{ command: string, args: string[], cwd: string }} RunnerInvocation
 * @typedef {{ exitCode: number | null, signal: string | null }} RunnerExit
 * @typedef {object} NewProjectRuntime
 * @property {(invocation: RunnerInvocation) => Promise<RunnerExit>} [spawnRunner]
 */

/**
 * Spawns the runner with inherited stdio, so Vite+ asks its own questions.
 *
 * @param {RunnerInvocation} invocation
 * @returns {Promise<RunnerExit>}
 */
async function spawnInheritedRunner({ command, args, cwd }) {
  const result = await execa(command, args, { cwd, stdio: "inherit", reject: false });

  if (result.exitCode === undefined && result.signal === undefined) {
    throw new Error(
      `--new could not start ${command}: ${result.shortMessage ?? result.code ?? "unknown error"}. Calavera wrote nothing.`,
      { cause: result.cause ?? result },
    );
  }

  return { exitCode: result.exitCode ?? null, signal: result.signal ?? null };
}

/**
 * The `--directory` value `vp create` receives, if any. Tokens after a `--`
 * belong to the template and are not read.
 *
 * @param {string[]} forwardedArgs
 * @returns {string | undefined}
 */
function forwardedDirectory(forwardedArgs) {
  const separatorIndex = forwardedArgs.indexOf("--");
  const vpCreateArgs =
    separatorIndex === -1 ? forwardedArgs : forwardedArgs.slice(0, separatorIndex);

  for (const [index, arg] of vpCreateArgs.entries()) {
    if (arg === "--directory") {
      return vpCreateArgs[index + 1];
    }

    if (arg.startsWith("--directory=")) {
      return arg.slice("--directory=".length);
    }
  }

  return undefined;
}

/**
 * @param {string} path
 * @returns {Promise<string | undefined>}
 */
async function readFileIfPresent(path) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Records the `package.json` of a directory and of each of its top-level
 * directories: its contents, or `undefined` when absent or unreadable.
 *
 * @param {string} cwd
 * @returns {Promise<Map<string, string | undefined>>}
 */
async function snapshotManifests(cwd) {
  const entries = await readdir(cwd, { withFileTypes: true });
  const directories = [
    cwd,
    ...entries.filter((entry) => entry.isDirectory()).map((entry) => join(cwd, entry.name)),
  ];
  /** @type {Map<string, string | undefined>} */
  const snapshot = new Map();

  for (const directory of directories) {
    snapshot.set(directory, await readFileIfPresent(join(directory, "package.json")));
  }

  return snapshot;
}

/**
 * Locates the directory `vp create` scaffolded, per ADR-0010 Decision 3.
 *
 * @param {string} cwd
 * @param {Map<string, string | undefined>} before
 * @returns {Promise<string[]>}
 */
async function scaffoldCandidates(cwd, before) {
  const after = await snapshotManifests(cwd);

  if (before.get(cwd) === undefined && after.get(cwd) !== undefined) {
    return [cwd];
  }

  return [...after]
    .filter(
      ([directory, contents]) =>
        directory !== cwd && contents !== undefined && contents !== before.get(directory),
    )
    .map(([directory]) => directory);
}

/**
 * @param {RunnerExit} exit
 * @returns {string}
 */
function describeRunnerExit(exit) {
  return exit.exitCode === null
    ? `was terminated by signal ${exit.signal ?? "unknown"}`
    : `exited with code ${exit.exitCode}`;
}

/**
 * Reads and validates the recipe given with `--config` before `--new`, so a
 * bad recipe is refused before `vp create` runs. The bytes read are the bytes
 * later copied, so the copy matches what was validated.
 *
 * @param {string} source Absolute recipe path.
 * @returns {Promise<{ source: string, bytes: Buffer }>}
 */
async function readNewProjectRecipe(source) {
  let bytes;

  try {
    bytes = await readFile(source);
  } catch (error) {
    throw new Error(
      `--new refused: the recipe given with --config, ${source}, could not be read: ${
        error instanceof Error ? error.message : String(error)
      }. Nothing was run and no files were changed.`,
      { cause: error },
    );
  }

  try {
    validateRecipe(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    throw new Error(
      `--new refused: ${source}, given with --config, is not a valid recipe: ${(error instanceof
      Error
        ? error.message
        : String(error)
      ).replace(/\.$/, "")}. Nothing was run and no files were changed.`,
      { cause: error },
    );
  }

  return { source, bytes };
}

/**
 * @param {string} runner
 * @param {string} cwd
 * @param {VitePlusDetection} cwdDetection
 * @param {string} [recipeSource] Absolute path of the recipe `--config` copies.
 * @returns {string[]}
 */
function newProjectConfirmation(runner, cwd, cwdDetection, recipeSource) {
  return [
    "Calavera will run Vite+ to scaffold a new project:",
    `  Command: ${runner}`,
    `  Working directory: ${cwd}`,
    "- The runner may download vite-plus before it starts.",
    "- Vite+ asks its own questions (template, target directory, package manager, and the rest) unless the forwarded flags answer them. Calavera does not answer them.",
    "- Vite+ installs the project's dependencies. This needs network access, can take minutes, and cannot be skipped.",
    "- If the target directory Vite+ is given is not empty, Vite+ may offer to remove its contents. That choice is Vite+'s.",
    "- Calavera's dry run does not preview what Vite+ writes, and Calavera does not undo it if the scaffold fails.",
    ...(cwdDetection.ancestor
      ? [
          `- The new project will sit inside another project: ${cwdDetection.ancestor.manifestPath} is ${cwdDetection.ancestor.status}.`,
        ]
      : []),
    ...(recipeSource === undefined
      ? []
      : [
          `- After Vite+ detection reports the scaffold as managed, Calavera copies ${recipeSource} into it as ${CONFIG_FILE}. Calavera does not apply the recipe.`,
        ]),
    "- After a successful scaffold, Calavera runs the --init agent bootstrap in the new directory.",
  ];
}

/**
 * @param {CliOptions} options
 * @returns {string[]}
 */
function nonInteractiveReasons(options) {
  return [
    ...(process.stdin.isTTY ? [] : ["stdin is not a terminal"]),
    ...(process.env.CI ? ["CI is set"] : []),
    ...((options.newArgs ?? []).includes("--no-interactive")
      ? ["--no-interactive was forwarded to vp create"]
      : []),
  ];
}

/**
 * `--new`: confirms, spawns `vp create` through a package-manager runner,
 * verifies that the scaffold is managed by Vite+, and runs the `--init`
 * bootstrap in it, as decided by ADR-0010.
 *
 * @param {CliOptions} options
 * @param {NewProjectRuntime} [runtime]
 * @returns {Promise<NewResult>}
 */
export async function newProject(options, runtime = {}) {
  const cwd = process.cwd();
  const forwardedArgs = options.newArgs ?? [];

  if (existsSync(join(cwd, "package.json"))) {
    throw new Error(
      [
        `--new refused: ${join(cwd, "package.json")} exists, so a project already exists here. --new only starts a project that does not exist yet. Run the agent bootstrap in this directory instead:`,
        ...supportedPackageManagers.map(
          (packageManager) => `  ${projectLocalCommandCatalog[packageManager].agentBootstrap}`,
        ),
      ].join("\n"),
    );
  }

  if (options.init) {
    throw new Error(
      "--new and --init cannot be combined: --new already runs the --init bootstrap after Vite+ scaffolds the project. Remove --init.",
    );
  }

  if (options.json) {
    throw new Error(
      "--new cannot be combined with --json: Vite+ writes its prompts and progress to the same output, which would corrupt the JSON result. Remove --json.",
    );
  }

  const runnerCommand = createVpCreateCommand(options.packageManager ?? "npm", forwardedArgs);
  const runner = formatShellCommand(runnerCommand);
  const recipe =
    options.newConfig === undefined
      ? undefined
      : await readNewProjectRecipe(resolve(cwd, options.newConfig));
  const confirmation = newProjectConfirmation(
    runner,
    cwd,
    await detectVitePlus(cwd),
    recipe?.source,
  );

  if (options.dryRun) {
    return { command: "new", dryRun: true, confirmed: false, confirmation };
  }

  if (!options.assumeYes) {
    const reasons = nonInteractiveReasons(options);

    if (reasons.length > 0) {
      throw new Error(
        `--new refused: Calavera cannot ask for confirmation because ${reasons.join(", ")}. Preview the command with --dry-run, then confirm it by passing --yes before --new.`,
      );
    }

    note(confirmation.join("\n"), "Before Calavera runs vp create");
    const confirmed = await confirm({ message: "Run vp create now?", initialValue: false });

    exitIfCancel(confirmed);

    if (confirmed !== true) {
      return { command: "new", dryRun: false, confirmed: false, confirmation };
    }
  } else {
    for (const line of confirmation) {
      logger.info(line);
    }
  }

  // A forwarded --directory names the target, but it is still verified the
  // same way: its package.json must be new or changed by the spawn, so a
  // canceled scaffold cannot hand the bootstrap a project Vite+ never touched.
  const directory = forwardedDirectory(forwardedArgs);
  const forwardedTarget = directory === undefined ? undefined : resolve(cwd, directory);
  const forwardedManifestBefore =
    forwardedTarget === undefined
      ? undefined
      : await readFileIfPresent(join(forwardedTarget, "package.json"));
  const before = forwardedTarget === undefined ? await snapshotManifests(cwd) : new Map();
  const exit = await (runtime.spawnRunner ?? spawnInheritedRunner)({ ...runnerCommand, cwd });

  if (exit.exitCode !== 0) {
    throw new Error(
      `vp create through ${runnerCommand.command} ${describeRunnerExit(exit)} (run in ${cwd}). ${NEW_HARD_STOP_SUFFIX} ${cwd} may hold a partial scaffold that belongs to Vite+.${
        runnerCommand.command === "yarn"
          ? " If yarn itself failed, note that yarn dlx needs Yarn 2 or later."
          : ""
      }`,
    );
  }

  let candidates;
  if (forwardedTarget === undefined) {
    candidates = await scaffoldCandidates(cwd, before);
  } else {
    const manifestAfter = await readFileIfPresent(join(forwardedTarget, "package.json"));
    candidates =
      manifestAfter !== undefined && manifestAfter !== forwardedManifestBefore
        ? [forwardedTarget]
        : [];
  }
  const [target] = candidates;

  if (target === undefined) {
    const searched =
      forwardedTarget === undefined
        ? `${cwd} or its top-level directories`
        : `the forwarded --directory ${forwardedTarget}`;
    throw new Error(
      `vp create exited with code 0, but no new or changed package.json was found in ${searched}, so the scaffold was canceled or wrote no project. ${NEW_HARD_STOP_SUFFIX}`,
    );
  }

  if (candidates.length > 1) {
    throw new Error(
      `vp create exited with code 0, but more than one directory gained a new or changed package.json: ${candidates.join(", ")}. Calavera cannot tell which one Vite+ scaffolded. ${NEW_HARD_STOP_SUFFIX} Run the --init bootstrap in the scaffolded directory.`,
    );
  }

  const detection = await detectVitePlus(target);

  if (detection.status !== "managed") {
    const findings = vitePlusFindings(detection)
      .map((finding) => `${finding.kind}: ${finding.message}`)
      .join(" ");

    throw new Error(
      `vp create exited with code 0, but Vite+ detection on ${target} reports status ${detection.status}. ${findings} ${NEW_HARD_STOP_SUFFIX} ${target} may hold a partial scaffold that belongs to Vite+.`,
    );
  }

  const recipePath = join(target, CONFIG_FILE);

  if (recipe) {
    try {
      // `wx` refuses to replace a recipe that is already in the target.
      await writeFile(recipePath, recipe.bytes, { flag: "wx" });
    } catch (error) {
      throw new Error(
        `Vite+ scaffolded ${target}, but Calavera could not copy ${recipe.source} to ${recipePath}: ${
          error instanceof Error && "code" in error && error.code === "EEXIST"
            ? `${recipePath} already exists`
            : error instanceof Error
              ? error.message
              : String(error)
        }. ${NEW_HARD_STOP_SUFFIX}`,
        { cause: error },
      );
    }
  }

  process.chdir(target);

  try {
    // The runner's package manager only fetched vite-plus; the bootstrap
    // detects the project's package manager from the scaffolded manifest.
    const bootstrap = await agentBootstrap({
      ...options,
      command: "agent-init",
      packageManager: undefined,
    });
    const nextSteps = recipeNextSteps(target, bootstrap.packageManager, { changeDirectory: true });

    return {
      command: "new",
      dryRun: false,
      confirmed: true,
      confirmation,
      target,
      bootstrap: { ...bootstrap, nextSteps },
      ...(recipe ? { recipe: { source: recipe.source, path: recipePath } } : {}),
    };
  } catch (error) {
    const packageManager =
      (await readPackageJSONIfPresent().then(detectPackageManager, () => undefined)) ?? "npm";

    throw new Error(
      `Vite+ scaffolded ${target}, but the Calavera agent bootstrap failed: ${
        error instanceof Error ? error.message : String(error)
      }. The scaffold is left in place${
        recipe ? `, and the recipe was copied to ${recipePath} and not applied` : ""
      }. Run the bootstrap in that directory: cd ${quoteShellToken(target)} && ${projectLocalCommandCatalog[packageManager].agentBootstrap}`,
      { cause: error },
    );
  } finally {
    process.chdir(cwd);
  }
}

/**
 * @param {unknown} value
 * @returns {never | void}
 */
function exitIfCancel(value) {
  if (isCancel(value)) {
    cancel("Setup cancelled");
    process.exit(0);
  }
}

/**
 * @param {Recipe} recipe
 * @param {{ integrations: unknown[], dependencies: string[], aiArtifacts: unknown[] }} explanation
 * @returns {string}
 */
function formatRecipeSummary(recipe, explanation) {
  return [
    `${style("bold", "Profile")}: ${recipe.profile}`,
    `${style("bold", "Package manager")}: ${recipe.packageManager}`,
    `${style("bold", "Integrations")}: ${pluralizeCount((recipe.integrations ?? []).length, "item")}`,
    `${style("bold", "Dependencies")}: ${
      explanation.dependencies.length > 0 ? explanation.dependencies.join(", ") : "none"
    }`,
    `${style("bold", "AI artifacts")}: ${explanation.aiArtifacts.length}`,
  ].join("\n");
}

/**
 * @param {ApplyResult} result
 * @returns {string}
 */
function formatApplySummary(result) {
  const changedPaths = result.changes
    .filter(({ type }) => type !== "unchanged")
    .map((change) => change.path);

  return [
    `${style("bold", "Package manager")}: ${result.packageManager}`,
    `${style("bold", "Integrations")}: ${result.integrations.join(", ") || "none"}`,
    `${style("bold", "Dev dependencies")}: ${result.dependencies.join(", ") || "none"}`,
    `${style("bold", "Artifacts to lock")}: ${
      result.autoInstalledArtifacts
        .map(({ id, package: packageName, version }) => `${id} (${packageName}@${version})`)
        .join(", ") || "none"
    }`,
    `${style("bold", "Planned changes")}: ${changedPaths.join(", ") || "none"}`,
  ].join("\n");
}

/**
 * @param {CliOptions} options
 * @returns {Promise<string>}
 */
async function promptForProfile(options) {
  const selected =
    options.profile ??
    (await select({
      message: "Choose a tooling profile",
      options: supportedProfiles.map((id) => ({
        value: id,
        label: titleCase(id),
        hint: `${profileDefaults[id]?.length ?? 0} default integrations`,
      })),
    }));

  exitIfCancel(selected);
  return typeof selected === "string" ? selected : "default";
}

/**
 * @param {CliOptions} options
 * @param {PackageManager} detectedPackageManager
 * @returns {Promise<PackageManager>}
 */
async function promptForPackageManager(options, detectedPackageManager) {
  const selected =
    options.packageManager ??
    (options.assumeYes
      ? detectedPackageManager
      : await select({
          message: "Choose a package manager",
          initialValue: detectedPackageManager,
          options: recipePackageManagers.map((id) => ({
            value: id,
            label: id,
            hint: id === detectedPackageManager ? "detected" : undefined,
          })),
        }));

  exitIfCancel(selected);

  return assertSupportedPackageManager(
    typeof selected === "string" ? selected : detectedPackageManager,
  );
}

/**
 * @param {CliOptions} options
 * @param {string} profile
 * @returns {Promise<string[]>}
 */
async function promptForIntegrations(options, profile) {
  const defaults = profileDefaults[profile] ?? profileDefaults.default ?? [];

  if (options.integrations.length > 0) {
    return options.integrations;
  }

  if (options.assumeYes || options.profile) {
    return defaults;
  }

  const selected = await groupMultiselect({
    message: "Choose integration packs",
    options: groupedPromptOptions(listIntegrationOptions(profile)),
    initialValues: defaults,
    required: true,
  });

  exitIfCancel(selected);

  if (
    !Array.isArray(selected) ||
    !selected.every((integration) => typeof integration === "string")
  ) {
    throw new Error("Selected integration values must be strings.");
  }

  return selected;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<{ id: string, target?: string }[]>}
 */
async function promptForAiArtifacts(options) {
  if (options.aiArtifacts.length > 0 || options.assumeYes) {
    return options.aiArtifacts;
  }

  const artifactOptions = listAiArtifactOptions();
  const selected = await groupMultiselect({
    message: "Choose AI artifacts",
    options: groupedPromptOptions(artifactOptions),
    initialValues: [],
    required: false,
  });

  exitIfCancel(selected);

  if (!Array.isArray(selected) || !selected.every((artifact) => typeof artifact === "string")) {
    throw new Error("Selected AI artifact values must be strings.");
  }

  /** @type {{ id: string, target?: string }[]} */
  const aiArtifacts = [];

  for (const id of selected) {
    const artifact = artifactOptions.find((option) => option.id === id);

    if (!artifact?.defaultTarget) {
      aiArtifacts.push({ id });
      continue;
    }

    const target = await text({
      message: `Target directory for ${artifact.label}`,
      defaultValue: artifact.defaultTarget,
      placeholder: artifact.defaultTarget,
    });

    exitIfCancel(target);
    aiArtifacts.push({ id, target: typeof target === "string" ? target : artifact.defaultTarget });
  }

  return aiArtifacts;
}

/**
 * @param {CliOptions} options
 * @returns {Promise<InitResult>}
 */
export async function initRecipe(options) {
  if (!options.json) {
    console.clear();
    intro("Compose your Calavera tooling recipe");
  }

  const detectedPackageJSON = await readPackageJSONIfPresent();
  const detectedPackageManager = assertSupportedPackageManager(
    detectPackageManager(detectedPackageJSON) ?? "npm",
  );
  const profile = await promptForProfile(options);
  const packageManager = await promptForPackageManager(options, detectedPackageManager);
  const integrations = await promptForIntegrations(options, profile);
  const aiArtifacts = await promptForAiArtifacts(options);
  const recipe = composeRecipe({
    profile,
    packageManager,
    tools: integrations,
    aiArtifacts,
  });
  const validation = validateRecipeResponse(recipe);
  const explanation = explainRecipeResponse(recipe);

  await writeJSON(options.config, recipe, options.dryRun);

  if (!options.json) {
    note(formatRecipeSummary(recipe, explanation), "Recipe summary");
  }

  /** @type {ApplyResult | undefined} */
  let applyDryRun;
  /** @type {ApplyResult | undefined} */
  let applyResult;

  if (options.apply) {
    applyDryRun = await applyRecipeObject(recipe, {
      ...options,
      dryRun: true,
      assumeYes: true,
      packageManager,
    });

    if (!options.json) {
      note(formatApplySummary(applyDryRun), "Apply dry run");
    }

    const shouldApply =
      options.assumeYes ||
      (await confirm({
        message: "Apply these Calavera-managed changes now?",
        initialValue: false,
      }));

    exitIfCancel(shouldApply);

    if (shouldApply && !options.dryRun) {
      // Install the artifact versions the approved dry run showed, not whatever the tag
      // resolves to now.
      applyResult = await applyRecipeObject(recipe, {
        ...options,
        dryRun: false,
        assumeYes: true,
        packageManager,
        approvedArtifacts: applyDryRun.autoInstalledArtifacts,
      });
    }
  }

  if (!options.json) {
    outro(
      applyResult
        ? "Calavera recipe composed and applied."
        : `Calavera recipe ${options.dryRun ? "previewed" : "written"}.`,
    );
  }

  return {
    command: "init",
    config: options.config,
    dryRun: options.dryRun,
    recipe,
    validation,
    explanation,
    applyDryRun,
    applyResult,
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
    const integrations = resolveRecipeIntegrations(recipe);
    const aiArtifacts = resolveAiArtifacts(recipe);
    const expectedFiles = [
      integrations.some((integration) => integration.id === "editorconfig")
        ? ".editorconfig"
        : null,
      integrations.some((integration) => integration.id === "stylelint")
        ? ".stylelintrc.json"
        : null,
      integrations.some((integration) => integration.id === "html-validate")
        ? ".htmlvalidate.json"
        : null,
      integrations.some((integration) => integration.id === "html-validate")
        ? ".htmlvalidateignore"
        : null,
      integrations.some((integration) => integration.id === "react-doctor")
        ? "react-doctor.config.json"
        : null,
      integrations.some((integration) => integration.id === "knip") ? "knip.json" : null,
    ].filter(isNotEmptyString);

    for (const file of expectedFiles) {
      if (!(await fileExists(file))) {
        issues.push({
          level: "warning",
          message: `Missing managed file: ${file}. Run create-project-calavera apply to regenerate managed files.`,
        });
      }
    }

    if (
      integrations.some((integration) => integration.id === "varlock") &&
      !(await fileExists(".env.schema"))
    ) {
      issues.push({
        level: "warning",
        message:
          "Missing Varlock schema: .env.schema. Run create-project-calavera apply to scaffold it.",
      });
    }

    for (const artifact of aiArtifacts) {
      await assertAiSourceExists(artifact.type, artifact.sourcePath, artifact.index);

      for (const path of aiArtifactOutputPaths(artifact)) {
        if (!(await fileExists(path))) {
          issues.push({
            level: "warning",
            message: `Missing managed AI ${artifact.type}: ${path}. Run create-project-calavera apply to regenerate managed AI artifacts.`,
          });
        }
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
 * @param {Integration[]} integrations
 * @returns {string[]}
 */
function expectedManagedFiles(integrations) {
  return [
    integrations.some((integration) => integration.id === "editorconfig") ? ".editorconfig" : null,
    integrations.some((integration) => integration.id === "stylelint") ? ".stylelintrc.json" : null,
    integrations.some((integration) => integration.id === "html-validate")
      ? ".htmlvalidate.json"
      : null,
    integrations.some((integration) => integration.id === "html-validate")
      ? ".htmlvalidateignore"
      : null,
    integrations.some((integration) => integration.id === "react-doctor")
      ? "react-doctor.config.json"
      : null,
    integrations.some((integration) => integration.id === "knip") ? "knip.json" : null,
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
  const integrations = resolveRecipeIntegrations(recipe);
  const expectedAiPaths = new Set(resolveAiArtifacts(recipe).flatMap(aiArtifactOutputPaths));
  const expectedFiles = new Set(expectedManagedFiles(integrations));
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
        await unlink(await assertWorkspacePath(file.path, process.cwd(), "Managed file path"));
      }
    }

    for (const artifact of staleAiArtifactsSafeToRemove) {
      await rm(await assertWorkspacePath(artifact.path, process.cwd(), "AI artifact path"), {
        force: true,
        recursive: true,
      });
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

function formatHelp() {
  return `create-project-calavera ${packageJson.version}

Usage:
  create-project-calavera [command] [options]

Commands:
  init                 Compose calavera.config.json interactively or from flags
  agent-init           Bootstrap agent guidance, MCP notes, and the Calavera skill
  bootstrap            Alias for agent-init
  apply                Apply the recipe in calavera.config.json
  doctor               Check whether Calavera-managed files are present
  update               Re-apply the recipe in calavera.config.json
  clean                Remove stale Calavera-managed files when safe
  artifacts install    Install exact package-backed artifact selections
  artifacts status     Inspect locked artifacts offline by default
  artifacts doctor     Check installed artifacts and local edits
  artifacts migrate    Convert legacy recipe paths to stable artifact IDs
  artifacts update     Update one artifact ID, or every artifact with --all
  help                 Show this help

Options:
  --init               Bootstrap agent guidance, MCP notes, and the Calavera skill
  --new [args]         Scaffold a new project with vp create, then run --init there
                       Every token after --new goes to vp create unchanged
  --dry-run            Preview writes without changing files
  --apply              Preview and optionally apply after composing a recipe
  --config <path>      Recipe path, defaults to calavera.config.json
                       Before --new: copy this recipe into the new project
  --package-manager    npm, pnpm, yarn, or bun
  --profile            default or minimal
  --tool <id>          Add an integration by id or label; repeatable
  --ai-artifact <id>   Add a bundled AI artifact; repeatable
  --tag <channel>      Artifact release channel: latest (default) or next
  --all                Update every selected artifact
  --check-updates      Allow artifacts status to query the registry
  --agents-md <mode>   append or fallback when AGENTS.md already exists
  --mcp-harness <host> claude-code, codex, cursor, opencode, or skip
  --json               Print JSON output
  --yes                Use defaults and skip prompts
  --no-install         Write files without installing dependencies during apply
  --reown-managed-file <path>
                      Treat a tracked managed file's current contents as approved
  -h, --help           Show this help

Agent-first setup:
  npm create project-calavera -- --init
  pnpm dlx create-project-calavera --init
  yarn dlx create-project-calavera --init
  bunx create-project-calavera --init

MCP-first workflow:
  1. Run the agent bootstrap command above from the project root.
  2. Choose exactly one project-local MCP host when prompted, or skip for manual setup.
  3. Reload or restart the agent session if required by your MCP host.
  4. Confirm these tools are visible before composing a recipe:
     inspect_project, list_profiles, list_integrations, list_ai_artifacts,
     compose_recipe, validate_recipe, explain_recipe, dry_run_apply, apply_recipe.

Package-runner syntax:
  npm create needs -- before Calavera flags, for example:
    npm create project-calavera -- --init
    npm create project-calavera apply -- --dry-run

  Direct binary launchers do not need an extra -- before Calavera flags:
    npx --package create-project-calavera@${packageJson.version} create-project-calavera --help
    npx --package create-project-calavera@${packageJson.version} create-project-calavera --init

  MCP launch commands run create-project-calavera-mcp directly; do not add --help
  or inspect npm cache internals as a substitute for MCP setup.

  Calavera only writes project-local MCP config. Global host config is manual.`;
}

function printHelp() {
  console.info(formatHelp());
}

/**
 * @param {CommandResult} result
 * @param {boolean} [asJSON]
 * @param {boolean} [commandDryRun]
 */
function printResult(result, asJSON = false, commandDryRun = false) {
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
    const dryRun = result.dryRun ?? commandDryRun;
    logger.info(result.message);

    for (const change of result.changes) {
      if (change.type === "delete") {
        logger.info(dryRun ? `Would remove ${change.path}` : `Removed ${change.path}`);
      }

      if (change.type === "skip") {
        logger.info(
          dryRun
            ? `Would skip ${change.path}: ${change.reason}`
            : `Skipped ${change.path}: ${change.reason}`,
        );
      }
    }

    return;
  }

  if (result.command === "new") {
    if (result.dryRun) {
      logger.info("Calavera --new dry run. Nothing was run and no files were changed.");

      for (const line of result.confirmation) {
        logger.info(line);
      }
      return;
    }

    if (!result.bootstrap) {
      logger.info("Canceled. vp create was not run and no files were changed.");
      return;
    }

    logger.success(`Vite+ scaffolded ${result.target}. Vite+ detection: managed.`);

    if (result.recipe) {
      logger.success(`Copied ${result.recipe.source} to ${result.recipe.path}.`);
    }

    printResult(result.bootstrap);
    return;
  }

  if (result.command === "agent-init") {
    if (result.dryRun) {
      logger.info("Calavera agent bootstrap dry run complete. No files were changed.");
    } else {
      logger.success("Calavera agent bootstrap complete.");
    }

    for (const change of result.changes) {
      if (change.type === "write") {
        logger.info(result.dryRun ? `Would write ${change.path}` : `Wrote ${change.path}`);
      }

      if (change.type === "skip") {
        logger.info(
          result.dryRun
            ? `Would skip ${change.path}: ${change.reason}`
            : `Skipped ${change.path}: ${change.reason}`,
        );
      }

      if (change.type === "update") {
        logger.info(
          result.dryRun
            ? `Would update ${change.path}: ${change.reason}`
            : `Updated ${change.path}: ${change.reason}`,
        );
      }
    }

    for (const pointer of result.pointers) {
      logger.info(pointer);
    }

    logger.info(
      result.mcp.action === "manual"
        ? `MCP auto-config skipped: ${result.mcp.reason}`
        : `MCP auto-config ${result.mcp.action}: ${result.mcp.path}`,
    );
    logger.info("Review the files above to confirm what Calavera changed or skipped.");
    logger.info(`Next prompt: ${result.nextPrompt}`);

    for (const line of result.nextSteps) {
      logger.info(line);
    }
    return;
  }

  if (result.command === "init") {
    if (result.dryRun) {
      logger.info(`Calavera recipe dry run complete. Would write ${result.config}.`);
    } else {
      logger.success(`Wrote ${result.config}.`);
    }

    logger.info(`Profile: ${result.recipe.profile}`);
    logger.info(`Package manager: ${result.recipe.packageManager}`);
    logger.info(`Integrations: ${(result.recipe.integrations ?? []).join(", ")}`);

    if (Array.isArray(result.recipe.ai) && result.recipe.ai.length > 0) {
      logger.info(`AI artifacts: ${result.recipe.ai.length}`);
    }

    if (result.applyDryRun && !result.applyResult) {
      logger.info("Apply was previewed but not run.");
    }

    if (result.applyResult) {
      logger.success("Calavera apply complete.");
      for (const pointer of result.applyResult.pointers) {
        logger.info(pointer);
      }
    }

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
      if (result.installCommand) {
        logger.info(`Dev dependency install command: ${result.installCommand}`);
      }

      for (const note of result.installNotes) {
        logger.info(note);
      }
    } else {
      logger.info("Dev dependencies: none");
    }

    for (const line of result.vitePlus.lines) {
      logger.info(line);
    }

    for (const finding of result.projectInspection.findings) {
      logger.info(`Inspection ${finding.severity}: ${finding.message}`);
    }

    for (const artifact of result.autoInstalledArtifacts) {
      logger.info(
        `Would resolve and lock artifact ${artifact.id} at ${artifact.package}@${artifact.version}`,
      );
    }

    for (const change of result.changes) {
      if (change.type === "write") {
        if (change.category === "ai") {
          logger.info(`Would write AI ${change.aiType} ${change.name} to ${change.path}`);
        } else if (change.ownership === "calavera") {
          logger.info(`Would write and own ${change.path}`);
        } else if (change.action === "scaffold") {
          logger.info(`Would scaffold ${change.path}`);
        } else if (change.action === "merge") {
          logger.info(`Would merge ${change.path}`);
        } else {
          logger.info(`Would write ${change.path}`);
        }
      }

      if (change.type === "unchanged") {
        logger.info(`Unchanged ${change.path}`);

        if (change.scripts && change.scripts.length > 0) {
          logger.info(`Scripts already set: ${change.scripts.join(", ")}`);
        }

        for (const omittedScript of change.omittedScripts ?? []) {
          logger.info(`Would omit script ${omittedScript.script}: ${omittedScript.reason}`);
        }

        for (const { step, reason } of change.omittedQualitySteps ?? []) {
          logger.info(`Would omit ${step} from script quality: ${reason}`);
        }
      }

      if (change.type === "update") {
        logger.info(`Would update ${change.path}`);

        // Only the package.json change carries scripts.
        if (change.scripts) {
          // JSON string quoting keeps each value on one line, exactly as written.
          for (const { script, value, previous } of result.scriptChanges) {
            logger.info(
              previous === undefined
                ? `Would add script ${script}: ${JSON.stringify(value)}`
                : `Would change script ${script} from ${JSON.stringify(previous)} to ${JSON.stringify(value)}`,
            );
          }

          const changedScripts = new Set(result.scriptChanges.map(({ script }) => script));
          const unchangedScripts = change.scripts.filter((script) => !changedScripts.has(script));
          if (unchangedScripts.length > 0) {
            logger.info(`Scripts already set: ${unchangedScripts.join(", ")}`);
          }
        }

        if (change.removedDefaultTestScript) {
          logger.info("Would remove the default npm test placeholder script");
        }

        for (const { from, to } of change.renamedScripts ?? []) {
          logger.info(`Would rename script ${from} to ${to}`);
        }

        for (const omittedScript of change.omittedScripts ?? []) {
          logger.info(`Would omit script ${omittedScript.script}: ${omittedScript.reason}`);
        }

        for (const { step, reason } of change.omittedQualitySteps ?? []) {
          logger.info(`Would omit ${step} from script quality: ${reason}`);
        }
      }
    }

    if (
      result.changes.length > 0 &&
      result.changes.every(({ type }) => type === "unchanged") &&
      result.autoInstalledArtifacts.length === 0
    ) {
      logger.info("Nothing to change: the project already matches this recipe.");
    }

    for (const pointer of result.pointers ?? []) {
      logger.info(`Pointer: ${pointer}`);
    }

    return;
  }

  logger.success(`Calavera ${result.command} complete.`);

  if (result.command === "apply") {
    for (const artifact of result.autoInstalledArtifacts) {
      logger.info(
        `Resolved and locked artifact ${artifact.id} at ${artifact.package}@${artifact.version}`,
      );
    }

    for (const pointer of result.pointers) {
      logger.info(pointer);
    }
  }
}

async function main() {
  const options = parseArgs(args);

  if (options.command === "help") {
    printHelp();
    return;
  }

  if (options.command === "init") {
    printResult(await initRecipe(options), options.json);
    return;
  }

  if (options.command === "agent-init" || options.command === "bootstrap") {
    printResult(await agentBootstrap(options), options.json);
    return;
  }

  if (options.command === "new") {
    printResult(await newProject(options));
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
    printResult(await clean(options), options.json, options.dryRun);
    return;
  }

  if (options.command === "artifacts") {
    printResult(
      /** @type {ArtifactCommandResult} */ (await runArtifactCommand(options)),
      options.json,
    );
    return;
  }

  logger.error(`Unknown command: ${options.command}`);
  process.exitCode = 1;
}

/**
 * Runs the CLI with the process arguments. `bin/create-project-calavera.js`
 * calls it once the Node.js version check passes.
 */
export async function runCli() {
  try {
    await main();
  } catch (error) {
    if (error instanceof FileWriteError) {
      logger.error(error.message);
      logger.error(error.cause);
    } else {
      logger.error(error);
    }
    process.exitCode = 1;
  }
}

// Running this module directly, as the tests and local development do, skips
// the bin's Node.js version check.
function isDirectEntryPoint() {
  if (!process.argv[1]) {
    return false;
  }

  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isDirectEntryPoint()) {
  await runCli();
}
