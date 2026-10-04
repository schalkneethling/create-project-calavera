// Tests for `--new` (ADR-0010). The CLI is spawned for real, and a stub
// placed first on PATH stands in for the package-manager runner, so these
// tests need neither network access nor vite-plus.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { createVpCreateCommand, newProject, parseArgs } from "../src/index.js";
import { detectVitePlus } from "../src/vite-plus-detection.js";
import {
  createTemporaryFixture,
  json,
  libraryManifest,
  vitePlusConfig,
} from "./vite-plus-fixtures.mjs";

const binPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const fixturesUrl = pathToFileURL(
  fileURLToPath(new URL("./vite-plus-fixtures.mjs", import.meta.url)),
);

/**
 * The runner stub. It records its argv and cwd, then acts on STUB_MODE:
 * `scaffold` writes a Vite+ project into the `--directory` target (or
 * STUB_TARGET), `unmanaged` writes a manifest without vite-plus, `unknown`
 * writes an unparseable manifest, `nothing` exits zero having written nothing,
 * and `fail` writes a partial manifest and exits 1. STUB_EXTRA names a second
 * directory that also receives a Vite+ manifest.
 */
const stubSource = `#!/usr/bin/env node
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { json, libraryManifest, plainViteManifest, vitePlusConfig } from ${JSON.stringify(fixturesUrl.href)};

const argv = process.argv.slice(2);
appendFileSync(process.env.STUB_LOG, JSON.stringify({ argv, cwd: process.cwd() }) + "\\n");

const separator = argv.indexOf("--");
const own = separator === -1 ? argv : argv.slice(0, separator);
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

  for (const name of ["npx", "pnpm", "yarn", "bunx"]) {
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
 * @param {{ work: string, log: string, bin: string }} workspace
 * @param {string[]} args
 * @param {Record<string, string>} [env]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(workspace, args, env = {}) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      {
        cwd: workspace.work,
        env: {
          ...process.env,
          NO_COLOR: "1",
          PATH: `${workspace.bin}${delimiter}${process.env.PATH ?? ""}`,
          STUB_LOG: workspace.log,
          ...env,
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

/**
 * The next-steps block --new prints after a successful scaffold and bootstrap.
 *
 * @param {string} target
 * @param {{ cd: string, applyDryRun: string, applyRecipe: string }} commands
 * @returns {string}
 */
function recipeBlock(target, { cd, applyDryRun, applyRecipe }) {
  return [
    RECIPE_BLOCK_HEADING,
    `  Either: open ${target} in your agent and use the prompt above.`,
    "  Or: compose one at https://calavera.schalkneethling.com/ and save",
    `      calavera.config.json into ${target}, then:`,
    `        ${cd}`,
    `        ${applyDryRun}`,
    `        ${applyRecipe}`,
  ].join("\n");
}

test("createVpCreateCommand names the vite-plus package and the vp bin for each runner", () => {
  const forwarded = ["vite:library", "--", "--template", "react-ts"];

  assert.deepEqual(createVpCreateCommand("npm", forwarded), {
    command: "npx",
    args: ["--package", "vite-plus", "vp", "create", ...forwarded],
  });
  assert.deepEqual(createVpCreateCommand("pnpm", forwarded), {
    command: "pnpm",
    args: ["dlx", "--package", "vite-plus", "vp", "create", ...forwarded],
  });
  assert.deepEqual(createVpCreateCommand("yarn", forwarded), {
    command: "yarn",
    args: ["dlx", "--package", "vite-plus", "vp", "create", ...forwarded],
  });
  assert.deepEqual(createVpCreateCommand("bun", forwarded), {
    command: "bunx",
    args: ["--package", "vite-plus", "vp", "create", ...forwarded],
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
  assert.match(result.stderr, /npm create project-calavera -- --init/);
  assert.deepEqual(await readInvocations(workspace.log), []);
});

test("--new refuses --init and --json", async () => {
  await using workspace = await createTemporaryWorkspace("contradictions");

  const withInit = await runCli(workspace, ["--yes", "--init", "--new", "vite:library"]);
  const withJson = await runCli(workspace, ["--yes", "--json", "--new", "vite:library"]);

  assert.equal(withInit.code, 1);
  assert.match(withInit.stderr, /--new and --init cannot be combined/);
  assert.equal(withJson.code, 1);
  assert.match(withJson.stderr, /--new cannot be combined with --json/);
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
  assert.match(
    result.stdout,
    /pnpm dlx --package vite-plus vp create vite:library --directory 'my lib'/,
  );
  assert.match(result.stdout, new RegExp(`Working directory: ${workspace.work}`));
  assert.match(result.stdout, /may download vite-plus/);
  assert.match(result.stdout, /asks its own questions/);
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
  assert.deepEqual(invocations[0].argv, [
    "--package",
    "vite-plus",
    "vp",
    "create",
    "vite:library",
    "--no-interactive",
  ]);
  assert.equal(invocations[0].cwd, workspace.work);
  assert.equal((await detectVitePlus(target)).status, "managed");
  assert.ok(await exists(join(target, ".agents/skills/calavera/SKILL.md")));
  assert.ok(await exists(join(target, ".calavera/state.json")));
  assert.ok(await exists(join(target, "AGENTS.md")));
  assert.equal(await exists(join(workspace.work, ".calavera")), false);
  assert.match(result.stdout, /Calavera agent bootstrap complete/);
  assert.match(result.stdout, /Next prompt: /);
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
  assert.ok(result.stdout.indexOf("Next prompt: ") < result.stdout.indexOf(RECIPE_BLOCK_HEADING));
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
  assert.deepEqual(invocations[0].argv, [
    "dlx",
    "--package",
    "vite-plus",
    "vp",
    "create",
    ...forwarded,
  ]);
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
      command: "npx",
      args: ["--package", "vite-plus", "vp", "create", "vite:library"],
      cwd: workspace.work,
    },
  ]);
});

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

  for (const [recipePath, cause] of [
    [malformed, /JSON/],
    [invalid, /profile/i],
  ]) {
    const result = await runCli(workspace, ["--yes", "--config", recipePath, "--new", "vite"], {
      STUB_MODE: "scaffold",
    });

    assert.equal(result.code, 1);
    assert.match(result.stderr, /--new refused/);
    assert.match(result.stderr, /not a valid recipe/);
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
  // Vite+ wrote package.json and vite.config.ts; the bootstrap wrote the
  // agent files; the recipe copy is the only other addition.
  assert.deepEqual((await readdir(target)).sort(), [
    ".agents",
    ".calavera",
    ".coderabbit.yaml",
    "AGENTS.md",
    "calavera.config.json",
    "package.json",
    "vite.config.ts",
  ]);
  assert.ok(result.stdout.includes(`Copied ${recipePath} to ${copied}.`), result.stdout);
  assert.ok(
    result.stdout.includes(
      [
        `Your project has a recipe at ${copied}. Calavera has not applied it.`,
        "  Preview it, then apply it after you approve the preview:",
        `    cd ${target}`,
        "    npm create project-calavera apply -- --dry-run",
        "    npm create project-calavera apply",
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
