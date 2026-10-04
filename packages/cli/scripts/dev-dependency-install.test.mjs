// Issue #618 and ADR-0012: in a Vite+-managed project, apply installs the
// recipe's development dependencies with the project's own `vp add -D`, so
// Vite+ runs the package manager the project pins. Every other project keeps
// its package manager's command. A failed install stops the spinner, exits
// non-zero, and says what was already written and how to finish.
//
// No test installs anything: a stand-in vite-plus package under node_modules,
// or a stand-in package manager first on PATH, records what apply ran.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  applyRecipeObject,
  describeCommandFailure,
  devDependencyInstallCommand,
  formatCommand,
} from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  json,
  plainViteManifest,
  readStubInvocations,
  writeVitePlusStub,
} from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const recipe = buildRecipe("minimal", ["editorconfig", "knip"], "pnpm", [], {});
// Long enough for a slow CI runner; a CLI held open by a running spinner
// timer never exits on its own, so it reaches this limit instead.
const CLI_TIMEOUT_MS = 30_000;

/**
 * A package-manager stand-in. It records its argv and working directory, then
 * exits with STUB_EXIT, which defaults to zero. A successful `init` writes a
 * package.json, as the real command does.
 */
const packageManagerStub = `#!/usr/bin/env node
const { appendFileSync, writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");
const exitCode = Number(process.env.STUB_EXIT ?? "0");
if (exitCode !== 0) {
  console.log("package manager stub: ERR_STUB_COMMAND the command failed");
  console.error("package manager stub: the command failed");
} else if (argv[0] === "init") {
  writeFileSync("package.json", JSON.stringify({ name: "stub-init" }) + "\\n");
}
process.exit(exitCode);
`;

/**
 * Puts a stand-in for each supported package manager in `bin`, so a test can
 * prove which one apply ran, and that a managed project ran none of them.
 *
 * @param {string} bin
 */
async function writePackageManagerStubs(bin) {
  await mkdir(bin, { recursive: true });

  for (const name of ["npm", "pnpm", "yarn", "bun"]) {
    const path = join(bin, name);
    await writeFile(path, packageManagerStub);
    await chmod(path, 0o755);
  }
}

/**
 * A copy of the committed `vp create` library fixture with the recipe saved as
 * `calavera.config.json`. The package-manager stand-ins and the logs live in a
 * separate directory, outside the project. With `vitePlus`, a stand-in
 * vite-plus package is installed in the project.
 *
 * @param {{ vitePlus?: { exitCode?: number } }} [options]
 */
async function managedProject({ vitePlus } = {}) {
  const project = await copyReleaseFixture("library");
  const tools = await createTemporaryFixture("install-tools", {});
  const vpLog = join(tools.root, "vp.log");

  await mkdir(join(project.root, ".git"));
  await writeFile(join(project.root, "calavera.config.json"), json(recipe));
  await writePackageManagerStubs(join(tools.root, "bin"));

  if (vitePlus) {
    await writeVitePlusStub(project.root, { logPath: vpLog, exitCode: vitePlus.exitCode });
  }

  return {
    project: project.root,
    bin: join(tools.root, "bin"),
    vpLog,
    packageManagerLog: join(tools.root, "package-manager.log"),
    async [Symbol.asyncDispose]() {
      await project[Symbol.asyncDispose]();
      await tools[Symbol.asyncDispose]();
    },
  };
}

/**
 * A project without vite-plus, with the recipe saved as `calavera.config.json`
 * and package-manager stand-ins in a sibling `bin`. Without `manifest`, the
 * project has no package.json, so apply has to create one.
 *
 * @param {string} label
 * @param {{ manifest?: boolean }} [options]
 */
async function unmanagedProject(label, { manifest = true } = {}) {
  const fixture = await createTemporaryFixture(`install-${label}`, {
    ...(manifest ? { "project/package.json": json(plainViteManifest) } : {}),
    "project/calavera.config.json": json(recipe),
  });
  await mkdir(join(fixture.root, "project/.git"));
  await writePackageManagerStubs(join(fixture.root, "bin"));

  return {
    project: join(fixture.root, "project"),
    bin: join(fixture.root, "bin"),
    packageManagerLog: join(fixture.root, "package-manager.log"),
    [Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
  };
}

/**
 * Runs the CLI in `project` with the stand-ins first on PATH. `timedOut` is
 * true when the CLI had to be killed because it did not exit on its own.
 *
 * @param {{ project: string, bin: string, packageManagerLog: string }} workspace
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, timedOut: boolean, stdout: string, stderr: string }>}
 */
function runCli(workspace, args, env = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      {
        cwd: workspace.project,
        timeout: CLI_TIMEOUT_MS,
        env: {
          ...process.env,
          NO_COLOR: "1",
          PATH: `${workspace.bin}${delimiter}${process.env.PATH ?? ""}`,
          STUB_LOG: workspace.packageManagerLog,
          ...env,
        },
      },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          timedOut: Boolean(error?.killed),
          stdout,
          stderr,
        });
      },
    );
  });
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

/**
 * A new workspace member of the committed `vp create` monorepo fixture: a
 * directory with the recipe and no package.json of its own, whose workspace
 * root declares vite-plus and has a stand-in vite-plus installed.
 */
async function memberWithoutManifest() {
  const workspace = await copyReleaseFixture("monorepo");
  const tools = await createTemporaryFixture("install-member-tools", {});
  const project = join(workspace.root, "packages/fresh");
  const vpLog = join(tools.root, "vp.log");

  await mkdir(join(workspace.root, ".git"));
  await mkdir(project);
  await writeFile(join(project, "calavera.config.json"), json(recipe));
  await writePackageManagerStubs(join(tools.root, "bin"));
  await writeVitePlusStub(workspace.root, { logPath: vpLog });

  return {
    project,
    bin: join(tools.root, "bin"),
    vpLog,
    packageManagerLog: join(tools.root, "package-manager.log"),
    async [Symbol.asyncDispose]() {
      await workspace[Symbol.asyncDispose]();
      await tools[Symbol.asyncDispose]();
    },
  };
}

/**
 * Runs `callback` with the process working directory set to `directory`.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const previousDirectory = process.cwd();
  process.chdir(directory);

  try {
    return await callback();
  } finally {
    process.chdir(previousDirectory);
  }
}

/** @param {"managed" | "unmanaged" | "unknown"} status @param {"managed" | "unmanaged"} [ancestorStatus] */
function detection(status, ancestorStatus) {
  return {
    status,
    corroborating: [],
    ...(ancestorStatus
      ? { ancestor: { manifestPath: "/workspace/package.json", status: ancestorStatus } }
      : {}),
  };
}

test("devDependencyInstallCommand delegates to vp add -D when Vite+ manages the project, whatever the package manager", () => {
  for (const packageManager of /** @type {const} */ (["npm", "pnpm", "yarn", "bun"])) {
    for (const vitePlus of [detection("managed"), detection("unknown", "managed")]) {
      assert.deepEqual(devDependencyInstallCommand(packageManager, vitePlus, ["knip", "varlock"]), [
        "vp",
        ["add", "-D", "knip", "varlock"],
      ]);
    }
  }
});

test("devDependencyInstallCommand keeps each package manager's command when the project is not Vite+-managed", () => {
  for (const vitePlus of [
    detection("unmanaged"),
    detection("unknown"),
    detection("unknown", "unmanaged"),
  ]) {
    assert.deepEqual(devDependencyInstallCommand("npm", vitePlus, ["knip"]), [
      "npm",
      ["install", "--save-dev", "knip"],
    ]);
    assert.deepEqual(devDependencyInstallCommand("pnpm", vitePlus, ["knip"]), [
      "pnpm",
      ["add", "--save-dev", "knip"],
    ]);
    assert.deepEqual(devDependencyInstallCommand("yarn", vitePlus, ["knip"]), [
      "yarn",
      ["add", "--dev", "knip"],
    ]);
    assert.deepEqual(devDependencyInstallCommand("bun", vitePlus, ["knip"]), [
      "bun",
      ["add", "--dev", "knip"],
    ]);
  }
});

test("apply --dry-run names vp add -D, and how apply runs it, in a Vite+-managed project", async () => {
  await using workspace = await managedProject({ vitePlus: {} });
  const spawned = new RegExp(
    `^Vite\\+ runs this with the package manager the project pins; apply runs it as: \\S+ ${workspace.project}/node_modules/vite-plus/bin/vp add -D knip$`,
    "m",
  );

  const human = await runCli(workspace, ["apply", "--dry-run"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Dev dependency install command: vp add -D knip$/m);
  assert.match(human.stdout, spawned);

  const machine = await runCli(workspace, ["apply", "--dry-run", "--json"]);
  assert.equal(machine.code, 0, machine.stderr);
  const result = JSON.parse(machine.stdout);
  assert.equal(result.installCommand, "vp add -D knip");
  assert.equal(result.installNotes.length, 1);
  assert.match(result.installNotes[0], spawned);

  assert.deepEqual(await readStubInvocations(workspace.vpLog), [], "the dry run ran vp");
  assert.deepEqual(
    await readStubInvocations(workspace.packageManagerLog),
    [],
    "the dry run ran a package manager",
  );
});

test("apply --dry-run says an explicit package manager does not change the install command in a Vite+-managed project", async () => {
  await using workspace = await managedProject({ vitePlus: {} });

  const result = await runCli(workspace, ["apply", "--dry-run", "--package-manager", "npm"]);

  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /^Dev dependency install command: vp add -D knip$/m);
  assert.match(
    result.stdout,
    /^The package manager given to Calavera \(npm\) does not change this command: Vite\+ installs with the package manager the project pins\.$/m,
  );
});

test("apply --dry-run names the package manager's own command in a project Vite+ does not manage", async () => {
  await using workspace = await unmanagedProject("dry-run");

  const human = await runCli(workspace, ["apply", "--dry-run"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /^Dev dependency install command: pnpm add --save-dev knip$/m);

  const machine = await runCli(workspace, ["apply", "--dry-run", "--json"]);
  const result = JSON.parse(machine.stdout);
  assert.equal(result.installCommand, "pnpm add --save-dev knip");
  assert.deepEqual(result.installNotes, []);
});

test("apply runs the project's own vp add -D in a Vite+-managed project and no package manager from PATH", async () => {
  await using workspace = await managedProject({ vitePlus: {} });

  const result = await runCli(workspace, ["apply", "--yes"]);

  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.timedOut, false);
  assert.deepEqual(await readStubInvocations(workspace.vpLog), [
    { argv: ["add", "-D", "knip"], cwd: workspace.project },
  ]);
  assert.deepEqual(await readStubInvocations(workspace.packageManagerLog), []);
});

test("apply keeps the package manager's own command in a project Vite+ does not manage", async () => {
  await using workspace = await unmanagedProject("unmanaged");

  const result = await runCli(workspace, ["apply", "--yes"]);

  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(await readStubInvocations(workspace.packageManagerLog), [
    { argv: ["add", "--save-dev", "knip"], cwd: workspace.project },
  ]);
});

test("in a workspace member without its own package.json under a Vite+ workspace, the dry run and apply name the same vp add -D", async () => {
  await using workspace = await memberWithoutManifest();

  const dryRun = await runCli(workspace, ["apply", "--dry-run", "--json", "--yes"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const planned = JSON.parse(dryRun.stdout);
  assert.equal(planned.vitePlus.status, "unknown");
  assert.equal(planned.installCommand, "vp add -D knip");
  assert.ok(
    planned.installNotes.includes(
      "This directory has no package.json; apply creates one with pnpm init.",
    ),
    JSON.stringify(planned.installNotes),
  );
  assert.equal(await exists(join(workspace.project, "package.json")), false);

  const applied = await runCli(workspace, ["apply", "--yes", "--json"]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.equal(JSON.parse(applied.stdout).installCommand, planned.installCommand);
  assert.deepEqual(await readStubInvocations(workspace.packageManagerLog), [
    { argv: ["init"], cwd: workspace.project },
  ]);
  assert.deepEqual(await readStubInvocations(workspace.vpLog), [
    { argv: ["add", "-D", "knip"], cwd: workspace.project },
  ]);
});

test("a Vite+-managed project without vite-plus installed: the dry run reports it, and apply stops before writing anything", async () => {
  await using workspace = await managedProject();

  const dryRun = await runCli(workspace, ["apply", "--dry-run"]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assert.match(
    dryRun.stdout,
    /^Apply with the install stops before writing anything: .*vite-plus is not installed/m,
  );

  const result = await runCli(workspace, ["apply", "--yes"]);
  assert.equal(result.code, 1);
  assert.equal(result.timedOut, false);
  assert.match(
    result.stderr,
    /but vite-plus is not installed: no node_modules\/vite-plus was found in \S+ or any ancestor directory\./,
  );
  assert.match(
    result.stderr,
    /run apply with --no-install and add these development dependencies yourself: knip\. Calavera stopped before writing anything\./,
  );
  assert.doesNotMatch(result.stderr, /\bvp install\b/);
  assert.equal(await exists(join(workspace.project, "knip.json")), false);
  assert.equal(await exists(join(workspace.project, ".calavera/state.json")), false);
  assert.deepEqual(await readStubInvocations(workspace.packageManagerLog), []);

  const skipped = await runCli(workspace, ["apply", "--yes", "--no-install"]);
  assert.equal(skipped.code, 0, skipped.stderr);
});

const unusableVitePlus = [
  {
    name: "does not export ./package.json",
    manifest: json({ name: "vite-plus", bin: { vp: "./bin/vp" }, exports: { ".": "./index.js" } }),
    message:
      /but the installed vite-plus does not export \.\/package\.json, so its vp bin cannot be located\./,
  },
  {
    name: "has an unparseable manifest",
    manifest: "{ not json",
    message: /but vite-plus could not be resolved from \S+ \(/,
  },
  {
    name: "declares its bin as a string",
    manifest: json({ name: "vite-plus", bin: "./bin/vp" }),
    message: /node_modules\/vite-plus\/package\.json does not declare a vp bin in its bin field\./,
  },
  {
    name: "declares a vp bin outside the package",
    manifest: json({ name: "vite-plus", bin: { vp: "../../outside.js" } }),
    message:
      /node_modules\/vite-plus\/package\.json declares a vp bin outside the vite-plus package: \.\.\/\.\.\/outside\.js\./,
  },
  {
    name: "declares a vp bin that does not exist",
    manifest: json({
      name: "vite-plus",
      bin: { vp: "./bin/missing" },
      exports: { "./package.json": "./package.json" },
    }),
    message:
      /node_modules\/vite-plus\/package\.json declares the vp bin \.\/bin\/missing, but .*node_modules\/vite-plus\/bin\/missing does not exist, so the vite-plus installation is incomplete\./,
  },
];

for (const variant of unusableVitePlus) {
  test(`apply stops before writing anything when the project's vite-plus ${variant.name}`, async () => {
    await using workspace = await managedProject();
    await writeVitePlusStub(workspace.project, {
      logPath: workspace.vpLog,
      manifest: variant.manifest,
    });

    await inDirectory(workspace.project, () =>
      assert.rejects(applyRecipeObject(recipe, { json: true, assumeYes: true }), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, variant.message);
        assert.match(error.message, /Calavera stopped before writing anything\.$/);
        assert.ok(error.cause instanceof Error, "the cause was dropped");
        return true;
      }),
    );

    assert.equal(await exists(join(workspace.project, "knip.json")), false);
    assert.equal(await exists(join(workspace.project, ".calavera/state.json")), false);
    assert.deepEqual(await readStubInvocations(workspace.vpLog), []);
  });
}

test("a failed vp add -D stops the spinner, exits non-zero, and says what was written and how to finish", async () => {
  await using workspace = await managedProject({ vitePlus: { exitCode: 3 } });

  const result = await runCli(workspace, ["apply", "--yes"]);

  assert.equal(result.timedOut, false, "the CLI did not exit after the install failed");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Could not install development dependencies/);
  assert.match(result.stderr, /could not install the recipe's development dependencies/);
  assert.match(
    result.stderr,
    /^Already written: package\.json, \.editorconfig, knip\.json, \.calavera\/state\.json\.$/m,
  );
  assert.match(
    result.stderr,
    new RegExp(
      `^Install command: \\S+ ${workspace.project}/node_modules/vite-plus/bin/vp add -D knip$`,
      "m",
    ),
  );
  assert.match(result.stderr, /^It exited with code 3\.$/m);
  assert.match(result.stderr, /^Its last output:\nvp stub: ERR_STUB_INSTALL the install failed$/m);
  assert.match(
    result.stderr,
    new RegExp(`^To finish the install, run the install command in ${workspace.project}\\.$`, "m"),
  );
  // The message is self-contained; the underlying error is kept as cause, not printed.
  assert.doesNotMatch(result.stderr, /ExecaError/);
  assert.ok(await exists(join(workspace.project, ".calavera/state.json")));
});

test("a failed install keeps the underlying error as cause", async () => {
  await using workspace = await managedProject({ vitePlus: { exitCode: 3 } });

  await inDirectory(workspace.project, () =>
    assert.rejects(applyRecipeObject(recipe, { json: true, assumeYes: true }), (error) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /^Calavera applied the recipe's files, package\.json scripts/);
      assert.ok(error.cause instanceof Error, "the cause was dropped");
      assert.equal(/** @type {{ exitCode?: number }} */ (error.cause).exitCode, 3);
      return true;
    }),
  );
});

test("a failed package-manager install in a project Vite+ does not manage names that package manager's command", async () => {
  await using workspace = await unmanagedProject("unmanaged-failure");

  const result = await runCli(workspace, ["apply", "--yes"], { STUB_EXIT: "4" });

  assert.equal(result.timedOut, false, "the CLI did not exit after the install failed");
  assert.equal(result.code, 1);
  assert.match(result.stderr, /^Install command: pnpm add --save-dev knip$/m);
  assert.match(result.stderr, /^It exited with code 4\.$/m);
  assert.match(result.stderr, /ERR_STUB_COMMAND/);
});

test("a failed package.json creation stops the spinner and exits non-zero", async () => {
  await using workspace = await unmanagedProject("init-failure", { manifest: false });

  const result = await runCli(workspace, ["apply", "--yes"], { STUB_EXIT: "5" });

  assert.equal(result.timedOut, false, "the CLI did not exit after package.json creation failed");
  assert.equal(result.code, 1);
  assert.match(result.stdout, /Could not create package\.json/);
  assert.match(
    result.stderr,
    /Calavera could not create package\.json with pnpm init, so it stopped before applying the recipe\. It exited with code 5\./,
  );
  assert.match(result.stderr, /ERR_STUB_COMMAND/);
  assert.doesNotMatch(result.stderr, /ExecaError/);
  assert.deepEqual(await readStubInvocations(workspace.packageManagerLog), [
    { argv: ["init"], cwd: workspace.project },
  ]);
});

test("formatCommand quotes every argument a POSIX shell would not read as one plain word, including a backslash", () => {
  assert.equal(
    formatCommand(["/usr/bin/node", ["/work/a\\b/vp", "add", "-D", "knip"]], "linux"),
    "/usr/bin/node '/work/a\\b/vp' add -D knip",
  );
  assert.equal(
    formatCommand(["/usr/bin/node", ["/my project/it's/vp", "add"]], "darwin"),
    "/usr/bin/node '/my project/it'\\''s/vp' add",
  );
  assert.equal(
    formatCommand(["pnpm", ["add", "--save-dev", "@scope/pkg"]], "linux"),
    "pnpm add --save-dev @scope/pkg",
  );
});

test("formatCommand keeps a Windows path's backslashes and quotes it in double quotes when it has a space", () => {
  assert.equal(
    formatCommand(["C:\\Program Files\\nodejs\\node.exe", ["C:\\work\\vp", "add"]], "win32"),
    '"C:\\Program Files\\nodejs\\node.exe" C:\\work\\vp add',
  );
});

test("describeCommandFailure embeds at most the last ten output lines, each cut at 300 characters", () => {
  const lines = Array.from({ length: 12 }, (_, index) => `line ${index + 1}`);
  lines[11] = "x".repeat(1000);
  const description = describeCommandFailure({ exitCode: 1, stdout: lines.join("\n") });
  const [outcome, heading, ...output] = description.split("\n");

  assert.equal(outcome, "It exited with code 1.");
  assert.equal(heading, "Its last output:");
  assert.equal(output.length, 10);
  assert.equal(output[0], "line 3");
  assert.equal(output[9], `${"x".repeat(300)}… [line truncated]`);
});
