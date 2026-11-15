#!/usr/bin/env node
// Runs the cli-experience exit rehearsal (#918) against the packed release candidate and prints a
// pass or fail result for every check in Section 0 of docs/cross-repo/sequencing-map.md.
//
//   pnpm release:rehearse:cli                      pinned mode, the exit-condition evidence
//   pnpm release:rehearse:cli --mode latest        the Vite+ that users get today
//   pnpm release:rehearse:cli --runs 2             run twice and compare the results
//
// Every run gets new temporary directories and an empty HOME, npm cache, Corepack home, pnpm
// store, and Yarn and Bun caches, and deletes them afterwards, also after a failure.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { devNull, homedir, platform, release, tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, stripVTControlCharacters } from "node:util";

import { isolatedGitEnv } from "../packages/cli/scripts/git-isolation.mjs";
import { cliExperienceChecks } from "./rehearsal-checks.mjs";
import { CheckFailure, describeExit, tail } from "./rehearsal-failure.mjs";
import { VITE_PLUS_PACKAGES, startRegistry } from "./rehearsal-registry.mjs";

const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const pinsPath = fileURLToPath(new URL("./rehearsal-pins.json", import.meta.url));
const COMMAND_TIMEOUT_MS = 10 * 60_000;

/**
 * @typedef {{ id: string, name: string, issues: string[], status: "pass" | "fail", expected?: string, actual?: string, command?: string }} CheckResult
 * @typedef {import("./rehearsal-failure.mjs").CommandResult} CommandResult
 */

/** @param {string} token */
function quote(token) {
  return /^[\w@%+=:,./^~-]+$/.test(token) ? token : `'${token.replaceAll("'", `'\\''`)}'`;
}

/** @param {string} command @param {string[]} args @param {string} cwd */
export function formatCommand(command, args, cwd) {
  return `(cd ${quote(cwd)} && ${[command, ...args].map(quote).join(" ")})`;
}

/**
 * Starts `command` without a shell, with stdin closed, and collects its output. A command that
 * outlives `timeout` is killed together with every process it started.
 *
 * @param {string} command
 * @param {string[]} args
 * @param {{ cwd: string, env: NodeJS.ProcessEnv, timeout?: number }} options
 * @returns {Promise<CommandResult>}
 */
/**
 * The process groups of the commands running now, so an interrupted run can stop them before it
 * deletes its directory. Each command runs in its own group, which a terminal's Ctrl-C does not reach.
 */
const liveGroups = new Set();

export function runCommand(command, args, { cwd, env, timeout = COMMAND_TIMEOUT_MS }) {
  return new Promise((resolvePromise) => {
    const display = formatCommand(command, args, cwd);
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });
    liveGroups.add(child.pid);
    // Decode as a stream, so a multibyte character split across two chunks stays intact.
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let stderr = "";
    let output = "";
    let timedOut = false;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      output += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup(child.pid);
    }, timeout);
    /** @param {number | null} exitCode @param {string | null} signal @param {string} [error] */
    const finish = (exitCode, signal, error) => {
      clearTimeout(timer);
      // A package manager may leave a child running after it exits; do not let it outlive the run.
      killGroup(child.pid);
      liveGroups.delete(child.pid);
      resolvePromise({
        exitCode,
        signal,
        timedOut,
        stdout: stripVTControlCharacters(stdout),
        stderr: stripVTControlCharacters(stderr),
        output: stripVTControlCharacters(error ? `${output}${error}\n` : output),
        display,
      });
    };
    child.on("error", (error) =>
      finish(null, null, `Could not start ${command}: ${error.message}`),
    );
    child.on("close", (code, signal) => finish(code, signal));
  });
}

/** @param {number | undefined} pid */
function killGroup(pid) {
  if (pid === undefined) return;
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // The group has already exited.
  }
}

// Variables a run keeps from the caller's environment: locale, identity, and how to reach the
// network. Everything else, including npm_config_*, COREPACK_*, YARN_*, BUN_*, PNPM_HOME, XDG_*,
// GIT_*, NODE_OPTIONS, and CI, is dropped so the caller's setup cannot change the result.
const INHERITED_VARIABLES = [
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "USER",
  "LOGNAME",
  "SHELL",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
];

/**
 * The run's own directories, all below `root`. `home` holds every per-user cache and setting, so
 * a check can get a second, empty home with the same root.
 *
 * @param {string} root
 * @param {string} [home]
 */
export function runDirectories(root, home = join(root, "home")) {
  return {
    root,
    home,
    tmp: join(root, "tmp"),
    bin: join(root, "bin"),
    corepack: join(root, "corepack"),
    corepackHome: join(root, "corepack-home"),
    npmGlobal: join(root, "npm-global"),
    npmCache: join(home, ".npm"),
    xdgCache: join(home, ".cache"),
    xdgConfig: join(home, ".config"),
    xdgData: join(home, ".local", "share"),
    xdgState: join(home, ".local", "state"),
    yarnCache: join(home, ".yarn", "cache"),
    bunCache: join(home, ".bun", "install", "cache"),
    packs: join(root, "packs"),
    tools: join(root, "tools"),
    projects: join(root, "projects"),
  };
}

/**
 * The environment every command of a run gets. Every home, cache, store, and configuration file
 * is inside the run's root, and npm, pnpm, Yarn, Bun, and Calavera's artifact resolver talk to the
 * rehearsal registry. Corepack downloads pnpm and Yarn from the public registry, which it reads
 * from COREPACK_NPM_REGISTRY, not from these settings; their versions are pinned either way.
 *
 * @param {ReturnType<typeof runDirectories>} dirs
 * @param {string} registryUrl
 * @param {{ base?: NodeJS.ProcessEnv, nodeDirectory: string, bunDirectory?: string }} options
 * @returns {NodeJS.ProcessEnv}
 */
export function buildEnvironment(
  dirs,
  registryUrl,
  { base = process.env, nodeDirectory, bunDirectory },
) {
  const inherited = Object.fromEntries(
    INHERITED_VARIABLES.flatMap((name) => (base[name] === undefined ? [] : [[name, base[name]]])),
  );
  const git = Object.fromEntries(
    Object.entries(
      isolatedGitEnv(devNull, {
        "init.defaultBranch": "main",
        "user.name": "Calavera Rehearsal",
        "user.email": "rehearsal@example.invalid",
        "commit.gpgSign": "false",
      }),
    ).filter(([name]) => name.startsWith("GIT_")),
  );
  const path = [
    dirs.bin,
    nodeDirectory,
    ...(bunDirectory ? [bunDirectory] : []),
    join(dirs.npmGlobal, "bin"),
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
    "/usr/sbin",
    "/sbin",
  ];
  return {
    ...inherited,
    ...git,
    PATH: [...new Set(path)].join(delimiter),
    HOME: dirs.home,
    TMPDIR: dirs.tmp,
    XDG_CACHE_HOME: dirs.xdgCache,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_STATE_HOME: dirs.xdgState,
    NO_COLOR: "1",
    DO_NOT_TRACK: "1",
    npm_config_registry: `${registryUrl}/`,
    npm_config_cache: dirs.npmCache,
    npm_config_userconfig: join(dirs.home, ".npmrc"),
    npm_config_globalconfig: join(dirs.root, "npmrc-global"),
    npm_config_prefix: dirs.npmGlobal,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    COREPACK_HOME: dirs.corepackHome,
    COREPACK_DEFAULT_TO_LATEST: "0",
    COREPACK_ENABLE_AUTO_PIN: "0",
    COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
    COREPACK_ENV_FILE: "0",
    YARN_NPM_REGISTRY_SERVER: registryUrl,
    YARN_UNSAFE_HTTP_WHITELIST: "127.0.0.1",
    YARN_CACHE_FOLDER: dirs.yarnCache,
    YARN_GLOBAL_FOLDER: join(dirs.home, ".yarn", "berry"),
    YARN_ENABLE_TELEMETRY: "0",
    BUN_CONFIG_REGISTRY: `${registryUrl}/`,
    BUN_INSTALL_CACHE_DIR: dirs.bunCache,
    BUN_INSTALL: join(dirs.home, ".bun"),
  };
}

/** The variables that hold a home, cache, store, or configuration file; each must be inside the run. */
const ISOLATED_PATH_VARIABLES = [
  "HOME",
  "TMPDIR",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_STATE_HOME",
  "npm_config_cache",
  "npm_config_userconfig",
  "npm_config_globalconfig",
  "npm_config_prefix",
  "COREPACK_HOME",
  "YARN_CACHE_FOLDER",
  "YARN_GLOBAL_FOLDER",
  "BUN_INSTALL_CACHE_DIR",
  "BUN_INSTALL",
];

/** The variables that name the registry; each must point at the rehearsal registry. */
const REGISTRY_VARIABLES = [
  "npm_config_registry",
  "YARN_NPM_REGISTRY_SERVER",
  "BUN_CONFIG_REGISTRY",
];

/**
 * Where a command's environment leaves the run: a home, cache, or store outside `root`, or a
 * registry other than the rehearsal's. Empty when the command is isolated.
 *
 * @param {NodeJS.ProcessEnv} env
 * @param {string} root
 * @param {string[]} registryUrls The rehearsal registries this run started.
 */
export function isolationViolations(env, root, registryUrls) {
  return [
    ...ISOLATED_PATH_VARIABLES.flatMap((name) => {
      const value = env[name];
      if (value === undefined) return [`${name} is not set`];
      return value === root || value.startsWith(`${root}/`) ? [] : [`${name} is ${value}`];
    }),
    ...REGISTRY_VARIABLES.flatMap((name) => {
      const value = env[name];
      if (value === undefined) return [`${name} is not set`];
      return registryUrls.includes(value.replace(/\/$/, "")) ? [] : [`${name} is ${value}`];
    }),
  ];
}

/**
 * The configuration files, caches, and stores under the developer's HOME that a run must not
 * change.
 *
 * @param {string} home
 * @param {NodeJS.ProcessEnv} [env]
 */
export function developerStatePaths(home, env = process.env) {
  return [
    join(home, ".npmrc"),
    join(home, ".npm"),
    env.COREPACK_HOME ?? join(home, ".cache", "node", "corepack"),
    join(home, ".cache", "pnpm"),
    join(home, ".local", "share", "pnpm"),
    join(home, "Library", "pnpm"),
    join(home, "Library", "Caches", "pnpm"),
    join(home, ".yarn"),
    join(home, ".yarnrc.yml"),
    join(home, ".bun"),
    join(home, ".gitconfig"),
  ];
}

/**
 * Starts watching the developer's state: records which paths exist and leaves a marker file whose
 * modification time is the start of the run. `changes()` then lists every path that appeared and
 * every file written since the marker, at any depth.
 *
 * A store can hold millions of entries, so this compares file times with `find -newer` instead of
 * listing names. Only files count: a temporary entry that another process created and removed in
 * a shared cache during the run changes a directory's time, not the cache's contents.
 *
 * @param {string} home
 * @param {string} markerDirectory
 * @param {NodeJS.ProcessEnv} [env]
 */
export async function watchDeveloperState(home, markerDirectory, env = process.env) {
  const paths = developerStatePaths(home, env);
  const existed = new Set(paths.filter((path) => existsSync(path)));
  const marker = join(await mkdtemp(join(markerDirectory, "calavera-rehearsal-marker-")), "start");
  await writeFile(marker, "");
  return {
    async changes() {
      const appeared = paths.filter((path) => existsSync(path) && !existed.has(path));
      const present = paths.filter((path) => existsSync(path));
      const found =
        present.length === 0
          ? { stdout: "" }
          : await runCommand("find", [...present, "-type", "f", "-newer", marker, "-print"], {
              cwd: markerDirectory,
              env: process.env,
            });
      await rm(dirname(marker), { recursive: true, force: true });
      const written = found.stdout.split("\n").filter(Boolean);
      return [...new Set([...appeared, ...written])].map((path) => path.replace(home, "~"));
    },
  };
}

/**
 * Replaces the run's root with `<run>` so results from different runs compare equal and no
 * temporary path reaches a report.
 *
 * @param {CheckResult} result
 * @param {string} root
 */
function scrub(result, root) {
  /** @param {string | undefined} value */
  const clean = (value) => value?.replaceAll(root, "<run>");
  return {
    ...result,
    expected: clean(result.expected),
    actual: clean(result.actual),
    command: clean(result.command),
  };
}

/**
 * @typedef {{
 *   id: string,
 *   name: string,
 *   issues: string[],
 *   run: (context: any) => Promise<void>,
 * }} Check
 */

/**
 * Runs every check against a prepared run, records the versions it used, and always deletes the
 * run's root, also after a failure in setup or in a check.
 *
 * @param {{
 *   mode: "pinned" | "latest",
 *   pins: Record<string, string>,
 *   checks: Check[],
 *   prepare: (dirs: ReturnType<typeof runDirectories>, options: { mode: "pinned" | "latest", pins: Record<string, string>, versions: Record<string, string> }) => Promise<{ close?: () => Promise<void>, lastCommand?: () => string | undefined } & Record<string, unknown>>,
 *   tmpRoot?: string,
 *   developerHome?: string,
 *   log?: (line: string) => void,
 * }} options
 */
export async function runRehearsal({
  mode,
  pins,
  checks,
  prepare,
  tmpRoot = tmpdir(),
  developerHome = homedir(),
  log = () => {},
}) {
  const developerState = await watchDeveloperState(developerHome, tmpRoot);
  const root = await realpath(await mkdtemp(join(tmpRoot, "calavera-rehearsal-")));
  const dirs = runDirectories(root);
  /** @type {CheckResult[]} */
  const results = [];
  /**
   * Filled in by `prepare` as each version becomes known, so a failed setup still reports the
   * versions it reached.
   *
   * @type {Record<string, string>}
   */
  const versions = {};
  /** @type {Awaited<ReturnType<typeof prepare>> | undefined} */
  let context;
  // An interrupted run still deletes its directory. The handler is removed when the run ends.
  const onSignal = (/** @type {NodeJS.Signals} */ signal) => {
    for (const pid of liveGroups) killGroup(pid);
    rmSync(root, { recursive: true, force: true });
    process.exit(signal === "SIGINT" ? 130 : 143);
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    for (const dir of Object.values(dirs)) await mkdir(dir, { recursive: true });
    context = await prepare(dirs, { mode, pins, versions });
    for (const check of checks) {
      log(`Running ${check.id}: ${check.name}`);
      results.push(scrub(await runCheck(check, context), root));
    }
  } catch (error) {
    results.push(
      scrub(
        {
          id: "setup",
          name: "The rehearsal sets up its registry, package managers, and the release candidate",
          issues: ["#918"],
          status: "fail",
          expected: "setup to complete",
          actual: describeError(error),
          command: error instanceof CheckFailure ? error.command : context?.lastCommand?.(),
        },
        root,
      ),
    );
    // Every check still gets a row, so the table always lists each one with its result.
    for (const check of checks) {
      if (results.some(({ id }) => id === check.id)) continue;
      results.push({
        id: check.id,
        name: check.name,
        issues: check.issues,
        status: "fail",
        expected: "the check to run",
        actual: "not run: the rehearsal setup failed",
      });
    }
  } finally {
    await context?.close?.();
    await removeTree(root);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  const leftover = existsSync(root);
  results.push({
    id: "harness-cleanup",
    name: "No temporary directory remains after the run",
    issues: ["#918"],
    status: leftover ? "fail" : "pass",
    ...(leftover
      ? { expected: "the run's directory to be deleted", actual: "<run> still exists" }
      : {}),
  });
  // Isolation by construction: every command the rehearsal started had its homes, caches, and
  // registry inside the run. This is what the rehearsal controls, so a violation fails the run.
  const violations = context?.isolationViolations?.() ?? [];
  if (context?.isolationViolations) {
    results.push(
      scrub(
        {
          id: "harness-isolation",
          name: "Every command the rehearsal started used the run's own homes, caches, and registry",
          issues: ["#918"],
          status: violations.length === 0 ? "pass" : "fail",
          ...(violations.length === 0
            ? {}
            : {
                expected:
                  "HOME, TMPDIR, XDG_*, every cache and store, and the registry inside the run",
                actual: violations.join("\n"),
              }),
        },
        root,
      ),
    );
  }
  // Files written below the developer's HOME during the run. Other sessions and tools on the same
  // machine write to these caches too, and the rehearsal cannot tell their writes from its own, so
  // this is a warning: it must not fail a release gate because of an unrelated process.
  const changed = await developerState.changes();
  /** @type {string[]} */
  const warnings =
    changed.length === 0
      ? []
      : [
          `Files below the developer's HOME changed during the run: ${changed.slice(0, 20).join(", ")}${changed.length > 20 ? `, and ${changed.length - 20} more` : ""}. Another process may have written them; the harness-isolation check shows whether the rehearsal's own commands stayed inside the run.`,
        ];
  return {
    mode,
    versions,
    results,
    warnings,
    ok: results.every(({ status }) => status === "pass"),
  };
}

/** @param {unknown} error */
function describeError(error) {
  if (error instanceof CheckFailure) return error.actual;
  if (error instanceof Error) return error.message;
  return String(error);
}

/**
 * @param {Check} check
 * @param {Record<string, unknown> & { lastCommand?: () => string | undefined }} context
 * @returns {Promise<CheckResult>}
 */
export async function runCheck(check, context) {
  const base = { id: check.id, name: check.name, issues: check.issues };
  try {
    await check.run(context);
    return { ...base, status: "pass" };
  } catch (error) {
    if (error instanceof CheckFailure) {
      return {
        ...base,
        status: "fail",
        expected: error.expected,
        actual: error.actual,
        command: error.command ?? context.lastCommand?.(),
      };
    }
    return {
      ...base,
      status: "fail",
      expected: "the check to run to completion",
      actual: describeError(error),
      command: context.lastCommand?.(),
    };
  }
}

/** Deletes `path`, making read-only entries writable first if a plain delete fails. @param {string} path */
async function removeTree(path) {
  try {
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    await runCommand("chmod", ["-R", "u+w", path], { cwd: tmpdir(), env: process.env });
    await rm(path, { recursive: true, force: true, maxRetries: 3 });
  }
}

/**
 * The result table, then every failure with what was expected, what happened, and the command.
 *
 * @param {{ mode: string, versions: Record<string, string>, results: CheckResult[], warnings?: string[], ok: boolean }} report
 */
export function formatReport({ mode, versions, results, warnings = [], ok }) {
  const failed = results.filter(({ status }) => status === "fail");
  const lines = [
    `## cli-experience rehearsal, ${mode} mode: ${ok ? "PASS" : "FAIL"} (${results.length - failed.length} of ${results.length} checks pass)`,
    "",
    "### Versions",
    "",
    "| Tool | Version |",
    "| --- | --- |",
    ...Object.entries(versions).map(([tool, version]) => `| ${tool} | ${version} |`),
    "",
    "### Results",
    "",
    "| Result | Check | ID | Issues |",
    "| --- | --- | --- | --- |",
    ...results.map(
      ({ status, name, id, issues }) =>
        `| ${status === "pass" ? "pass" : "FAIL"} | ${name} | \`${id}\` | ${issues.join(", ")} |`,
    ),
  ];
  if (warnings.length > 0) {
    lines.push("", "### Warnings", "", ...warnings.map((warning) => `- ${warning}`));
  }
  if (failed.length > 0) {
    lines.push("", "### Failures");
    for (const result of failed) lines.push("", formatFailure(result));
  }
  return `${lines.join("\n")}\n`;
}

/** @param {CheckResult} result */
export function formatFailure({ id, name, expected, actual, command }) {
  return [
    `#### ${id}: ${name}`,
    "",
    `Expected: ${expected ?? "(not recorded)"}`,
    "",
    "Actual:",
    "",
    "```text",
    actual ?? "(not recorded)",
    "```",
    "",
    `Command: \`${command ?? "(none ran)"}\``,
  ].join("\n");
}

/**
 * The checks whose outcome differs between two runs; the runs give the same result when it is empty.
 *
 * @param {{ results: CheckResult[] }} first
 * @param {{ results: CheckResult[] }} second
 */
export function compareRuns(first, second) {
  const outcome = (/** @type {{ results: CheckResult[] }} */ run) =>
    new Map(run.results.map(({ id, status }) => [id, status]));
  const a = outcome(first);
  const b = outcome(second);
  return [...new Set([...a.keys(), ...b.keys()])]
    .filter((id) => a.get(id) !== b.get(id))
    .map((id) => `${id}: ${a.get(id) ?? "missing"} then ${b.get(id) ?? "missing"}`);
}

/**
 * Prepares a real run: the rehearsal registry, Corepack with the pinned pnpm and Yarn, the packed
 * release candidate, and the Calavera bins installed from it.
 *
 * @param {ReturnType<typeof runDirectories>} dirs
 * @param {{ mode: "pinned" | "latest", pins: Record<string, string>, versions: Record<string, string> }} options
 */
async function prepareRun(dirs, { mode, pins, versions }) {
  /** @type {Map<string, import("./rehearsal-registry.mjs").LocalPackage>} */
  const local = new Map();
  versions["Node.js"] = process.version;
  versions.OS = `${platform()} ${release()}`;
  const vitePlusVersion =
    mode === "pinned" ? pins.vitePlus : await latestVersion(VITE_PLUS_PACKAGES[0] ?? "vite-plus");
  if (!vitePlusVersion) throw new Error("No Vite+ version to hold the run at.");
  versions["Vite+"] = vitePlusVersion;
  const registry = await startRegistry({ local, vitePlusVersion });
  /** @type {Array<{ close: () => Promise<void> }>} */
  const closers = [registry];
  /** @type {string | undefined} */
  let lastCommand;
  const bunPath = await which("bun");
  const env = buildEnvironment(dirs, registry.url, {
    nodeDirectory: dirname(process.execPath),
    bunDirectory: bunPath ? dirname(bunPath) : undefined,
  });

  /**
   * @param {string} command
   * @param {string[]} args
   * @param {{ cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }} [options]
   */
  /** @type {string[]} */
  const violations = [];
  /** Registries a check starts, such as the one that advertises a newer Calavera. @type {Array<{ url: string }>} */
  const extraRegistries = [];
  /** @param {NodeJS.ProcessEnv} commandEnv @param {string} display */
  const recordEnvironment = (commandEnv, display) => {
    const registryUrls = [registry.url, ...extraRegistries.map(({ url }) => url)];
    for (const problem of isolationViolations(commandEnv, dirs.root, registryUrls)) {
      violations.push(`${display}: ${problem}`);
    }
  };
  const run = async (command, args, options = {}) => {
    recordEnvironment(options.env ?? env, formatCommand(command, args, options.cwd ?? dirs.root));
    const result = await runCommand(command, args, {
      cwd: options.cwd ?? dirs.root,
      env: options.env ?? env,
      timeout: options.timeout,
    });
    lastCommand = result.display;
    return result;
  };
  /** @param {string} command @param {string[]} args @param {{ cwd?: string }} [options] */
  const runOrThrow = async (command, args, options) => {
    const result = await run(command, args, options);
    if (result.exitCode !== 0) {
      throw new CheckFailure({
        expected: "exit code 0",
        actual: `${describeExit(result)}\n${tail(result.output)}`,
        command: result.display,
      });
    }
    return result;
  };

  /** @param {string} command @param {string[]} [args] */
  const version = async (command, args = ["--version"]) => {
    const result = await run(command, args, { cwd: dirs.tmp });
    return result.exitCode === 0
      ? (result.stdout.trim().split("\n")[0] ?? "")
      : `not available (${describeExit(result)})`;
  };

  try {
    versions.npm = await version("npm");
    versions.Bun = await version("bun");
    versions.Git = await version("git");
    await writeHomeNpmrc(dirs.home, registry.url);
    await writeFile(join(dirs.root, "npmrc-global"), "");

    // Corepack is not bundled with every Node.js release, so the run installs the pinned one.
    await runOrThrow("npm", ["install", "--prefix", dirs.corepack, `corepack@${pins.corepack}`]);
    const corepack = join(dirs.corepack, "node_modules", ".bin", "corepack");
    await runOrThrow(corepack, ["enable", "--install-directory", dirs.bin, "pnpm", "yarn"]);
    await runOrThrow(corepack, ["install", "-g", `pnpm@${pins.pnpm}`, `yarn@${pins.yarn}`]);
    versions.Corepack = await version(corepack);
    versions.pnpm = await version("pnpm");
    versions.Yarn = await version("yarn");

    for (const packed of await packReleaseCandidate(dirs, runOrThrow))
      local.set(packed.name, packed);
    const calavera = local.get("create-project-calavera");
    if (!calavera) throw new Error("Packing produced no create-project-calavera tarball.");
    versions["create-project-calavera"] =
      `${calavera.version} (${calavera.integrity.slice(0, 19)}…)`;
    await runOrThrow("npm", [
      "install",
      "--prefix",
      dirs.tools,
      `create-project-calavera@${calavera.version}`,
    ]);

    return {
      mode,
      pins,
      dirs,
      env,
      registry,
      local,
      vitePlusVersion,
      versions,
      repositoryRoot,
      calavera: {
        version: calavera.version,
        bin: join(dirs.tools, "node_modules", ".bin", "create-project-calavera"),
        mcpBin: join(dirs.tools, "node_modules", ".bin", "create-project-calavera-mcp"),
      },
      run,
      runOrThrow,
      /**
       * An environment with a new, empty home and caches, for a check that must start like a
       * person who has never run the command, such as a launcher that would otherwise reuse the
       * package another check put in the shared npm cache.
       *
       * @param {string} name
       */
      freshEnvironment: async (name) => {
        const home = join(dirs.root, "homes", name);
        const homeDirs = runDirectories(dirs.root, home);
        for (const dir of [
          home,
          homeDirs.xdgCache,
          homeDirs.xdgConfig,
          homeDirs.xdgData,
          homeDirs.xdgState,
        ]) {
          await mkdir(dir, { recursive: true });
        }
        await writeHomeNpmrc(home, registry.url);
        return buildEnvironment(homeDirs, registry.url, {
          nodeDirectory: dirname(process.execPath),
          bunDirectory: bunPath ? dirname(bunPath) : undefined,
        });
      },
      startRegistry: (/** @type {Omit<Parameters<typeof startRegistry>[0], "local">} */ options) =>
        startRegistry({ local, ...options }).then((extra) => {
          closers.push(extra);
          extraRegistries.push(extra);
          return extra;
        }),
      lastCommand: () => lastCommand,
      recordEnvironment,
      isolationViolations: () => [...new Set(violations)],
      close: async () => {
        for (const closer of closers) await closer.close();
      },
    };
  } catch (error) {
    await registry.close();
    throw error;
  }
}

/**
 * pnpm and Bun also read the registry from the user .npmrc, which is the run's own.
 *
 * @param {string} home
 * @param {string} registryUrl
 */
export async function writeHomeNpmrc(home, registryUrl) {
  await writeFile(join(home, ".npmrc"), `registry=${registryUrl}/\n`);
}

/** @param {string} name */
async function latestVersion(name) {
  const response = await fetch(`https://registry.npmjs.org/${name}`, {
    headers: { accept: "application/vnd.npm.install-v1+json" },
  });
  if (!response.ok)
    throw new Error(`Could not read ${name} from the npm registry: HTTP ${response.status}.`);
  const packument = /** @type {{ "dist-tags": Record<string, string> }} */ (await response.json());
  return packument["dist-tags"].latest;
}

/** @param {string} command */
async function which(command) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    const candidate = join(directory, command);
    if (directory && existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Packs the CLI, the packages it depends on from this workspace, and every artifact with the
 * pinned pnpm, which turns workspace: ranges into the versions that will be published.
 *
 * @param {ReturnType<typeof runDirectories>} dirs
 * @param {(command: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>} runOrThrow
 */
async function packReleaseCandidate(dirs, runOrThrow) {
  const artifactsRoot = join(repositoryRoot, "packages", "artifacts");
  const packageRoots = [
    join(repositoryRoot, "packages", "cli"),
    join(repositoryRoot, "packages", "artifact-core"),
    join(repositoryRoot, "packages", "baseline-core"),
    ...(await readdir(artifactsRoot, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map(({ name }) => join(artifactsRoot, name))
      .sort(),
  ];
  const packed = [];
  for (const [index, packageRoot] of packageRoots.entries()) {
    const destination = join(dirs.packs, String(index));
    await mkdir(destination, { recursive: true });
    await runOrThrow("pnpm", ["pack", "--pack-destination", destination], { cwd: packageRoot });
    const file = (await readdir(destination)).find((entry) => entry.endsWith(".tgz"));
    if (!file) throw new Error(`pnpm pack wrote no tarball for ${packageRoot}.`);
    const path = join(destination, file);
    const manifestResult = await runOrThrow("tar", ["-xOzf", path, "package/package.json"]);
    const manifest = JSON.parse(manifestResult.stdout);
    const bytes = await readFile(path);
    packed.push({
      name: manifest.name,
      version: manifest.version,
      path,
      manifest,
      integrity: `sha512-${createHash("sha512").update(bytes).digest("base64")}`,
      shasum: createHash("sha1").update(bytes).digest("hex"),
    });
  }
  return packed;
}

/** @param {string[]} argv */
export function parseOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      mode: { type: "string", default: "pinned" },
      runs: { type: "string", default: "1" },
      "report-file": { type: "string" },
      "json-file": { type: "string" },
    },
    allowPositionals: false,
  });
  if (values.mode !== "pinned" && values.mode !== "latest") {
    throw new Error(`--mode must be pinned or latest, not ${values.mode}.`);
  }
  const runs = Number(values.runs);
  if (!Number.isInteger(runs) || runs < 1)
    throw new Error(`--runs must be a whole number of 1 or more, not ${values.runs}.`);
  return {
    mode: /** @type {"pinned" | "latest"} */ (values.mode),
    runs,
    reportFile: values["report-file"],
    jsonFile: values["json-file"],
  };
}

/**
 * What the rehearsal needs from the machine before it starts: the pinned Node.js and Bun, which a
 * run cannot install for itself, and Git and tar. Each problem says how to fix it, so a release
 * gate stops before it creates anything, not halfway through. pnpm, Yarn, Corepack, and Vite+ are
 * installed at their pins by the run, and need only network access.
 *
 * @param {Record<string, string>} pins
 * @param {{ nodeVersion?: string, bunVersion?: () => Promise<string | undefined>, hasCommand?: (command: string) => Promise<boolean> }} [probe]
 */
export async function prerequisiteProblems(
  pins,
  {
    nodeVersion = process.version,
    bunVersion = installedBunVersion,
    hasCommand = async (command) => (await which(command)) !== undefined,
  } = {},
) {
  /** @type {string[]} */
  const problems = [];
  if (nodeVersion !== `v${pins.node}`) {
    problems.push(
      `Node.js v${pins.node} is required; this is ${nodeVersion}. Switch to Node.js ${pins.node}, the version in scripts/rehearsal-pins.json, with your Node.js version manager, then run the command again.`,
    );
  }
  const bun = await bunVersion();
  if (bun !== pins.bun) {
    problems.push(
      `Bun ${pins.bun} is required; ${bun === undefined ? "bun is not on PATH" : `bun --version prints ${bun}`}. Install Bun ${pins.bun} exactly, the version in scripts/rehearsal-pins.json, so that bun and bunx are on PATH and bun --version prints ${pins.bun}, then run the command again.`,
    );
  }
  for (const command of ["git", "tar"]) {
    if (!(await hasCommand(command))) {
      problems.push(
        `${command} is required and is not on PATH. Install it, then run the command again.`,
      );
    }
  }
  return problems;
}

async function installedBunVersion() {
  const bun = await which("bun");
  if (!bun) return undefined;
  const result = await runCommand(bun, ["--version"], { cwd: tmpdir(), env: process.env });
  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function main() {
  const options = parseOptions(process.argv.slice(2));
  const pins = JSON.parse(await readFile(pinsPath, "utf8"));
  const problems = await prerequisiteProblems(pins);
  if (problems.length > 0) {
    process.stderr.write(
      `The cli-experience rehearsal cannot start; nothing was created:\n${problems.map((problem) => `- ${problem}`).join("\n")}\n`,
    );
    process.exitCode = 2;
    return;
  }
  const checks = cliExperienceChecks;
  /** @type {Awaited<ReturnType<typeof runRehearsal>>[]} */
  const reports = [];
  for (let index = 0; index < options.runs; index += 1) {
    const report = await runRehearsal({
      mode: options.mode,
      pins,
      checks,
      prepare: prepareRun,
      log: (line) => process.stderr.write(`[run ${index + 1}] ${line}\n`),
    });
    reports.push(report);
    console.info(formatReport(report));
  }
  let text = reports.map(formatReport).join("\n");
  const differences = reports
    .slice(1)
    .flatMap((report, index) =>
      compareRuns(/** @type {typeof report} */ (reports[index]), report).map(
        (line) => `run ${index + 1} to run ${index + 2}: ${line}`,
      ),
    );
  if (reports.length > 1) {
    const summary =
      differences.length === 0
        ? `### Repeat runs\n\nAll ${reports.length} runs gave the same result for every check.\n`
        : `### Repeat runs\n\nThe runs gave different results:\n\n${differences.map((line) => `- ${line}`).join("\n")}\n`;
    console.info(summary);
    text += `\n${summary}`;
  }
  if (options.reportFile) await writeFile(options.reportFile, text);
  if (options.jsonFile) {
    await writeFile(options.jsonFile, `${JSON.stringify({ reports, differences }, null, 2)}\n`);
  }
  process.exitCode = reports.every(({ ok }) => ok) && differences.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  main().catch((error) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
