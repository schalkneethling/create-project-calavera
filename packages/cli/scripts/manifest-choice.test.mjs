// Issue #430 and ADR-0001: when the inspected directory has no package.json of its own but a
// manifest above it was found, apply offers three choices at the dry_run_apply boundary and never
// picks one itself: create a manifest here and apply with the ancestor's verdict, apply at the
// ancestor with its own inspection, or abandon. A run that cannot ask reports the choices and
// stops, and no choice writes before it is made.
//
// No test installs anything: a stand-in vite-plus package and stand-in package managers first on
// PATH record what apply ran.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { applyRecipeObject, initRecipe, parseArgs } from "../src/index.js";
import { callMcpTool, createMcpServer } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { createEmptyState } from "../src/state.js";
import { snapshotDirectory } from "./project-snapshot.mjs";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  json,
  libraryManifest,
  plainViteManifest,
  readStubInvocations,
  writePackageManagerStubs,
  writeVitePlusStub,
} from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const recipe = buildRecipe("minimal", ["editorconfig", "knip"], "pnpm", [], {});
const CLI_TIMEOUT_MS = 30_000;
const CHOICES = ["create-here", "apply-at-ancestor", "abandon"];

/**
 * A new directory inside the committed `vp create` monorepo fixture, with the recipe saved as
 * `calavera.config.json` and no package.json of its own. The workspace root declares vite-plus
 * and, unless `installed` is false, has a stand-in vite-plus installed; the package-manager
 * stand-ins and the logs live outside the workspace.
 *
 * @param {{ installed?: boolean }} [options]
 */
async function directoryUnderManagedWorkspace({ installed = true } = {}) {
  const workspace = await copyReleaseFixture("monorepo", { vitePlus: installed });
  const tools = await createTemporaryFixture("manifest-choice-tools", {});
  const project = join(workspace.root, "packages/fresh");
  const vpLog = join(tools.root, "vp.log");
  const fmtLog = join(tools.root, "vp-fmt.log");

  await mkdir(join(workspace.root, ".git"));
  await mkdir(project);
  await writeFile(join(project, "calavera.config.json"), json(recipe));
  await writePackageManagerStubs(join(tools.root, "bin"));
  if (installed) {
    await writeVitePlusStub(workspace.root, { logPath: vpLog, fmtLogPath: fmtLog });
  }

  return {
    root: workspace.root,
    project,
    bin: join(tools.root, "bin"),
    vpLog,
    fmtLog,
    packageManagerLog: join(tools.root, "package-manager.log"),
    async [Symbol.asyncDispose]() {
      await workspace[Symbol.asyncDispose]();
      await tools[Symbol.asyncDispose]();
    },
  };
}

/**
 * A directory with the recipe and no package.json, below a plain Vite project that Vite+ does
 * not manage.
 */
async function directoryUnderUnmanagedProject() {
  const fixture = await createTemporaryFixture("manifest-choice-unmanaged", {
    "package.json": json(plainViteManifest),
    "sub/calavera.config.json": json(recipe),
  });
  await mkdir(join(fixture.root, ".git"));

  return {
    root: fixture.root,
    project: join(fixture.root, "sub"),
    [Symbol.asyncDispose]: () => fixture[Symbol.asyncDispose](),
  };
}

/**
 * Runs the CLI in `workspace.project` with the stand-ins first on PATH.
 *
 * @param {{ project: string, bin: string, packageManagerLog: string }} workspace
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(workspace, args) {
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
        },
      },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * Runs `callback` with the working directory set to `directory` and `process.stdin.isTTY` set to
 * `terminal`, so apply decides whether it can ask as it does in a terminal.
 *
 * @template T
 * @param {string} directory
 * @param {boolean} terminal
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, terminal, callback) {
  const previousDirectory = process.cwd();
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  process.chdir(directory);
  Object.defineProperty(process.stdin, "isTTY", { value: terminal, configurable: true });

  try {
    return await callback();
  } finally {
    process.chdir(previousDirectory);
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (/** @type {any} */ (process.stdin).isTTY);
  }
}

/**
 * Both stand-in logs, so a test can show that nothing ran.
 *
 * @param {{ vpLog: string, packageManagerLog: string }} workspace
 */
async function invocations(workspace) {
  return {
    vp: await readStubInvocations(workspace.vpLog),
    packageManager: await readStubInvocations(workspace.packageManagerLog),
  };
}

test("--manifest-choice accepts the three choices and refuses anything else", () => {
  for (const choice of CHOICES) {
    assert.equal(parseArgs(["apply", "--manifest-choice", choice]).manifestChoice, choice);
  }
  assert.equal(parseArgs(["apply"]).manifestChoice, undefined);
  assert.throws(() => parseArgs(["apply", "--manifest-choice", "here"]), /manifest-choice/);
  // A flag that would be ignored is refused, because ignoring abandon could apply a recipe.
  assert.equal(parseArgs(["update", "--manifest-choice", "abandon"]).manifestChoice, "abandon");
  assert.equal(
    parseArgs(["init", "--apply", "--manifest-choice", "create-here"]).manifestChoice,
    "create-here",
  );
  for (const args of [["init"], ["doctor"], ["clean"], ["--init"]]) {
    assert.throws(
      () => parseArgs([...args, "--manifest-choice", "abandon"]),
      /--manifest-choice works only with apply, update, and init --apply/,
      args.join(" "),
    );
  }
});

test("the dry run under a managed ancestor names the ancestor manifest and the three choices, and writes nothing", async () => {
  await using workspace = await directoryUnderManagedWorkspace();
  const before = await snapshotDirectory(workspace.root);
  const ancestorManifest = join(workspace.root, "package.json");

  const machine = await runCli(workspace, ["apply", "--dry-run", "--json", "--yes"]);
  assert.equal(machine.code, 0, machine.stderr);
  const result = JSON.parse(machine.stdout);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.manifestDecision.ancestor, {
    manifestPath: ancestorManifest,
    status: "managed",
  });
  assert.equal(result.manifestDecision.directory, workspace.project);
  assert.deepEqual(
    result.manifestDecision.options.map(({ choice }) => choice),
    CHOICES,
  );
  assert.equal(result.manifestDecision.choice, undefined, "the dry run chose for the person");
  assert.deepEqual(result.changes, []);
  assert.equal(result.installCommand, null);

  const human = await runCli(workspace, ["apply", "--dry-run"]);
  assert.equal(human.code, 0, human.stderr);
  assert.ok(human.stdout.includes(ancestorManifest), human.stdout);
  for (const choice of CHOICES) {
    assert.match(human.stdout, new RegExp(`^- ${choice}: `, "m"));
  }
  assert.match(human.stdout, /No files were changed\./);

  assert.deepEqual(await snapshotDirectory(workspace.root), before);
  assert.deepEqual(await invocations(workspace), { vp: [], packageManager: [] });
});

test("a non-interactive apply without a choice reports the three choices and stops before writing anything", async () => {
  await using workspace = await directoryUnderManagedWorkspace();
  const before = await snapshotDirectory(workspace.root);

  for (const args of [
    ["apply", "--yes"],
    ["apply", "--json"],
  ]) {
    const result = await runCli(workspace, args);
    assert.equal(result.code, 1, `${args.join(" ")} did not stop`);
    assert.ok(result.stderr.includes(join(workspace.root, "package.json")), result.stderr);
    for (const choice of CHOICES) {
      assert.match(result.stderr, new RegExp(`^- ${choice}: `, "m"));
    }
    assert.match(result.stderr, /--manifest-choice/);
    assert.match(result.stderr, /Calavera stopped before writing anything\./);
  }

  assert.deepEqual(await snapshotDirectory(workspace.root), before);
  assert.deepEqual(await invocations(workspace), { vp: [], packageManager: [] });
});

test("create-here writes the manifest and the recipe's files only in the inspected directory, with the ancestor's verdict", async () => {
  await using workspace = await directoryUnderManagedWorkspace();
  const before = await snapshotDirectory(workspace.root);
  const outsideProject = (/** @type {Record<string, string>} */ snapshot) =>
    Object.fromEntries(
      Object.entries(snapshot).filter(([path]) => !path.startsWith(`${workspace.project}/`)),
    );

  const dryRun = await runCli(workspace, [
    "apply",
    "--dry-run",
    "--json",
    "--manifest-choice",
    "create-here",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const planned = JSON.parse(dryRun.stdout);
  assert.equal(planned.manifestDecision.choice, "create-here");
  assert.equal(planned.installCommand, "vp add -D knip");
  assert.deepEqual(await snapshotDirectory(workspace.root), before, "the dry run wrote");

  const applied = await runCli(workspace, ["apply", "--yes", "--manifest-choice", "create-here"]);
  assert.equal(applied.code, 0, applied.stderr);

  assert.deepEqual(await invocations(workspace), {
    packageManager: [{ argv: ["init"], cwd: workspace.project }],
    vp: [{ argv: ["add", "-D", "knip"], cwd: workspace.project }],
  });
  // The ancestor is managed, so the new manifest's quality script runs the Vite+ checks.
  const manifest = JSON.parse(await readFile(join(workspace.project, "package.json"), "utf8"));
  assert.equal(manifest.scripts.quality, "vp check && vp test --passWithNoTests && pnpm knip");
  assert.ok(
    Object.keys(await snapshotDirectory(workspace.project)).some((path) =>
      path.endsWith("/.editorconfig"),
    ),
    "apply did not write the recipe's managed file in the inspected directory",
  );
  assert.deepEqual(
    outsideProject(await snapshotDirectory(workspace.root)),
    outsideProject(before),
    "create-here wrote outside the inspected directory",
  );
});

// #961: under create-here the formatter follows the parent's Vite+ verdict, as the install command
// and the quality script do, so the files apply writes pass the parent's vp check.
test("create-here formats the files apply writes with vp fmt when the parent is managed by Vite+", async () => {
  await using workspace = await directoryUnderManagedWorkspace();
  /** @param {{ argv: string[] }[]} runs */
  const formattedPaths = (runs) =>
    runs.map(({ argv }) => argv.find((arg) => arg.startsWith("--stdin-filepath=")));

  const dryRun = await runCli(workspace, [
    "apply",
    "--dry-run",
    "--json",
    "--manifest-choice",
    "create-here",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const plannedRuns = await readStubInvocations(workspace.fmtLog);
  assert.ok(plannedRuns.length > 0, "the dry run did not format with vp fmt");
  assert.ok(plannedRuns.every(({ cwd }) => cwd === workspace.project));

  const applied = await runCli(workspace, ["apply", "--yes", "--manifest-choice", "create-here"]);
  assert.equal(applied.code, 0, applied.stderr);
  const runs = (await readStubInvocations(workspace.fmtLog)).slice(plannedRuns.length);
  assert.ok(
    formattedPaths(runs).includes("--stdin-filepath=.calavera/state.json"),
    `apply did not format its state file with vp fmt: ${JSON.stringify(runs)}`,
  );
  assert.ok(runs.every(({ cwd }) => cwd === workspace.project));
});

/**
 * The create-here runs that load the formatter before anything else stops them, so each reports a
 * missing vite-plus through the formatter's error. A plain apply stops earlier, at the install
 * plan, with a different message.
 */
const createHereRunsThatFormat = {
  "apply --dry-run": ["apply", "--dry-run", "--json", "--manifest-choice", "create-here"],
  "apply --no-install": ["apply", "--yes", "--no-install", "--manifest-choice", "create-here"],
  "init --apply": [
    "init",
    "--apply",
    "--yes",
    "--json",
    "--profile",
    "minimal",
    "--manifest-choice",
    "create-here",
  ],
};

/**
 * Runs each create-here run that formats, and checks that it stops with `remedy`, without the
 * remedy that names no directory, and without changing the inspected directory.
 *
 * @param {{ project: string, bin: string, packageManagerLog: string }} workspace
 * @param {string} remedy
 */
async function assertEachRunStopsWith(workspace, remedy) {
  for (const [name, args] of Object.entries(createHereRunsThatFormat)) {
    const before = await snapshotDirectory(workspace.project);
    const result = await runCli(workspace, args);
    assert.equal(result.code, 1, `${name}: ${result.stderr}`);
    assert.ok(result.stderr.includes(remedy), `${name}: ${result.stderr}`);
    assert.doesNotMatch(result.stderr, /Run vp install, then/, name);
    assert.deepEqual(await snapshotDirectory(workspace.project), before, name);
  }
}

// #1084: under create-here, vite-plus is the parent's dependency, so the remedy for a missing
// vite-plus names the parent, where vp install installs it, not the inspected directory.
test("create-here under a Vite+ parent without vite-plus installed: the formatter error in apply --dry-run, apply --no-install, and init --apply says to run vp install in the parent", async () => {
  await using workspace = await directoryUnderManagedWorkspace({ installed: false });
  await assertEachRunStopsWith(
    workspace,
    `Run vp install in ${workspace.root}, then run Calavera again.`,
  );
});

// #1084: the nearest manifest above can be managed only because a manifest further up declares
// vite-plus. Outside a workspace, vp install in the nearest manifest's directory installs only its
// own dependencies, so the remedy names the directory of the manifest that declares vite-plus.
test("create-here below a member that a manifest further up manages: the remedy names the manifest that declares vite-plus", async () => {
  await using fixture = await createTemporaryFixture("manifest-choice-declared-further-up", {
    "package.json": json(libraryManifest),
    "packages/member/package.json": json(plainViteManifest),
    "packages/member/sub/calavera.config.json": json(recipe),
  });
  await using tools = await createTemporaryFixture("manifest-choice-declared-further-up-tools", {});
  await mkdir(join(fixture.root, ".git"));
  const bin = join(tools.root, "bin");
  await writePackageManagerStubs(bin);

  await assertEachRunStopsWith(
    {
      project: join(fixture.root, "packages/member/sub"),
      bin,
      packageManagerLog: join(tools.root, "package-manager.log"),
    },
    `Run vp install in ${fixture.root}, then run Calavera again.`,
  );
});

test("create-here does not run vp fmt when the parent is not managed by Vite+", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  // vite-plus is installed above the inspected directory but declared nowhere, so only the
  // verdict, not a missing package, keeps vp fmt from running.
  const fmtLog = join(fixture.root, "vp-fmt.log");
  await writeVitePlusStub(fixture.root, {
    logPath: join(fixture.root, "vp.log"),
    fmtLogPath: fmtLog,
  });

  for (const dryRun of [true, false]) {
    await inDirectory(fixture.project, false, () =>
      applyRecipeObject(structuredClone(recipe), {
        dryRun,
        assumeYes: true,
        noInstall: true,
        manifestChoice: "create-here",
      }),
    );
  }
  assert.deepEqual(await readStubInvocations(fmtLog), []);
});

test("init --apply with create-here formats the recipe it writes with vp fmt when the parent is managed by Vite+", async () => {
  await using workspace = await directoryUnderManagedWorkspace();

  const result = await runCli(workspace, [
    "init",
    "--apply",
    "--yes",
    "--json",
    "--profile",
    "minimal",
    "--manifest-choice",
    "create-here",
  ]);
  assert.equal(result.code, 0, result.stderr);
  const runs = await readStubInvocations(workspace.fmtLog);
  assert.ok(
    runs.some(
      ({ argv, cwd }) =>
        argv.includes("--stdin-filepath=calavera.config.json") && cwd === workspace.project,
    ),
    `init did not format calavera.config.json with vp fmt: ${JSON.stringify(runs)}`,
  );
});

test("init --apply with create-here does not run vp fmt when the parent is not managed by Vite+", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  await using tools = await createTemporaryFixture("manifest-choice-init-unmanaged-tools", {});
  const bin = join(tools.root, "bin");
  await writePackageManagerStubs(bin);
  // vite-plus is installed above the inspected directory but declared nowhere, so only the
  // verdict, not a missing package, keeps vp fmt from running.
  const fmtLog = join(tools.root, "vp-fmt.log");
  await writeVitePlusStub(fixture.root, {
    logPath: join(tools.root, "vp.log"),
    fmtLogPath: fmtLog,
  });

  const result = await runCli(
    { project: fixture.project, bin, packageManagerLog: join(tools.root, "package-manager.log") },
    [
      "init",
      "--apply",
      "--yes",
      "--json",
      "--no-install",
      "--profile",
      "minimal",
      "--manifest-choice",
      "create-here",
    ],
  );
  assert.equal(result.code, 0, result.stderr);
  assert.ok(
    JSON.parse(result.stdout).applyResult,
    "init --apply did not apply, so the test shows nothing",
  );
  assert.deepEqual(await readStubInvocations(fmtLog), []);
});

test("apply-at-ancestor inspects the ancestor again and applies there, leaving the inspected directory untouched", async () => {
  await using workspace = await directoryUnderManagedWorkspace();
  const projectBefore = await snapshotDirectory(workspace.project);
  const rootBefore = await snapshotDirectory(workspace.root);

  const dryRun = await runCli(workspace, [
    "apply",
    "--dry-run",
    "--json",
    "--manifest-choice",
    "apply-at-ancestor",
  ]);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  const planned = JSON.parse(dryRun.stdout);
  assert.equal(planned.manifestDecision.choice, "apply-at-ancestor");
  // The verdict is the ancestor's own, not the inspected directory's unknown.
  assert.equal(planned.vitePlus.status, "managed");
  assert.equal(planned.installCommand, "vp add -D -w knip");
  assert.deepEqual(await snapshotDirectory(workspace.root), rootBefore, "the dry run wrote");

  const applied = await runCli(workspace, [
    "apply",
    "--yes",
    "--manifest-choice",
    "apply-at-ancestor",
  ]);
  assert.equal(applied.code, 0, applied.stderr);
  assert.match(
    applied.stdout,
    new RegExp(`Applied at ${workspace.root.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}`),
  );

  assert.deepEqual(await invocations(workspace), {
    vp: [{ argv: ["add", "-D", "-w", "knip"], cwd: workspace.root }],
    packageManager: [],
  });
  assert.ok(
    (await readFile(join(workspace.root, ".editorconfig"), "utf8")).length > 0,
    "apply did not write at the ancestor",
  );
  assert.deepEqual(await snapshotDirectory(workspace.project), projectBefore);
});

test("abandon writes nothing, in a dry run and in an apply", async () => {
  await using workspace = await directoryUnderManagedWorkspace();
  const before = await snapshotDirectory(workspace.root);

  for (const args of [
    ["apply", "--dry-run", "--json", "--manifest-choice", "abandon"],
    ["apply", "--yes", "--json", "--manifest-choice", "abandon"],
  ]) {
    const result = await runCli(workspace, args);
    assert.equal(result.code, 0, result.stderr);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.manifestDecision.choice, "abandon");
    assert.deepEqual(parsed.changes, []);
  }

  const human = await runCli(workspace, ["apply", "--yes", "--manifest-choice", "abandon"]);
  assert.equal(human.code, 0, human.stderr);
  assert.match(human.stdout, /Abandoned\. No files were changed\./);

  assert.deepEqual(await snapshotDirectory(workspace.root), before);
  assert.deepEqual(await invocations(workspace), { vp: [], packageManager: [] });
});

test("an interactive apply asks for the choice once, and each answer is acted on only after it is given", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  const before = await snapshotDirectory(fixture.root);
  /** @type {string[]} */
  const asked = [];

  const abandoned = await inDirectory(fixture.project, true, () =>
    applyRecipeObject(structuredClone(recipe), {
      noInstall: true,
      askForManifestChoice: async (decision) => {
        // Nothing has been written when the question is asked.
        assert.deepEqual(
          decision.options.map(({ choice }) => choice),
          CHOICES,
        );
        assert.equal(decision.ancestor.status, "unmanaged");
        asked.push("abandon");
        return "abandon";
      },
    }),
  );
  assert.deepEqual(asked, ["abandon"]);
  assert.equal(abandoned.manifestDecision?.choice, "abandon");
  assert.deepEqual(await snapshotDirectory(fixture.root), before);

  // A dry run never asks, even in a terminal.
  const dryRun = await inDirectory(fixture.project, true, () =>
    applyRecipeObject(structuredClone(recipe), {
      dryRun: true,
      askForManifestChoice: async () => assert.fail("the dry run asked"),
    }),
  );
  assert.equal(dryRun.manifestDecision?.choice, undefined);
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("a choice given where there is no decision to make stops before writing anything", async () => {
  await using fixture = await createTemporaryFixture("manifest-choice-none", {
    "package.json": json(plainViteManifest),
    "calavera.config.json": json(recipe),
  });
  const before = await snapshotDirectory(fixture.root);

  for (const manifestChoice of CHOICES) {
    await assert.rejects(
      inDirectory(fixture.root, false, () =>
        applyRecipeObject(structuredClone(recipe), {
          dryRun: true,
          assumeYes: true,
          manifestChoice,
        }),
      ),
      /has its own package\.json, so there is no manifest choice to make/,
    );
  }
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("dry_run_apply reports the decision, and apply_recipe acts only on the choice it is given", async () => {
  await using workspace = await directoryUnderManagedWorkspace();
  const before = await snapshotDirectory(workspace.root);

  const dryRun = await inDirectory(workspace.project, false, () =>
    callMcpTool("dry_run_apply", { recipe }),
  );
  const decision = /** @type {any} */ (dryRun.result).manifestDecision;
  assert.deepEqual(
    decision.options.map((/** @type {{ choice: string }} */ { choice }) => choice),
    CHOICES,
  );
  assert.equal(decision.choice, undefined);

  await assert.rejects(
    inDirectory(workspace.project, false, () => callMcpTool("apply_recipe", { recipe })),
    /manifestChoice/,
  );

  const abandoned = await inDirectory(workspace.project, false, () =>
    callMcpTool("apply_recipe", { recipe, manifestChoice: "abandon" }),
  );
  assert.equal(/** @type {any} */ (abandoned.result).manifestDecision.choice, "abandon");

  assert.deepEqual(await snapshotDirectory(workspace.root), before);
  assert.deepEqual(await invocations(workspace), { vp: [], packageManager: [] });
});

test("an interactive create-here creates package.json without asking again, then applies with the ancestor's verdict", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  await using tools = await createTemporaryFixture("manifest-choice-interactive-tools", {});
  await writePackageManagerStubs(join(tools.root, "bin"));
  const log = join(tools.root, "package-manager.log");
  const previous = { PATH: process.env.PATH, STUB_LOG: process.env.STUB_LOG };
  process.env.PATH = `${join(tools.root, "bin")}${delimiter}${process.env.PATH ?? ""}`;
  process.env.STUB_LOG = log;

  try {
    const result = await inDirectory(fixture.project, true, () =>
      applyRecipeObject(structuredClone(recipe), {
        noInstall: true,
        askForManifestChoice: async () => "create-here",
      }),
    );
    assert.equal(result.manifestDecision?.choice, "create-here");
  } finally {
    process.env.PATH = previous.PATH;
    if (previous.STUB_LOG === undefined) delete process.env.STUB_LOG;
    else process.env.STUB_LOG = previous.STUB_LOG;
  }

  assert.deepEqual(await readStubInvocations(log), [{ argv: ["init"], cwd: fixture.project }]);
  // The ancestor is unmanaged, so quality runs the package manager's scripts, not vp check.
  const manifest = JSON.parse(await readFile(join(fixture.project, "package.json"), "utf8"));
  assert.doesNotMatch(String(manifest.scripts?.quality ?? ""), /vp check/);
  assert.equal(
    (await readFile(join(fixture.root, "package.json"), "utf8")).trim(),
    json(plainViteManifest).trim(),
  );
});

test("init --apply under an ancestor manifest stops before writing anything unless the choice is create-here", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  const before = await snapshotDirectory(fixture.root);
  const options = parseArgs(["init", "--apply", "--yes", "--json", "--profile", "minimal"]);

  for (const manifestChoice of [undefined, "apply-at-ancestor", "abandon"]) {
    await assert.rejects(
      inDirectory(fixture.project, false, () => initRecipe({ ...options, manifestChoice })),
      /init --apply writes calavera\.config\.json in .+ before it applies, so it runs only with --manifest-choice create-here\./,
    );
  }
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("apply-at-ancestor stops before writing anything when the ancestor already has a Calavera recipe", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  await writeFile(join(fixture.root, "calavera.config.json"), json(recipe));
  const before = await snapshotDirectory(fixture.root);

  for (const dryRun of [true, false]) {
    await assert.rejects(
      inDirectory(fixture.project, false, () =>
        applyRecipeObject(structuredClone(recipe), {
          dryRun,
          assumeYes: true,
          noInstall: true,
          manifestChoice: "apply-at-ancestor",
        }),
      ),
      /calavera\.config\.json already exists there, so the directory has a Calavera recipe of its own\./,
    );
  }
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("apply-at-ancestor stops on state without a recipe and names the state file, not a recipe", async () => {
  // #1038: the bootstrap that `--init` runs writes the state file without a recipe, so the stop
  // must not claim the ancestor has a recipe of its own.
  await using fixture = await directoryUnderUnmanagedProject();
  await mkdir(join(fixture.root, ".calavera"));
  await writeFile(join(fixture.root, ".calavera", "state.json"), json(createEmptyState()));
  const before = await snapshotDirectory(fixture.root);

  for (const dryRun of [true, false]) {
    const stopped = await inDirectory(fixture.project, false, () =>
      applyRecipeObject(structuredClone(recipe), {
        dryRun,
        assumeYes: true,
        noInstall: true,
        manifestChoice: "apply-at-ancestor",
      }),
    ).then(
      () => assert.fail("apply-at-ancestor did not stop"),
      (/** @type {Error} */ error) => error.message,
    );
    const statePath = join(fixture.root, ".calavera", "state.json");
    assert.ok(
      stopped.includes(
        `but ${statePath} already exists there, so Calavera has already recorded state for that directory.`,
      ),
      stopped,
    );
    assert.doesNotMatch(stopped, /recipe of its own/);
    assert.match(stopped, /with a recipe for that directory instead, or choose create-here\./);
    assert.match(stopped, /Calavera stopped before writing anything\.$/);
  }
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("apply-at-ancestor stops when the custom recipe path already exists in the ancestor", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  await writeFile(join(fixture.root, "custom.json"), json(recipe));
  const before = await snapshotDirectory(fixture.root);

  await assert.rejects(
    inDirectory(fixture.project, false, () =>
      applyRecipeObject(structuredClone(recipe), {
        dryRun: true,
        assumeYes: true,
        noInstall: true,
        config: "custom.json",
        manifestChoice: "apply-at-ancestor",
      }),
    ),
    /custom\.json already exists there, so the directory has a Calavera recipe of its own\./,
  );
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("apply-at-ancestor names the recipe when the ancestor has both a recipe and state", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  await writeFile(join(fixture.root, "calavera.config.json"), json(recipe));
  await mkdir(join(fixture.root, ".calavera"));
  await writeFile(join(fixture.root, ".calavera", "state.json"), json(createEmptyState()));

  await assert.rejects(
    inDirectory(fixture.project, false, () =>
      applyRecipeObject(structuredClone(recipe), {
        dryRun: true,
        assumeYes: true,
        noInstall: true,
        manifestChoice: "apply-at-ancestor",
      }),
    ),
    /calavera\.config\.json already exists there, so the directory has a Calavera recipe of its own\./,
  );
});

test("apply_recipe names the recipe file it wrote: none for abandon, the ancestor's for apply-at-ancestor", async () => {
  await using fixture = await directoryUnderUnmanagedProject();

  const abandoned = await inDirectory(fixture.project, false, () =>
    callMcpTool("apply_recipe", { recipe, manifestChoice: "abandon" }),
  );
  assert.equal(abandoned.configWritten, null);

  const projectBefore = await snapshotDirectory(fixture.project);
  const applied = await inDirectory(fixture.project, false, () =>
    callMcpTool("apply_recipe", { recipe, noInstall: true, manifestChoice: "apply-at-ancestor" }),
  );
  assert.equal(applied.configWritten, join(fixture.root, "calavera.config.json"));
  assert.deepEqual(
    JSON.parse(await readFile(join(fixture.root, "calavera.config.json"), "utf8")).integrations,
    recipe.integrations,
  );
  assert.deepEqual(await snapshotDirectory(fixture.project), projectBefore);
});

test("the MCP server runs one tool call at a time, so a parallel call is not inspected in the ancestor", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createMcpServer();
  const client = new Client({ name: "manifest-choice-test", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  try {
    const [applied, inspected] = await inDirectory(fixture.project, false, () =>
      Promise.all([
        client.callTool({
          name: "apply_recipe",
          arguments: { recipe, noInstall: true, manifestChoice: "apply-at-ancestor" },
        }),
        client.callTool({ name: "inspect_project", arguments: {} }),
      ]),
    );
    assert.notEqual(applied.isError, true, JSON.stringify(applied.content));
    // inspect_project ran in the inspected directory, which still has no manifest of its own.
    assert.equal(/** @type {any} */ (inspected.structuredContent).vitePlus.status, "unknown");
  } finally {
    await client.close();
    await server.close();
  }
});

test("a result that plans nothing has an empty plan in every field, and still reports why", async () => {
  await using fixture = await directoryUnderUnmanagedProject();

  for (const manifestChoice of [undefined, "abandon"]) {
    const result = await inDirectory(fixture.project, false, () =>
      applyRecipeObject(structuredClone(recipe), { dryRun: true, assumeYes: true, manifestChoice }),
    );
    for (const field of [
      "dependencies",
      "installNotes",
      "integrations",
      "changes",
      "scriptChanges",
      "pointers",
      "autoInstalledArtifacts",
      "artifactRegistries",
      "artifactWarnings",
      "artifactInputs",
      "integrationInputs",
      "inputWarnings",
      "wiringChanges",
      "wiringWarnings",
      "ignoreChanges",
      "stagingLeftovers",
      "temporaryFolderLeftovers",
    ]) {
      assert.deepEqual(result[field], [], `${field} is not empty`);
    }
    assert.equal(result.installCommand, null);
    assert.equal(result.vitePlus.status, "unknown");
    assert.ok(
      result.projectInspection.findings.some(({ kind }) => kind === "vite-plus-detection-unknown"),
    );
  }
});

test("applyRecipeObject refuses a manifest choice it does not know", async () => {
  await using fixture = await directoryUnderUnmanagedProject();
  const before = await snapshotDirectory(fixture.root);

  await assert.rejects(
    inDirectory(fixture.project, false, () =>
      applyRecipeObject(structuredClone(recipe), {
        dryRun: true,
        assumeYes: true,
        manifestChoice: /** @type {any} */ ("here"),
      }),
    ),
    /Invalid manifestChoice: here\. Allowed values: create-here, apply-at-ancestor, abandon\./,
  );
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("init --apply with a choice where there is no decision stops before writing the recipe", async () => {
  // Greptile on #954: abandon must never be ignored, because init would then write the recipe.
  await using fixture = await createTemporaryFixture("manifest-choice-init-no-decision", {
    "package.json": json(plainViteManifest),
  });
  const before = await snapshotDirectory(fixture.root);

  for (const manifestChoice of CHOICES) {
    const options = parseArgs([
      "init",
      "--apply",
      "--yes",
      "--json",
      "--profile",
      "minimal",
      "--manifest-choice",
      manifestChoice,
    ]);
    await assert.rejects(
      inDirectory(fixture.root, false, () => initRecipe(options)),
      /has its own package\.json, so there is no manifest choice to make/,
    );
  }
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});

test("apply-at-ancestor with a custom recipe path still stops when the ancestor has its default recipe", async () => {
  // Greptile on #954: the destination of a custom path is not the ancestor's default recipe.
  await using fixture = await directoryUnderUnmanagedProject();
  await writeFile(join(fixture.root, "calavera.config.json"), json(recipe));
  const before = await snapshotDirectory(fixture.root);

  for (const dryRun of [true, false]) {
    await assert.rejects(
      inDirectory(fixture.project, false, () =>
        applyRecipeObject(structuredClone(recipe), {
          dryRun,
          assumeYes: true,
          noInstall: true,
          config: "custom.json",
          manifestChoice: "apply-at-ancestor",
        }),
      ),
      /calavera\.config\.json already exists there, so the directory has a Calavera recipe of its own\./,
    );
  }
  assert.deepEqual(await snapshotDirectory(fixture.root), before);
});
