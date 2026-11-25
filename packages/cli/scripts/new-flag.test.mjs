// Tests for `--new` (ADR-0010). The CLI is spawned for real, and a stub
// placed first on PATH stands in for the package-manager runner, so these
// tests need neither network access nor vite-plus.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  NPM_STALE_CACHE_HINT,
  createVpCreateCommand,
  launchingPackageManager,
  newProject,
  parseArgs,
} from "../src/index.js";
import { listingViolations } from "../../../scripts/rehearsal-checks.mjs";
import { detectVitePlus } from "../src/vite-plus-detection.js";
import {
  NEXT_PROMPT_HEADING,
  printedNextPrompt,
  readmeAgentPrompt,
} from "./readme-agent-prompt.mjs";
import {
  createTemporaryFixture,
  json,
  libraryManifest,
  vitePlusConfig,
} from "./vite-plus-fixtures.mjs";

// These tests match the CLI's error output without the debug switch from #663, also when a
// developer has CALAVERA_DEBUG set in their shell; the CLI child processes inherit this environment.
delete process.env.CALAVERA_DEBUG;

const binPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fixturesUrl = pathToFileURL(
  fileURLToPath(new URL("./vite-plus-fixtures.mjs", import.meta.url)),
);

/**
 * The runner stub. It records its name, argv, cwd, VP_CLI_BIN, PATH, and whole
 * environment, fails as npm does when it inherits npm_config_package or
 * npm_config_call (#689), records in STUB_LOG.launcher the package manager
 * Vite+ would pick from the npm_config_user_agent its runner passes on (#1109),
 * strips the runner's own arguments to find what \`vp create\` receives, then acts on STUB_MODE:
 * `scaffold` writes a Vite+ project into the `--directory` target (or
 * STUB_TARGET) and, as `vp create` installs dependencies, a vite-plus whose
 * `vp fmt` formats what the bootstrap writes (#669), `unmanaged` writes a manifest without vite-plus, `unknown`
 * writes an unparseable manifest, `nothing` exits zero having written nothing,
 * and `fail` writes a partial manifest and exits 1. STUB_EXTRA names a second
 * directory that also receives a Vite+ manifest.
 */
const stubSource = `#!/usr/bin/env node
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { json, libraryManifest, plainViteManifest, vitePlusConfig, writeVitePlusFormatter } from ${JSON.stringify(fixturesUrl.href)};

const argv = process.argv.slice(2);

// Corepack's auto-pin (#999, #1080): Corepack adds a packageManager field when
// no package.json from the working directory up sets one. STUB_COREPACK_VERSION
// picks the rule: "0.32.0" pins unless COREPACK_ENABLE_AUTO_PIN is "0", as
// Corepack 0.32.0 and earlier do; any other value, or none, pins only when it is
// "1", as Corepack 0.33.0 to 0.36.0 do. Corepack writes the outermost
// package.json it found; this stub writes the nearest one instead, so it never
// walks past the test's own manifest. Corepack pins before it runs the package
// manager, so the Yarn reads below and the pnpm and yarn runners call this
// first. npm and bunx do not, because Corepack runs npm only after
// "corepack enable npm" and never runs Bun; vp create receives "0" under
// every runner in any case (#1080).
function autoPin(packageManager = "yarn@4.18.1") {
  const value = process.env.COREPACK_ENABLE_AUTO_PIN;
  const pins = process.env.STUB_COREPACK_VERSION === "0.32.0" ? value !== "0" : value === "1";
  if (!pins) return;
  for (let directory = process.cwd(); ; directory = dirname(directory)) {
    const manifestPath = join(directory, "package.json");
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      if (manifest.packageManager === undefined) {
        writeFileSync(manifestPath, json({ ...manifest, packageManager }));
      }
      return;
    }
    if (dirname(directory) === directory) return;
  }
}

// "yarn --version" and "yarn node": logged separately, so a test can show that Calavera never
// reads the Yarn version or probes for Corepack, which only the Yarn 1 hint did (ADR-0023).
if ((argv.length === 1 && argv[0] === "--version") || argv[0] === "node") {
  appendFileSync(process.env.STUB_LOG + ".yarn-read", JSON.stringify({ argv }) + "\\n");
  process.exit(0);
}

// Corepack's own pnpm and Yarn versions, which it would write.
const corepackPin = { pnpm: "pnpm@12.9.1", yarn: "yarn@4.18.1" }[basename(process.argv[1])];
if (corepackPin !== undefined) autoPin(corepackPin);

appendFileSync(
  process.env.STUB_LOG,
  JSON.stringify({
    runner: basename(process.argv[1]),
    argv,
    cwd: process.cwd(),
    vpCliBin: process.env.VP_CLI_BIN ?? null,
    path: process.env.PATH,
    env: process.env,
  }) + "\\n",
);

// How npm fails when it inherits these settings (#670, #689). npm reads the
// npm_config_ prefix in any case, so these checks do too. With package, it
// looks for create-vite-plus in the wrong package and exits 127. With call,
// it runs the inherited command line instead of create-vite-plus, which this
// stub reports as exit 3.
const inherited = (name) =>
  Object.keys(process.env).some((key) => key.toLowerCase() === "npm_config_" + name);
if (inherited("package")) {
  console.error("sh: create-vite-plus: command not found");
  process.exit(127);
}
if (inherited("call")) {
  console.error("ran the inherited npm_config_call instead of create-vite-plus");
  process.exit(3);
}

// npm create vite-plus@latest -- <args>, bunx create-vite-plus@latest <args>,
// and <pnpm|yarn> dlx create-vite-plus@latest <args>.
const runner = basename(process.argv[1]);

// The npm_config_user_agent create-vite-plus sees (#1109), from a probe on
// 2026-11-21 (npm 11.20.0, pnpm 12.9.1, Bun 1.3.9) of a stand-in bin that
// printed it: npm exec and bunx keep an inherited value and set their own only
// when none is inherited, and pnpm dlx replaces it. npm ignores an empty value
// (loadEnv in @npmcli/config); Bun was not probed with one. Yarn 2 or later replaces it
// too (makeScriptEnv in yarnpkg/berry scriptUtils.ts); its value is the one #909
// measured under Yarn 4.18.1.
const ownUserAgent = {
  npm: "npm/11.20.0 node/v26.13.1 darwin arm64 workspaces/false",
  bunx: "bun/1.3.9 npm/? node/v24.3.0 darwin arm64",
  pnpm: "pnpm/12.9.1 npm/? node/? darwin arm64",
  yarn: "yarn/4.18.1 npm/? node/v26.13.1 darwin arm64",
}[runner];
const launcherUserAgent =
  runner === "npm" || runner === "bunx"
    ? process.env.npm_config_user_agent || ownUserAgent
    : ownUserAgent;
// Vite+ picks the package manager of a new project from the name before the
// first / of that value, when it names one Vite+ supports
// (detectLauncherPackageManager in vite-plus packages/cli/src/create/utils.ts).
const launcherName = launcherUserAgent.split("/")[0];
appendFileSync(
  process.env.STUB_LOG + ".launcher",
  JSON.stringify({
    vitePlusPackageManager: ["npm", "pnpm", "yarn", "bun"].includes(launcherName)
      ? launcherName
      : null,
  }) + "\\n",
);
const vpCreateArgs =
  runner === "npm"
    ? argv.slice(argv.indexOf("--") + 1)
    : runner === "bunx"
      ? argv.slice(1)
      : argv.slice(2);
const separator = vpCreateArgs.indexOf("--");
const own = separator === -1 ? vpCreateArgs : vpCreateArgs.slice(0, separator);
const directoryIndex = own.indexOf("--directory");
const target = resolve(
  directoryIndex === -1 ? (process.env.STUB_TARGET ?? "my-lib") : own[directoryIndex + 1],
);

function writeProject(directory, manifest, withConfig) {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "package.json"), manifest);
  if (withConfig) writeFileSync(join(directory, "vite.config.ts"), vitePlusConfig);
}

const scaffoldManifest = process.env.STUB_PACKAGE_MANAGER
  ? { ...libraryManifest, packageManager: process.env.STUB_PACKAGE_MANAGER }
  : libraryManifest;

switch (process.env.STUB_MODE) {
  case "scaffold":
    writeProject(target, json(scaffoldManifest), true);
    await writeVitePlusFormatter(target);
    break;
  case "unmanaged":
    writeProject(target, json(plainViteManifest), false);
    break;
  case "unknown":
    writeProject(target, "{ not json", false);
    break;
  case "fail":
    writeProject(target, "{", false);
    process.exit(1);
  case "nothing":
  default:
    break;
}

if (process.env.STUB_EXTRA) {
  writeProject(resolve(process.env.STUB_EXTRA), json(libraryManifest), true);
}
`;

/**
 * A temporary directory, removed on dispose through createTemporaryFixture,
 * holding a `work` project directory, a `bin` directory with the stub runners
 * first on PATH, and the runner log.
 *
 * @param {string} label
 */
async function createTemporaryWorkspace(label) {
  const fixture = await createTemporaryFixture(`new-${label}`, {});
  const bin = join(fixture.root, "bin");
  const work = join(fixture.root, "work");
  const log = join(fixture.root, "runner.log");

  await mkdir(bin);
  await mkdir(work);

  for (const name of ["npm", "pnpm", "yarn", "bunx"]) {
    const path = join(bin, name);
    await writeFile(path, stubSource);
    await chmod(path, 0o755);
  }

  return {
    root: fixture.root,
    work,
    log,
    bin,
    [Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
  };
}

/**
 * The PATH runCli gives the CLI: the stub runners first, then the inherited PATH.
 *
 * @param {{ bin: string }} workspace
 * @returns {string}
 */
function stubPath(workspace) {
  return `${workspace.bin}${delimiter}${process.env.PATH ?? ""}`;
}

/**
 * The environment runCli starts the CLI with.
 *
 * @param {{ log: string, bin: string }} workspace
 * @param {Record<string, string>} env
 * @returns {Record<string, string | undefined>}
 */
function cliEnvironment(workspace, env) {
  const inherited = { ...process.env };
  // The package manager running these tests sets a user agent that would choose
  // the runner (#909), so a test that wants one passes it in env.
  delete inherited.npm_config_user_agent;
  // npx and npm exec set npm_config_package and npm_config_call (#689), so a test that
  // wants those settings passes them in env.
  for (const key of Object.keys(inherited)) {
    if (/^npm_config_(package|call)$/i.test(key)) delete inherited[key];
  }
  const childEnv = {
    ...inherited,
    NO_COLOR: "1",
    PATH: stubPath(workspace),
    STUB_LOG: workspace.log,
    ...env,
  };

  // A VP_CLI_BIN from the developer's shell would hide whether Calavera sets one.
  delete childEnv.VP_CLI_BIN;

  return childEnv;
}

/**
 * Runs the CLI with the stub runners first on PATH.
 *
 * With `deadlineMs`, the CLI starts in its own process group. If it is still
 * running at the deadline, the whole group is killed, so a test that expects
 * the CLI to give up on a hanging child fails with `timedOut: true` instead
 * of hanging, and leaves no stray child behind (#911). POSIX only, like the
 * stub runners.
 *
 * @param {{ work: string, log: string, bin: string }} workspace
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @param {{ deadlineMs?: number }} [options]
 * @returns {Promise<{ code: number, stdout: string, stderr: string, timedOut: boolean }>}
 */
function runCli(workspace, args, env = {}, { deadlineMs } = {}) {
  const childEnv = cliEnvironment(workspace, env);

  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [binPath, ...args], {
      cwd: workspace.work,
      env: childEnv,
      detached: deadlineMs !== undefined,
      // stdin stays an open pipe, as execFile left it, so no test sees an early end of input.
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));

    const deadline =
      deadlineMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            // The negative pid names the process group: the CLI and every child it started.
            process.kill(-child.pid, "SIGKILL");
          }, deadlineMs);

    child.on("error", rejectPromise);
    child.on("close", (code) => {
      clearTimeout(deadline);
      resolvePromise({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

/**
 * @param {string} log
 * @returns {Promise<Array<{ argv: string[], cwd: string }>>}
 */
async function readInvocations(log) {
  try {
    return (await readFile(log, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

/** @param {string} path */
async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

const RECIPE_BLOCK_HEADING = "Your project needs a recipe before Calavera changes anything.";
// #602: --new leaves the shell in the parent directory, so changing into the project comes first.
const CD_STEP_HEADING = "First, change into the new project:";

/**
 * The next-steps group --new prints after a successful scaffold and bootstrap: the `cd` step, then
 * the two ways to get a recipe, with the apply commands only after the step that saves one (#602).
 *
 * @param {string} target
 * @param {{ cd: string, applyDryRun: string, applyRecipe: string }} commands
 * @returns {string}
 */
function recipeBlock(target, { cd, applyDryRun, applyRecipe }) {
  return [
    "Next steps:",
    CD_STEP_HEADING,
    `  ${cd}`,
    RECIPE_BLOCK_HEADING,
    `  Either: open ${target} in your agent and use the prompt below.`,
    "  Or: compose one at https://calavera.schalkneethling.com/ and save",
    `      calavera.config.json into ${target}, then:`,
    `        ${applyDryRun}`,
    `        ${applyRecipe}`,
  ].join("\n");
}

test("createVpCreateCommand runs create-vite-plus for every runner", () => {
  const forwarded = ["vite:library", "--", "--template", "react-ts"];

  // npm consumes the first --, so Calavera adds exactly one in front of the
  // forwarded arguments and leaves the template's own -- in place.
  assert.deepEqual(createVpCreateCommand("npm", forwarded), {
    command: "npm",
    args: ["create", "vite-plus@latest", "--", ...forwarded],
  });
  // pnpm dlx and yarn dlx pass every later token on, a -- included (#740).
  assert.deepEqual(createVpCreateCommand("pnpm", forwarded), {
    command: "pnpm",
    args: ["dlx", "create-vite-plus@latest", ...forwarded],
  });
  assert.deepEqual(createVpCreateCommand("yarn", forwarded), {
    command: "yarn",
    args: ["dlx", "create-vite-plus@latest", ...forwarded],
  });
  // Not bun create, which prefers a local .bun-create template of the same name.
  assert.deepEqual(createVpCreateCommand("bun", forwarded), {
    command: "bunx",
    args: ["create-vite-plus@latest", ...forwarded],
  });
  assert.deepEqual(createVpCreateCommand("npm", []), {
    command: "npm",
    args: ["create", "vite-plus@latest", "--"],
  });
});

test("parseArgs ends Calavera's own arguments at --new and keeps every later token", () => {
  const options = parseArgs([
    "--",
    "--yes",
    "--package-manager",
    "pnpm",
    "--new",
    "vite:library",
    "--no-interactive",
    "--",
    "--template",
    "--new",
  ]);

  assert.equal(options.command, "new");
  assert.equal(options.assumeYes, true);
  assert.equal(options.packageManager, "pnpm");
  assert.deepEqual(options.newArgs, [
    "vite:library",
    "--no-interactive",
    "--",
    "--template",
    "--new",
  ]);
  assert.equal(parseArgs(["--init"]).newArgs, undefined);
});

test("--new refuses a directory that already has a package.json and points at --init", async () => {
  await using workspace = await createTemporaryWorkspace("manifest");
  await writeFile(join(workspace.work, "package.json"), "{}\n");

  const result = await runCli(workspace, ["--yes", "--new", "vite:library"], {
    STUB_MODE: "scaffold",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /package\.json/);
  assert.match(result.stderr, /npm create project-calavera -- --init/);
  assert.match(result.stderr, /pnpm dlx create-project-calavera --init/);
  assert.match(result.stderr, /yarn dlx create-project-calavera --init/);
  assert.match(result.stderr, /bunx create-project-calavera --init/);
  assert.deepEqual(await readInvocations(workspace.log), []);
});

test("--new refuses an unreadable package.json before anything else", async () => {
  await using workspace = await createTemporaryWorkspace("unreadable-manifest");
  const manifestPath = join(workspace.work, "package.json");
  await writeFile(manifestPath, "{}\n");
  await chmod(manifestPath, 0o000);

  const result = await runCli(workspace, ["--init", "--json", "--new"]);

  await chmod(manifestPath, 0o644);
  assert.equal(result.code, 1);
  // `--json` before `--new` is Calavera's own, so the refusal is a JSON result (#1227).
  assert.match(
    JSON.parse(result.stdout).issues[0].message,
    /npm create project-calavera -- --init/,
  );
  assert.deepEqual(await readInvocations(workspace.log), []);
});

test("--new refuses --init and --json", async () => {
  await using workspace = await createTemporaryWorkspace("contradictions");

  const withInit = await runCli(workspace, ["--yes", "--init", "--new", "vite:library"]);
  const withJson = await runCli(workspace, ["--yes", "--json", "--new", "vite:library"]);

  assert.equal(withInit.code, 1);
  assert.match(withInit.stderr, /--new and --init cannot be combined/);
  assert.equal(withJson.code, 1);
  // The refusal is a JSON result, because `--json` always prints JSON (#1227).
  assert.match(
    JSON.parse(withJson.stdout).issues[0].message,
    /--new cannot be combined with --json/,
  );
  assert.deepEqual(await readInvocations(workspace.log), []);
});

test("--new refuses to spawn without confirmation when stdin is not a terminal", async () => {
  await using workspace = await createTemporaryWorkspace("no-confirmation");

  const result = await runCli(workspace, ["--new", "vite:library"], { STUB_MODE: "scaffold" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--yes/);
  assert.deepEqual(await readInvocations(workspace.log), []);
  assert.deepEqual(await readdir(workspace.work), []);
});

test("--new refuses a forwarded --no-interactive without --yes before spawning", async () => {
  await using workspace = await createTemporaryWorkspace("no-interactive");

  const result = await runCli(workspace, ["--new", "vite:library", "--no-interactive"], {
    STUB_MODE: "scaffold",
    CI: "",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--no-interactive/);
  assert.match(result.stderr, /--yes/);
  assert.deepEqual(await readInvocations(workspace.log), []);
});

test("--new --dry-run prints the confirmation and the command and spawns nothing", async () => {
  await using workspace = await createTemporaryWorkspace("dry-run");
  await writeFile(join(workspace.root, "package.json"), json(libraryManifest));

  const result = await runCli(workspace, [
    "--dry-run",
    "--package-manager",
    "pnpm",
    "--new",
    "vite:library",
    "--directory",
    "my lib",
  ]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /pnpm dlx create-vite-plus@latest vite:library --directory 'my lib'/);
  assert.match(result.stdout, /Calavera will run Vite\+ to scaffold a new project:/);
  assert.match(result.stdout, new RegExp(`Working directory: ${workspace.work}`));
  assert.match(result.stdout, /may download Vite\+/);
  assert.match(result.stdout, /asks its own questions/);
  assert.match(
    result.stdout,
    /- Outside an existing project, Vite\+ uses pnpm as the project's package manager unless --package-manager is forwarded after --new\./,
  );
  // Vite+ 1.6.0 (dist/create/bin.js) picks VP_PACKAGE_MANAGER first, then, inside a monorepo,
  // the detected package manager before a forwarded one; elsewhere, a forwarded one before the
  // detected one; then the launcher's (#958). Detection finds nothing in a project with neither
  // field and none of the lockfiles or configuration files Vite+ reads, so the launcher's wins:
  // vite-plus 1.6.0 and 1.7.0, started through `npm exec` and `bunx` under such a package.json,
  // scaffolded with npm and Bun, not pnpm (#1028).
  assert.match(
    result.stdout,
    /- Inside an existing project, Vite\+ uses the package manager it detects there unless --package-manager is forwarded\. When that project's package\.json has no packageManager or devEngines\.packageManager field and its folder has no lockfile or package-manager configuration file that Vite\+ reads \(an \.npmrc does not count\), Vite\+ detects none and uses pnpm\. Inside a monorepo, Vite\+ uses the package manager it detects for the monorepo even when --package-manager is forwarded\. A VP_PACKAGE_MANAGER environment variable overrides all of these\.\n/,
  );
  assert.doesNotMatch(result.stdout, /Inside an existing workspace/);
  assert.match(result.stdout, /cannot be skipped/);
  assert.match(result.stdout, /may offer to remove/);
  assert.match(result.stdout, /does not undo/);
  // The bin refuses an unsupported Node.js before --new runs (#626).
  assert.doesNotMatch(result.stdout, /requires Node\.js/);
  assert.match(result.stdout, new RegExp(`${join(workspace.root, "package.json")} is managed`));
  assert.match(result.stdout, /--init/);
  assert.doesNotMatch(result.stdout, /needs a recipe/);
  assert.deepEqual(await readInvocations(workspace.log), []);
  assert.deepEqual(await readdir(workspace.work), []);
});

test("--new --dry-run shows the npm and Bun create-vite-plus commands", async () => {
  await using workspace = await createTemporaryWorkspace("dry-run-create-vite-plus");

  const npm = await runCli(workspace, [
    "--dry-run",
    "--new",
    "vite:library",
    "--",
    "--template",
    "vanilla-ts",
  ]);
  const bun = await runCli(workspace, [
    "--dry-run",
    "--package-manager",
    "bun",
    "--new",
    "vite:library",
  ]);

  assert.equal(npm.code, 0, npm.stderr);
  assert.match(
    npm.stdout,
    /Command: npm create vite-plus@latest -- vite:library -- --template vanilla-ts/,
  );
  assert.match(npm.stdout, /Vite\+ uses npm as the project's package manager/);
  assert.equal(bun.code, 0, bun.stderr);
  assert.match(bun.stdout, /Command: bunx create-vite-plus@latest vite:library/);
  assert.match(bun.stdout, /Vite\+ uses bun as the project's package manager/);
  assert.deepEqual(await readInvocations(workspace.log), []);
});

// #909: with no --package-manager before --new, the runner follows the package
// manager that launched Calavera, read from npm_config_user_agent, and falls
// back to npm when `launcher` is undefined. The Yarn 4 value is the one a
// `yarn run` script printed under Yarn 4.18.1 through Corepack on 2026-11-16 (#909).
const launcherCases = [
  {
    label: "npm",
    userAgent: "npm/11.20.0 node/v26.13.1 darwin arm64 workspaces/false",
    command: "npm create vite-plus@latest -- vite:library",
    launcher: "npm",
  },
  {
    label: "pnpm",
    userAgent: "pnpm/12.9.1 npm/? node/? darwin arm64",
    command: "pnpm dlx create-vite-plus@latest vite:library",
    launcher: "pnpm",
  },
  {
    label: "Yarn 4",
    userAgent: "yarn/4.18.1 npm/? node/v26.13.1 darwin arm64",
    command: "yarn dlx create-vite-plus@latest vite:library",
    launcher: "yarn",
  },
  {
    label: "Yarn 2",
    userAgent: "yarn/2.0.0 npm/? node/v24.22.0 darwin arm64",
    command: "yarn dlx create-vite-plus@latest vite:library",
    launcher: "yarn",
  },
  {
    label: "Bun",
    userAgent: "bun/1.3.9 npm/? node/v24.3.0 darwin arm64",
    command: "bunx create-vite-plus@latest vite:library",
    launcher: "bun",
  },
  // A Yarn 1 user agent under npm, as a project .npmrc `user-agent=yarn/1.22.22` makes it. npm set
  // npm_execpath, so Calavera does not stop (ADR-0023, Decision 2), and the runner is npm, which
  // started it; Yarn counts as the launcher only at version 2 or later.
  {
    label: "a Yarn 1 user agent under npm",
    userAgent: "yarn/1.22.22 npm/? node/v26.13.1 darwin arm64",
    env: { npm_execpath: "/usr/local/lib/node_modules/npm/bin/npm-cli.js" },
    command: "npm create vite-plus@latest -- vite:library",
    launcher: undefined,
  },
  // Yarn sets its own version in the user agent, so a value without one did not come from Yarn.
  {
    label: "a Yarn without a version",
    userAgent: "yarn/unknown npm/? node/v26.13.1 darwin arm64",
    command: "npm create vite-plus@latest -- vite:library",
    launcher: undefined,
  },
  {
    label: "an unset user agent",
    userAgent: undefined,
    command: "npm create vite-plus@latest -- vite:library",
    launcher: undefined,
  },
  {
    label: "an empty user agent",
    userAgent: "",
    command: "npm create vite-plus@latest -- vite:library",
    launcher: undefined,
  },
  {
    label: "an unrecognized launcher",
    userAgent: "deno/2.0.0",
    command: "npm create vite-plus@latest -- vite:library",
    launcher: undefined,
  },
];

for (const { label, userAgent, env = {}, command, launcher } of launcherCases) {
  const packageManager = launcher ?? "npm";

  test(`--new chooses the ${packageManager} runner when launched through ${label}`, async () => {
    await using workspace = await createTemporaryWorkspace(`launcher-${packageManager}`);

    const result = await runCli(
      workspace,
      ["--dry-run", "--new", "vite:library"],
      userAgent === undefined ? env : { ...env, npm_config_user_agent: userAgent },
    );

    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`Command: ${RegExp.escape(command)}\n`));
    assert.match(
      result.stdout,
      new RegExp(`Vite\\+ uses ${packageManager} as the project's package manager`),
    );
    assert.deepEqual(await readInvocations(workspace.log), []);
  });
}

test("launchingPackageManager reads the name before the first / and Yarn's major version", () => {
  for (const { userAgent, launcher } of launcherCases) {
    assert.equal(launchingPackageManager(userAgent), launcher, String(userAgent));
  }
  // A value with no / is a name alone, as Vite+ reads it.
  assert.equal(launchingPackageManager("pnpm"), "pnpm");
  // The name must match exactly; a prefix, a suffix, or another case is another program.
  assert.equal(launchingPackageManager("pnpmx/1.0.0"), undefined);
  assert.equal(launchingPackageManager("PNPM/12.9.1"), undefined);
  assert.equal(launchingPackageManager(" npm/11.20.0"), undefined);
  // Only a leading major version counts. Yarn adds -core to its version when it runs
  // from @yarnpkg/core without a release version (scriptUtils.ts in yarnpkg/berry).
  assert.equal(launchingPackageManager("yarn/10.0.0"), "yarn");
  assert.equal(launchingPackageManager("yarn/4.0.0-rc.1 npm/?"), "yarn");
  assert.equal(launchingPackageManager("yarn/4.6.0-core npm/?"), "yarn");
  assert.equal(launchingPackageManager("yarn/v4.0.0"), undefined);
  assert.equal(launchingPackageManager("yarn/4"), undefined);
  assert.equal(launchingPackageManager("yarn/0.27.5"), undefined);
});

test("--new lets --package-manager before --new choose the runner over the launcher", async () => {
  await using workspace = await createTemporaryWorkspace("launcher-explicit");

  const result = await runCli(
    workspace,
    ["--dry-run", "--package-manager", "bun", "--new", "vite:library"],
    { npm_config_user_agent: "pnpm/12.9.1 npm/? node/? darwin arm64" },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /Command: bunx create-vite-plus@latest vite:library\n/);
  assert.match(result.stdout, /Vite\+ uses bun as the project's package manager/);
});

// #1109: Vite+ picks the package manager of a new project from the
// npm_config_user_agent it sees. npm and Bun pass an inherited value on, so
// Calavera removes it from the environment vp create receives, and the runner
// sets its own. The confirmation must name the package manager Vite+ then
// picks: under every launcher, under the fallbacks to npm, and when
// --package-manager before --new chooses another runner.
const runnerChoiceCases = [
  ...launcherCases.map(({ label, userAgent, env = {}, launcher }) => ({
    label: `launched through ${label}`,
    userAgent,
    launcherEnv: env,
    args: [],
    packageManager: launcher ?? "npm",
  })),
  ...[
    ["npm", "pnpm/12.9.1 npm/? node/? darwin arm64", "pnpm"],
    ["bun", "pnpm/12.9.1 npm/? node/? darwin arm64", "pnpm"],
    ["npm", "bun/1.3.9 npm/? node/v24.3.0 darwin arm64", "Bun"],
    ["bun", "npm/11.20.0 node/v26.13.1 darwin arm64 workspaces/false", "npm"],
    ["pnpm", "yarn/4.18.1 npm/? node/v26.13.1 darwin arm64", "Yarn 4"],
    ["yarn", "bun/1.3.9 npm/? node/v24.3.0 darwin arm64", "Bun"],
  ].map(([packageManager, userAgent, launcherLabel]) => ({
    label: `given --package-manager ${packageManager} under ${launcherLabel}`,
    userAgent,
    launcherEnv: {},
    args: ["--package-manager", packageManager],
    packageManager,
  })),
];

for (const { label, userAgent, launcherEnv, args, packageManager } of runnerChoiceCases) {
  test(`--new names the package manager Vite+ picks when ${label}`, async () => {
    await using workspace = await createTemporaryWorkspace("vite-plus-choice");
    const env =
      userAgent === undefined ? launcherEnv : { ...launcherEnv, npm_config_user_agent: userAgent };

    const preview = await runCli(workspace, ["--dry-run", ...args, "--new", "vite:library"], env);

    assert.equal(preview.code, 0, preview.stderr);
    assert.match(
      preview.stdout,
      new RegExp(
        `Outside an existing project, Vite\\+ uses ${packageManager} as the project's package manager`,
      ),
    );
    assert.match(preview.stdout, new RegExp(`Vite\\+ detects none and uses ${packageManager}\\.`));

    // "nothing" makes the runner exit zero without a scaffold, which Calavera reports as a hard stop.
    await runCli(workspace, ["--yes", ...args, "--new", "vite:library"], {
      ...env,
      STUB_MODE: "nothing",
    });

    assert.equal((await readInvocations(workspace.log)).length, 1);
    assert.deepEqual(await readInvocations(`${workspace.log}.launcher`), [
      { vitePlusPackageManager: packageManager },
    ]);
  });
}

test("--new forwards every token unchanged to the launcher's runner and adds no --package-manager", async () => {
  await using workspace = await createTemporaryWorkspace("launcher-forwarding");
  const forwarded = ["vite:library", "--directory", "lib", "--", "--template", "vanilla-ts"];

  const result = await runCli(workspace, ["--yes", "--new", ...forwarded], {
    STUB_MODE: "scaffold",
    npm_config_user_agent: "pnpm/12.9.1 npm/? node/? darwin arm64",
  });
  const invocations = await readInvocations(workspace.log);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].runner, "pnpm");
  assert.deepEqual(invocations[0].argv, ["dlx", "create-vite-plus@latest", ...forwarded]);
});

test("--new names how it chose the runner when a runner it chose cannot start", async () => {
  await using workspace = await createTemporaryWorkspace("launcher-missing-runner");
  const previousCwd = process.cwd();
  const startFailure = new Error(
    "--new could not start bunx: spawn bunx ENOENT. Calavera wrote nothing.",
  );

  process.chdir(workspace.work);

  try {
    for (const args of [
      ["--yes", "--new", "vite:library"],
      ["--yes", "--package-manager", "bun", "--new", "vite:library"],
    ]) {
      const explicit = args.includes("--package-manager");
      const error = await newProject(parseArgs(args), {
        env: { npm_config_user_agent: "bun/1.3.9 npm/? node/v24.3.0 darwin arm64" },
        spawnRunner: async () => {
          throw startFailure;
        },
      }).then(
        () => assert.fail("expected --new to fail"),
        (rejection) => rejection,
      );

      if (explicit) {
        // The user chose the runner, so the error stays as it was.
        assert.equal(error, startFailure);
      } else {
        assert.ok(error.message.startsWith(startFailure.message));
        assert.match(
          error.message,
          /No --package-manager came before --new, so Calavera chose bun:/,
        );
        assert.match(
          error.message,
          /Pass --package-manager with npm, pnpm, yarn, or bun before --new/,
        );
        assert.equal(error.cause, startFailure);
      }
    }
  } finally {
    process.chdir(previousCwd);
  }
});

test("--new --yes scaffolds through the runner, verifies managed, and runs the bootstrap", async () => {
  await using workspace = await createTemporaryWorkspace("success");

  const result = await runCli(workspace, ["--yes", "--new", "vite:library", "--no-interactive"], {
    STUB_MODE: "scaffold",
    STUB_TARGET: "my-lib",
  });
  const target = join(workspace.work, "my-lib");
  const invocations = await readInvocations(workspace.log);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(invocations.length, 1);
  // No --package-manager is added: Vite+ picks the runner's package manager.
  assert.deepEqual(invocations[0].argv, [
    "create",
    "vite-plus@latest",
    "--",
    "vite:library",
    "--no-interactive",
  ]);
  assert.equal(invocations[0].cwd, workspace.work);
  // Calavera adds no VP_CLI_BIN and passes PATH through unchanged (ADR-0010 Decision 1).
  assert.equal(invocations[0].vpCliBin, null);
  assert.equal(invocations[0].path, stubPath(workspace));
  assert.match(
    result.stdout,
    /- Outside an existing project, Vite\+ uses npm as the project's package manager unless --package-manager is forwarded after --new\./,
  );
  assert.match(result.stdout, /Vite\+ detects none and uses npm\./);
  assert.equal((await detectVitePlus(target)).status, "managed");
  assert.ok(await exists(join(target, ".agents/skills/calavera/SKILL.md")));
  assert.ok(await exists(join(target, ".calavera/state.json")));
  assert.ok(await exists(join(target, "AGENTS.md")));
  assert.equal(await exists(join(workspace.work, ".calavera")), false);
  assert.match(result.stdout, /Calavera agent bootstrap complete/);
  // The README holds the agent prompt; --new prints it word for word (#840).
  assert.equal(printedNextPrompt(result.stdout), await readmeAgentPrompt());
  assert.ok(
    result.stdout.includes(
      recipeBlock(target, {
        cd: `cd ${target}`,
        applyDryRun: "npm create project-calavera apply -- --dry-run",
        applyRecipe: "npm create project-calavera apply",
      }),
    ),
    result.stdout,
  );
  // #602: the agent prompt is used after the project is open, so it follows the cd step.
  assert.ok(result.stdout.indexOf(CD_STEP_HEADING) < result.stdout.indexOf(NEXT_PROMPT_HEADING));
});

test("--new names the scaffolded project's package manager and quotes the target in the next steps", async () => {
  await using workspace = await createTemporaryWorkspace("next-steps-pnpm");

  const result = await runCli(
    workspace,
    ["--yes", "--package-manager", "npm", "--new", "vite:library", "--directory", "my lib"],
    { STUB_MODE: "scaffold", STUB_PACKAGE_MANAGER: "pnpm@10.0.0" },
  );
  const target = join(workspace.work, "my lib");

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    result.stdout.includes(
      recipeBlock(target, {
        cd: `cd '${target}'`,
        applyDryRun: "pnpm dlx create-project-calavera apply --dry-run",
        applyRecipe: "pnpm dlx create-project-calavera apply",
      }),
    ),
    result.stdout,
  );
});

test("--new forwards every token after it unchanged, including -- and what follows", async () => {
  await using workspace = await createTemporaryWorkspace("forwarding");
  const forwarded = [
    "vite:library",
    "--no-interactive",
    "--directory",
    "lib",
    "--",
    "--directory",
    "elsewhere",
    "--yes",
    "--init",
  ];

  const result = await runCli(
    workspace,
    ["--yes", "--package-manager", "pnpm", "--new", ...forwarded],
    {
      STUB_MODE: "scaffold",
    },
  );
  const invocations = await readInvocations(workspace.log);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(invocations[0].argv, ["dlx", "create-vite-plus@latest", ...forwarded]);
  assert.ok(await exists(join(workspace.work, "lib/.calavera/state.json")));
});

test("--new forwards every token to yarn dlx create-vite-plus unchanged and in order", async () => {
  await using workspace = await createTemporaryWorkspace("forwarding-yarn");
  // A literal create token in the template arguments must not move the target.
  const forwarded = [
    "vite:library",
    "--directory",
    "lib",
    "--",
    "create",
    "--directory",
    "elsewhere",
  ];

  const result = await runCli(
    workspace,
    ["--yes", "--package-manager", "yarn", "--new", ...forwarded],
    { STUB_MODE: "scaffold" },
  );
  const invocations = await readInvocations(workspace.log);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(invocations[0].argv, ["dlx", "create-vite-plus@latest", ...forwarded]);
  assert.ok(await exists(join(workspace.work, "lib/.calavera/state.json")));
});

test("--new hard-stops on a non-zero exit, names the cause, and writes nothing further", async () => {
  await using workspace = await createTemporaryWorkspace("non-zero");

  const result = await runCli(workspace, ["--yes", "--new", "vite:library"], {
    STUB_MODE: "fail",
    STUB_TARGET: "partial",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with code 1/);
  assert.doesNotMatch(result.stdout, /needs a recipe/);
  assert.match(result.stderr, /partial scaffold that belongs to Vite\+/);
  assert.deepEqual(await readdir(join(workspace.work, "partial")), ["package.json"]);
  assert.equal(await readFile(join(workspace.work, "partial/package.json"), "utf8"), "{");
});

// #1080: Corepack pins for pnpm dlx and yarn dlx too, before the run starts, so
// a successful run would edit a package.json above the new project as well as a
// failed one. That edit is outside the project the person approved, so
// vp create receives COREPACK_ENABLE_AUTO_PIN=0 under every runner, which
// overrides a user's "1" for this run only.
for (const corepackVersion of ["0.32.0", "0.36.0"]) {
  for (const packageManager of ["pnpm", "yarn"]) {
    for (const outcome of ["fail", "scaffold"]) {
      test(`--new leaves a parent package.json untouched when ${packageManager} dlx runs under Corepack ${corepackVersion}'s auto-pin (${outcome})`, async () => {
        await using workspace = await createTemporaryWorkspace(
          `runner-auto-pin-${packageManager}-${outcome}`,
        );
        // --new refuses a directory with a package.json, so the one Corepack pins is above it.
        const manifestPath = join(workspace.root, "package.json");
        const manifest = json({ name: "workspace-root", private: true });
        await writeFile(manifestPath, manifest);

        const result = await runCli(
          workspace,
          ["--yes", "--package-manager", packageManager, "--new", "vite:library"],
          {
            STUB_MODE: outcome,
            STUB_COREPACK_VERSION: corepackVersion,
            COREPACK_ENABLE_AUTO_PIN: "1",
          },
        );
        const invocations = await readInvocations(workspace.log);

        assert.equal(result.code, outcome === "fail" ? 1 : 0, result.stderr);
        assert.equal(invocations.length, 1);
        assert.equal(invocations[0].runner, packageManager);
        assert.equal(await readFile(manifestPath, "utf8"), manifest);
        assert.equal(invocations[0].env.COREPACK_ENABLE_AUTO_PIN, "0");
      });
    }
  }
}

test("--new adds no Yarn hint and reads no Yarn version when yarn dlx fails", async () => {
  await using workspace = await createTemporaryWorkspace("yarn-no-hint");
  const result = await runCli(
    workspace,
    ["--yes", "--package-manager", "yarn", "--new", "vite:library"],
    { STUB_MODE: "fail" },
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /vp create through yarn exited with code 1/);
  assert.doesNotMatch(result.stderr, /dlx|Yarn 1|Yarn 2|Corepack/);
  assert.match(result.stderr, /partial scaffold that belongs to Vite\+\.\s*$/);
  // Neither `yarn --version` nor `yarn node` ran (ADR-0023, Decision 3).
  assert.equal(await exists(`${workspace.log}.yarn-read`), false);
});

test("--new hard-stops when the scaffold is unmanaged and names the finding", async () => {
  await using workspace = await createTemporaryWorkspace("unmanaged");

  const result = await runCli(workspace, ["--yes", "--new", "vite"], {
    STUB_MODE: "unmanaged",
    STUB_TARGET: "plain",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with code 0/);
  assert.match(result.stderr, new RegExp(join(workspace.work, "plain")));
  assert.match(result.stderr, /status unmanaged/);
  assert.doesNotMatch(result.stdout, /needs a recipe/);
  assert.match(result.stderr, /vite-plus-unmanaged/);
  assert.match(result.stderr, /partial scaffold that belongs to Vite\+/);
  assert.deepEqual((await readdir(join(workspace.work, "plain"))).sort(), ["package.json"]);
});

test("--new hard-stops when detection on the scaffold is unknown and names the finding", async () => {
  await using workspace = await createTemporaryWorkspace("unknown");

  const result = await runCli(workspace, ["--yes", "--new", "vite"], {
    STUB_MODE: "unknown",
    STUB_TARGET: "broken",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /status unknown/);
  assert.doesNotMatch(result.stdout, /needs a recipe/);
  assert.match(result.stderr, /vite-plus-detection-unknown/);
  assert.equal(await exists(join(workspace.work, "broken/.calavera")), false);
});

test("--new hard-stops when a canceled scaffold exits zero having written nothing", async () => {
  await using workspace = await createTemporaryWorkspace("canceled");

  const result = await runCli(workspace, ["--yes", "--new"], { STUB_MODE: "nothing" });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /exited with code 0/);
  assert.match(result.stderr, /no new or changed package\.json/);
  assert.doesNotMatch(result.stdout, /needs a recipe/);
  assert.deepEqual(await readdir(workspace.work), []);
});

test("--new hard-stops and lists the candidates when several directories gained a manifest", async () => {
  await using workspace = await createTemporaryWorkspace("ambiguous");

  const result = await runCli(workspace, ["--yes", "--new", "vite:library"], {
    STUB_MODE: "scaffold",
    STUB_TARGET: "first",
    STUB_EXTRA: "second",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, new RegExp(join(workspace.work, "first")));
  assert.match(result.stderr, new RegExp(join(workspace.work, "second")));
  assert.doesNotMatch(result.stdout, /needs a recipe/);
  assert.equal(await exists(join(workspace.work, "first/.calavera")), false);
  assert.equal(await exists(join(workspace.work, "second/.calavera")), false);
});

test("--new lets a forwarded --directory decide the target", async () => {
  await using workspace = await createTemporaryWorkspace("directory");

  const result = await runCli(workspace, ["--yes", "--new", "vite:library", "--directory=chosen"], {
    STUB_MODE: "scaffold",
    STUB_TARGET: "chosen",
    STUB_EXTRA: "other",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(await exists(join(workspace.work, "chosen/.calavera/state.json")));
  assert.equal(await exists(join(workspace.work, "other/.calavera")), false);
});

test("--new hard-stops when a canceled scaffold leaves a forwarded --directory without a manifest", async () => {
  await using workspace = await createTemporaryWorkspace("directory-canceled");

  const result = await runCli(workspace, ["--yes", "--new", "vite:library", "--directory=chosen"], {
    STUB_MODE: "nothing",
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /no new or changed package\.json was found in the forwarded --directory .*chosen/,
  );
  assert.deepEqual(await readdir(workspace.work), []);
});

test("--new does not bootstrap a pre-existing project at a forwarded --directory that Vite+ left untouched", async () => {
  await using workspace = await createTemporaryWorkspace("directory-untouched");
  const chosen = join(workspace.work, "chosen");
  await mkdir(chosen);
  await writeFile(join(chosen, "package.json"), json(libraryManifest));

  const result = await runCli(workspace, ["--yes", "--new", "vite:library", "--directory=chosen"], {
    STUB_MODE: "nothing",
  });

  assert.equal(result.code, 1);
  assert.match(
    result.stderr,
    /no new or changed package\.json was found in the forwarded --directory/,
  );
  assert.equal(await exists(join(chosen, ".calavera")), false);
  assert.deepEqual(await readdir(chosen), ["package.json"]);
});

test("--new accepts a forwarded --directory that is nested more than one level deep", async () => {
  await using workspace = await createTemporaryWorkspace("directory-nested");

  const result = await runCli(
    workspace,
    ["--yes", "--new", "vite:library", "--directory", "apps/chosen"],
    { STUB_MODE: "scaffold", STUB_TARGET: "apps/chosen" },
  );

  assert.equal(result.code, 0, result.stderr);
  assert.ok(await exists(join(workspace.work, "apps/chosen/.calavera/state.json")));
});

test("--new finds a pre-existing non-empty target whose manifest Vite+ replaced", async () => {
  await using workspace = await createTemporaryWorkspace("replaced");
  const existing = join(workspace.work, "existing");
  await mkdir(existing);
  await writeFile(join(existing, "package.json"), json({ name: "old" }));
  await writeFile(join(existing, "notes.txt"), "keep\n");
  await mkdir(join(workspace.work, "untouched"));
  await writeFile(join(workspace.work, "untouched/package.json"), json({ name: "untouched" }));

  const result = await runCli(workspace, ["--yes", "--new", "vite:library"], {
    STUB_MODE: "scaffold",
    STUB_TARGET: "existing",
  });

  assert.equal(result.code, 0, result.stderr);
  assert.ok(await exists(join(existing, ".calavera/state.json")));
  assert.equal(await exists(join(workspace.work, "untouched/.calavera")), false);
});

test("--new names the terminating signal when the runner is killed", async () => {
  await using workspace = await createTemporaryWorkspace("signal");
  const previousCwd = process.cwd();
  /** @type {Array<{ command: string, args: string[], cwd: string }>} */
  const spawned = [];

  process.chdir(workspace.work);

  try {
    await assert.rejects(
      newProject(parseArgs(["--yes", "--new", "vite:library"]), {
        // No launcher, so the runner is npm whichever package manager runs these tests (#909).
        env: {},
        spawnRunner: async (invocation) => {
          spawned.push(invocation);
          return { exitCode: null, signal: "SIGTERM" };
        },
      }),
      (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /terminated by signal SIGTERM/);
        assert.match(error.message, /partial scaffold that belongs to Vite\+/);
        return true;
      },
    );
  } finally {
    process.chdir(previousCwd);
  }

  assert.deepEqual(spawned, [
    {
      command: "npm",
      args: ["create", "vite-plus@latest", "--", "vite:library"],
      cwd: workspace.work,
      env: { COREPACK_ENABLE_AUTO_PIN: "0" },
    },
  ]);
});

test("--new removes only the launch settings from the environment vp create receives and turns off Corepack's auto-pin", async () => {
  await using workspace = await createTemporaryWorkspace("launch-settings");
  const previousCwd = process.cwd();
  /** @type {Array<{ env?: Record<string, string | undefined> }>} */
  const spawned = [];
  const kept = {
    // Other npm settings, including one whose name starts the same way, pass through.
    npm_config_package_lock: "false",
    npm_config_cache: "/home/user/.npm",
    npm_package_name: "create-project-calavera",
    // A name that only ends with a removed one passes through.
    CALAVERA_npm_config_user_agent: "kept",
    CALAVERA_PASSTHROUGH: "kept",
    PATH: "/usr/bin",
  };

  process.chdir(workspace.work);

  try {
    await assert.rejects(
      newProject(parseArgs(["--yes", "--new", "vite:library"]), {
        env: {
          ...kept,
          // What npx --package and npx -c set for the process they start.
          npm_config_package: "create-project-calavera",
          npm_config_call: "create-project-calavera --new",
          // npm reads the npm_config_ prefix in any case.
          NPM_CONFIG_PACKAGE: "create-project-calavera",
          Npm_Config_Call: "create-project-calavera --new",
          // The launcher's user agent (#1109). npm also reads a - for the _ inside a name.
          npm_config_user_agent: "yarn/4.18.1 npm/? node/v26.13.1 darwin arm64",
          NPM_CONFIG_USER_AGENT: "yarn/4.18.1 npm/? node/v26.13.1 darwin arm64",
          "npm_config_user-agent": "yarn/4.18.1 npm/? node/v26.13.1 darwin arm64",
          // A user's own auto-pin setting (#1080), in any case as Windows reads it.
          COREPACK_ENABLE_AUTO_PIN: "1",
          corepack_enable_auto_pin: "1",
        },
        spawnRunner: async (invocation) => {
          spawned.push(invocation);
          return { exitCode: 1, signal: null };
        },
      }),
    );
  } finally {
    process.chdir(previousCwd);
  }

  assert.equal(spawned.length, 1);
  // "0" is the one value that turns auto-pin off in every Corepack version (#1080).
  assert.deepEqual(spawned[0].env, { ...kept, COREPACK_ENABLE_AUTO_PIN: "0" });
});

test("--new succeeds with npm when Calavera was started with npx --package (#689)", async () => {
  await using workspace = await createTemporaryWorkspace("npx-package");
  const launch = {
    // What npx --package create-project-calavera sets for Calavera.
    npm_config_user_agent: "npm/11.20.0 node/v24.22.0 darwin arm64 workspaces/false",
    npm_config_package: "create-project-calavera",
    npm_config_call: "create-project-calavera --new",
    STUB_MODE: "scaffold",
    STUB_TARGET: "my-lib",
    CALAVERA_PASSTHROUGH: "kept",
  };

  const result = await runCli(
    workspace,
    ["--yes", "--new", "vite:library", "--package-manager", "npm", "--no-interactive"],
    launch,
  );
  const invocations = await readInvocations(workspace.log);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(invocations.length, 1);
  assert.equal(invocations[0].runner, "npm");

  // Every variable Calavera was started with reaches the runner unchanged, except the
  // two settings and the user agent (#1109), and auto-pin is off (#1080).
  const expected = cliEnvironment(workspace, launch);
  delete expected.npm_config_package;
  delete expected.npm_config_call;
  delete expected.npm_config_user_agent;
  for (const key of Object.keys(expected)) {
    if (key.toUpperCase() === "COREPACK_ENABLE_AUTO_PIN") delete expected[key];
  }
  expected.COREPACK_ENABLE_AUTO_PIN = "0";
  assert.deepEqual(invocations[0].env, expected);
});

/**
 * @param {string | undefined} packageManager
 * @param {{ exitCode: number | null, signal?: string }} exit
 * @returns {Promise<string>}
 */
async function failedNewMessage(packageManager, exit) {
  await using workspace = await createTemporaryWorkspace(`hint-${packageManager ?? "default"}`);
  const previousCwd = process.cwd();

  process.chdir(workspace.work);

  try {
    const error = await newProject(
      parseArgs([
        "--yes",
        ...(packageManager === undefined ? [] : ["--package-manager", packageManager]),
        "--new",
        "vite:library",
      ]),
      // No launcher, so the default runner is npm whichever package manager runs these tests (#909).
      { spawnRunner: async () => exit, env: {} },
    ).then(
      () => assert.fail("expected --new to fail"),
      (rejection) => rejection,
    );

    return error.message;
  } finally {
    process.chdir(previousCwd);
  }
}

/**
 * The parts both npm failure messages keep, so an exit 127 and any other
 * failure differ only in the exit description and the hint.
 *
 * @param {string} message
 */
function assertSharedFailureParts(message) {
  assert.match(message, /^vp create through npm /);
  assert.match(message, /\(run in [^)]+\)/);
  assert.match(
    message,
    /Calavera wrote nothing further, removed nothing, and did not run the --init bootstrap\./,
  );
  assert.match(message, /may hold a partial scaffold that belongs to Vite\+\./);
}

test("--new adds the stale-cache hint when npm exits non-zero for a reason other than 127", async () => {
  const message = await failedNewMessage("npm", { exitCode: 1 });

  assertSharedFailureParts(message);
  assert.match(message, /exited with code 1/);
  assert.ok(message.includes(NPM_STALE_CACHE_HINT));
  assert.match(message, /"npm cache npx ls"/);
  assert.match(message, /"npm cache npx rm <key>"/);
});

test("--new adds the stale-cache hint on the default package manager", async () => {
  const message = await failedNewMessage(undefined, { exitCode: 1 });

  assert.ok(message.includes(NPM_STALE_CACHE_HINT));
});

test("--new keeps the stale-cache hint and the signal when npm is killed", async () => {
  const message = await failedNewMessage("npm", { exitCode: null, signal: "SIGTERM" });

  assertSharedFailureParts(message);
  assert.match(message, /terminated by signal SIGTERM/);
  assert.ok(message.includes(NPM_STALE_CACHE_HINT));
});

test("--new adds no npm hint when npm exits 127, because no cache change finds a missing command", async () => {
  for (const packageManager of ["npm", undefined]) {
    const message = await failedNewMessage(packageManager, { exitCode: 127 });

    assertSharedFailureParts(message);
    assert.match(message, /exited with code 127/);
    assert.ok(!message.includes(NPM_STALE_CACHE_HINT));
    assert.doesNotMatch(message, /npm cache npx/);
    // #689 removed the npx --package cause, so the error no longer blames it.
    assert.doesNotMatch(message, /npm_config_package|npx --package/);
    assert.match(message, /may hold a partial scaffold that belongs to Vite\+\.$/);
  }
});

for (const packageManager of ["pnpm", "yarn", "bun"]) {
  test(`--new does not show the npm hints for ${packageManager}`, async () => {
    const message = await failedNewMessage(packageManager, { exitCode: 1 });

    assert.match(message, /exited with code 1/);
    assert.doesNotMatch(message, /npm cache npx/);
    assert.doesNotMatch(message, /command not found/);
    // No runner adds a hint of its own, Yarn included (ADR-0023 removed the Yarn 1 hint).
    assert.match(message, /may hold a partial scaffold that belongs to Vite\+\.$/);
  });
}

// A valid recipe with deliberately unusual formatting, so a copy that
// re-serializes the JSON instead of copying the bytes fails the comparison.
const recipeSource =
  '{ "version": 1,\n    "profile": "default", "packageManager": "pnpm",\n  "integrations": [], "scripts": {} }\n';

test("parseArgs keeps --config given before --new and forwards one given after it", () => {
  assert.equal(
    parseArgs(["--yes", "--config", "recipe.json", "--new", "vite"]).newConfig,
    "recipe.json",
  );

  const after = parseArgs(["--yes", "--new", "vite", "--config", "recipe.json"]);

  assert.equal(after.newConfig, undefined);
  assert.deepEqual(after.newArgs, ["vite", "--config", "recipe.json"]);
  assert.equal(parseArgs(["--new"]).newConfig, undefined);
  assert.equal(parseArgs(["apply"]).config, "calavera.config.json");
  assert.equal(parseArgs(["apply", "--config", "other.json"]).config, "other.json");
});

test("--new --config refuses a missing recipe before spawning and writes nothing", async () => {
  await using workspace = await createTemporaryWorkspace("config-missing");
  const recipePath = join(workspace.root, "missing.json");

  const result = await runCli(workspace, ["--yes", "--config", recipePath, "--new", "vite"], {
    STUB_MODE: "scaffold",
  });

  assert.equal(result.code, 1);
  assert.match(result.stderr, /--new refused/);
  assert.ok(result.stderr.includes(recipePath), result.stderr);
  assert.match(result.stderr, /ENOENT/);
  assert.deepEqual(await readInvocations(workspace.log), []);
  assert.deepEqual(await readdir(workspace.work), []);
});

test("--new --config refuses malformed JSON and an invalid recipe before spawning", async () => {
  await using workspace = await createTemporaryWorkspace("config-invalid");
  const malformed = join(workspace.root, "malformed.json");
  const invalid = join(workspace.root, "invalid.json");
  await writeFile(malformed, "{ not json");
  await writeFile(invalid, json({ version: 1, profile: "no-such-profile" }));

  // #1157: malformed JSON and an invalid recipe stay distinguishable.
  for (const [recipePath, failure, cause] of [
    [malformed, /cannot be parsed as JSON/, /at line 1, column \d+/],
    [invalid, /not a valid recipe/, /profile/i],
  ]) {
    const result = await runCli(workspace, ["--yes", "--config", recipePath, "--new", "vite"], {
      STUB_MODE: "scaffold",
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--new refused/);
    assert.match(result.stderr, failure);
    assert.ok(result.stderr.includes(recipePath), result.stderr);
    assert.match(result.stderr, cause);
  }

  assert.deepEqual(await readInvocations(workspace.log), []);
  assert.deepEqual(await readdir(workspace.work), []);
});

test("--new --config --dry-run validates the recipe and names the planned copy", async () => {
  await using workspace = await createTemporaryWorkspace("config-dry-run");
  const recipePath = join(workspace.root, "recipe.json");
  await writeFile(recipePath, recipeSource);

  const result = await runCli(workspace, ["--dry-run", "--config", recipePath, "--new", "vite"]);

  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    result.stdout.includes(
      `- After Vite+ detection reports the scaffold as managed, Calavera copies ${recipePath} into it as calavera.config.json. Calavera does not apply the recipe.`,
    ),
    result.stdout,
  );
  assert.deepEqual(await readInvocations(workspace.log), []);
  assert.deepEqual(await readdir(workspace.work), []);

  const invalidPath = join(workspace.root, "invalid.json");
  await writeFile(invalidPath, json({ version: 2 }));
  const invalid = await runCli(workspace, ["--dry-run", "--config", invalidPath, "--new", "vite"]);

  assert.equal(invalid.code, 1);
  assert.match(invalid.stderr, /not a valid recipe/);
});

test("--new --config copies the recipe byte for byte after the managed check and names it", async () => {
  await using workspace = await createTemporaryWorkspace("config-copy");
  const recipePath = join(workspace.root, "recipe.json");
  await writeFile(recipePath, recipeSource);

  const result = await runCli(
    workspace,
    ["--yes", "--config", recipePath, "--new", "vite:library", "--directory", "my-lib"],
    { STUB_MODE: "scaffold" },
  );
  const target = join(workspace.work, "my-lib");
  const copied = join(target, "calavera.config.json");

  assert.equal(result.code, 0, result.stderr);
  assert.equal(await readFile(copied, "utf8"), recipeSource);
  assert.equal(await readFile(join(target, "package.json"), "utf8"), json(libraryManifest));
  assert.equal(await readFile(join(target, "vite.config.ts"), "utf8"), vitePlusConfig);
  // Vite+ wrote package.json and vite.config.ts and installed node_modules; the
  // bootstrap wrote the agent files; the recipe copy is the only other addition.
  assert.deepEqual((await readdir(target)).sort(), [
    ".agents",
    ".calavera",
    ".coderabbit.yaml",
    "AGENTS.md",
    "calavera.config.json",
    "node_modules",
    "package.json",
    "vite.config.ts",
  ]);
  assert.ok(result.stdout.includes(`Copied ${recipePath} to ${copied}.`), result.stdout);
  assert.ok(
    result.stdout.includes(
      [
        "Next steps:",
        CD_STEP_HEADING,
        `  cd ${target}`,
        `Your project has a recipe at ${copied}. Calavera has not applied it.`,
        "  Preview it, then apply it after you approve the preview:",
        "    npm create project-calavera apply -- --dry-run",
        "    npm create project-calavera apply",
        "",
        NEXT_PROMPT_HEADING,
      ].join("\n"),
    ),
    result.stdout,
  );
  assert.doesNotMatch(result.stdout, /needs a recipe/);
  // Copied, never applied: no managed tooling files appear.
  assert.equal(await exists(join(target, ".editorconfig")), false);
  assert.equal(await readFile(recipePath, "utf8"), recipeSource);
});

test("--new --config copies nothing when the scaffold is canceled, fails, or is unmanaged", async () => {
  await using workspace = await createTemporaryWorkspace("config-no-copy");
  const recipePath = join(workspace.root, "recipe.json");
  await writeFile(recipePath, recipeSource);

  const canceled = await runCli(workspace, ["--yes", "--config", recipePath, "--new", "vite"], {
    STUB_MODE: "nothing",
  });

  assert.equal(canceled.code, 1);
  assert.deepEqual(await readdir(workspace.work), []);

  const failed = await runCli(workspace, ["--yes", "--config", recipePath, "--new", "vite"], {
    STUB_MODE: "fail",
    STUB_TARGET: "partial",
  });

  assert.equal(failed.code, 1);
  assert.deepEqual(await readdir(workspace.work), ["partial"]);
  assert.deepEqual(await readdir(join(workspace.work, "partial")), ["package.json"]);

  const unmanaged = await runCli(workspace, ["--yes", "--config", recipePath, "--new", "vite"], {
    STUB_MODE: "unmanaged",
    STUB_TARGET: "plain",
  });

  assert.equal(unmanaged.code, 1);
  assert.deepEqual(await readdir(join(workspace.work, "plain")), ["package.json"]);
});

test("--new --config does not overwrite a calavera.config.json already in the target", async () => {
  await using workspace = await createTemporaryWorkspace("config-existing");
  const recipePath = join(workspace.root, "recipe.json");
  const existing = join(workspace.work, "existing");
  await writeFile(recipePath, recipeSource);
  await mkdir(existing);
  await writeFile(join(existing, "calavera.config.json"), "keep\n");

  const result = await runCli(
    workspace,
    ["--yes", "--config", recipePath, "--new", "vite", "--directory", "existing"],
    { STUB_MODE: "scaffold" },
  );

  assert.equal(result.code, 1);
  assert.match(result.stderr, /already exists/);
  assert.equal(await readFile(join(existing, "calavera.config.json"), "utf8"), "keep\n");
  assert.equal(await exists(join(existing, ".calavera")), false);
});

test("--new prints the bootstrap summary in labeled groups, with the prompt as its own block (#601)", async () => {
  await using workspace = await createTemporaryWorkspace("summary-groups");

  const result = await runCli(workspace, ["--yes", "--new", "vite:library", "--no-interactive"], {
    STUB_MODE: "scaffold",
    STUB_TARGET: "my-lib",
  });
  const target = join(workspace.work, "my-lib");
  const summaryStart = result.stdout.indexOf(`Vite+ scaffolded ${target}.`);

  assert.equal(result.code, 0, result.stderr);
  assert.notEqual(summaryStart, -1, result.stdout);
  // --yes without --mcp-harness leaves MCP to manual setup, so this also pins that case.
  assert.equal(
    result.stdout.slice(summaryStart),
    [
      `Vite+ scaffolded ${target}. Vite+ detection: managed.`,
      "",
      "Calavera agent bootstrap complete.",
      "",
      "Changes:",
      "  Wrote .agents/skills/calavera",
      "  Wrote .coderabbit.yaml",
      "  Wrote AGENTS.md",
      "  Wrote .agents/calavera/mcp.md",
      "  Wrote .calavera/state.json",
      "",
      "Notes:",
      "  Installed skills are available under .agents/skills/.",
      "  Skipped project MCP auto-config. Follow the MCP setup notes listed under Changes for manual setup.",
      "",
      recipeBlock(target, {
        cd: `cd ${target}`,
        applyDryRun: "npm create project-calavera apply -- --dry-run",
        applyRecipe: "npm create project-calavera apply",
      }),
      "",
      NEXT_PROMPT_HEADING,
      "",
      await readmeAgentPrompt(),
      "",
      "",
    ].join("\n"),
  );
});

test("--init in a project --new made lists every file it leaves unchanged once, under Changes (#956)", async () => {
  await using workspace = await createTemporaryWorkspace("summary-rerun");
  const created = await runCli(workspace, ["--yes", "--new", "vite:library", "--no-interactive"], {
    STUB_MODE: "scaffold",
    STUB_TARGET: "my-lib",
  });
  assert.equal(created.code, 0, created.stderr);

  const target = join(workspace.work, "my-lib");
  const result = await runCli({ ...workspace, work: target }, ["--init", "--yes"]);
  const summary = result.stdout.slice(0, result.stdout.indexOf("Next steps:"));

  assert.equal(result.code, 0, result.stderr);
  // .calavera/state.json is left out when it is unchanged (#957); every other file --new wrote
  // is named once, as the #918 rehearsal's listing check requires.
  const unchanged = [
    ".agents/skills/calavera",
    ".coderabbit.yaml",
    "AGENTS.md",
    ".agents/calavera/mcp.md",
  ];
  assert.deepEqual(listingViolations(result.stdout, unchanged), []);
  assert.equal(
    summary,
    [
      "Calavera agent bootstrap complete.",
      "",
      "Changes:",
      "  Skipped .agents/skills/calavera: Already up to date.",
      "  Skipped .coderabbit.yaml: Already up to date.",
      "  Skipped AGENTS.md: Already up to date.",
      "  Skipped .agents/calavera/mcp.md: Already up to date.",
      "",
      "Notes:",
      "  Installed skills are available under .agents/skills/.",
      "  Skipped project MCP auto-config. Follow the MCP setup notes listed under Changes for manual setup.",
      "",
      "",
    ].join("\n"),
  );
});
