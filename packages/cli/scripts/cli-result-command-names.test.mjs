// Issue #1227, owner decision of 2026-11-23: with `--json`, an error result's `command` is the
// name the command's success result uses, in both error paths: a run whose arguments are invalid
// (#1218) and a command that throws while it runs (#1227). `update` applies the recipe as apply
// does and reports `apply`, `bootstrap` runs the agent-init bootstrap and reports `agent-init`, and
// each artifacts action reports `artifacts <action>`. Each test runs a success and both failures
// and requires the three `command` values to be equal.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject, newProject, parseArgs } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

/**
 * Runs the CLI in `cwd` and resolves with its exit code and standard output. stdin is not a
 * terminal and `CI` is set, so no command prompts.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1", CI: "1" } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
        });
      },
    );
    child.stdin?.end();
  });
}

/**
 * The `command` of the JSON result a run printed.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<unknown>}
 */
async function resultCommand(cwd, args) {
  const result = await runCli(cwd, args);
  try {
    return JSON.parse(result.stdout).command;
  } catch {
    assert.fail(`${args.join(" ")} printed no JSON result:\n${result.stdout}\n${result.stderr}`);
  }
}

/**
 * Runs `callback` with `directory` as the working directory, as the CLI runs.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

/** @type {{ root: string, [Symbol.asyncDispose]: () => Promise<void> }} */
let project;
/** A project with a recipe, where each success run below succeeds. */
let succeeding = "";
/** A project whose state cannot be parsed and that has no recipe, where each failure run fails. */
let failing = "";

before(async () => {
  project = await copyReleaseFixture("library");
  succeeding = project.root;
  const init = await runCli(succeeding, ["init", "--json", "--yes", "--no-install"]);
  assert.equal(init.code, 0, init.stderr);

  failing = await mkdtemp(join(tmpdir(), "calavera-1227-names-"));
  await writeFile(join(failing, "package.json"), "{}\n");
  await mkdir(join(failing, ".calavera"));
  await writeFile(join(failing, ".calavera", "state.json"), "{ bad");
});

after(async () => {
  await project?.[Symbol.asyncDispose]();
  if (failing) await rm(failing, { recursive: true, force: true });
});

const cases = [
  {
    command: "init",
    success: ["init", "--json", "--yes", "--dry-run"],
    // Without --yes, init refuses to prompt.
    failure: ["init", "--json"],
    name: "init",
  },
  {
    command: "agent-init",
    success: ["agent-init", "--json", "--dry-run"],
    failure: ["agent-init", "--json"],
    name: "agent-init",
  },
  {
    command: "bootstrap",
    success: ["bootstrap", "--json", "--dry-run"],
    failure: ["bootstrap", "--json"],
    name: "agent-init",
  },
  {
    command: "apply",
    success: ["apply", "--json", "--dry-run"],
    failure: ["apply", "--json", "--config", "missing.json"],
    name: "apply",
  },
  {
    command: "update",
    success: ["update", "--json", "--dry-run"],
    failure: ["update", "--json", "--config", "missing.json"],
    name: "apply",
  },
  {
    // doctor returns its own error result (#1141, #1206), here for the missing recipe.
    command: "doctor",
    success: ["doctor", "--json"],
    failure: ["doctor", "--json"],
    name: "doctor",
  },
  {
    command: "clean",
    success: ["clean", "--json", "--dry-run"],
    failure: ["clean", "--json"],
    name: "clean",
  },
  {
    command: "eject",
    success: ["eject", "--json", "--dry-run"],
    failure: ["eject", "--json", "--config", "package.json"],
    name: "eject",
  },
  ...["status", "doctor", "migrate", "install"].map((action) => ({
    command: `artifacts ${action}`,
    success: ["artifacts", action, "--json", "--dry-run"],
    failure: ["artifacts", action, "--json", "--all"],
    name: `artifacts ${action}`,
  })),
];

for (const { command, success, failure, name } of cases) {
  test(`${command} names its error results ${name}, as its success result does`, async () => {
    const succeeded = await resultCommand(succeeding, success);
    const stopped = await resultCommand(failing, failure);
    const refused = await resultCommand(failing, [...success, "--bogus"]);

    assert.equal(succeeded, name);
    assert.deepEqual({ stopped, refused }, { stopped: succeeded, refused: succeeded });
  });
}

// A successful `artifacts update` resolves the selected artifacts from the registry, so it runs in
// the process with a registry stand-in instead of the CLI.
test("artifacts update names its error results artifacts update, as its success result does", async () => {
  await using fixture = await copyReleaseFixture("library");
  const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
  const recipe = { ...buildRecipe("default", [], "pnpm", []), ai: [{ id: "skill-project-goal" }] };
  const succeeded = await inDirectory(fixture.root, async () => {
    await applyRecipeObject(
      recipe,
      {
        json: true,
        noInstall: true,
        assumeYes: true,
        writeConfig: true,
        config: "calavera.config.json",
      },
      registry,
    );
    const result = await runArtifactCommand(
      { config: "calavera.config.json", dryRun: true, artifactAction: "update", artifactAll: true },
      registry,
    );
    return result.command;
  });
  const stopped = await resultCommand(failing, ["artifacts", "update", "--json", "--all"]);
  const refused = await resultCommand(failing, ["artifacts", "update", "--json", "--bogus"]);

  assert.equal(succeeded, "artifacts update");
  assert.deepEqual({ stopped, refused }, { stopped: succeeded, refused: succeeded });
});

// `--new` refuses `--json`, so its success result comes from a dry run in the process.
test("new names its error results new, as its success result does", async () => {
  const empty = await mkdtemp(join(tmpdir(), "calavera-1227-new-"));
  try {
    const succeeded = await inDirectory(
      empty,
      async () => (await newProject(parseArgs(["--dry-run", "--new"]))).command,
    );
    const stopped = await resultCommand(empty, ["--json", "--new"]);
    const refused = await resultCommand(empty, ["--json", "--bogus", "--new"]);

    assert.equal(succeeded, "new");
    assert.deepEqual({ stopped, refused }, { stopped: succeeded, refused: succeeded });
  } finally {
    await rm(empty, { recursive: true, force: true });
  }
});

test("an artifacts action Calavera does not have names no command", async () => {
  // No success result names it, so the error result names none, as for an unknown command.
  assert.equal(await resultCommand(failing, ["artifacts", "bogus", "--json"]), null);
  assert.equal(await resultCommand(failing, ["artifacts", "--json"]), null);
  assert.equal(await resultCommand(failing, ["artifacts", "bogus", "--json", "--bogus"]), null);
});

test("help names no command in an error result, because it prints no result", async () => {
  assert.equal(await resultCommand(failing, ["help", "--json", "--bogus"]), null);
  assert.equal(await resultCommand(failing, ["--help", "--json", "--bogus"]), null);
});
