// Issue #1101: doctor resolves a legacy AI entry (`{ "type": "skill", "src": "skills/project-goal" }`)
// to its catalog artifact, as apply and `artifacts status` do. apply installs the artifact's package
// payload, so the legacy source path never exists in the project, and doctor must not report it
// as a missing source. Since #1030 that error made doctor exit 1 on a project apply set up.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));

/** @param {object[]} ai */
function recipeWith(ai) {
  return { ...buildRecipe("minimal", [], "npm"), ai };
}

/**
 * Runs `callback` in a new Git repository on a feature branch, holding a `package.json`.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-doctor-legacy-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"]);
    execFileSync("git", ["switch", "--quiet", "-c", "1101-legacy"]);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {object} recipe */
async function writeRecipe(recipe) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
}

/** Runs `doctor --json` and returns its exit status and output. */
function runDoctor() {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, "doctor", "--json"], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  return { status, stdout, stderr };
}

test("Given apply installed a legacy skill entry, doctor reports no issue and exits 0", async () => {
  await inProject(async () => {
    const recipe = recipeWith([{ type: "skill", src: "skills/project-goal" }]);
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    await callMcpTool("apply_recipe", { recipe, noInstall: true }, registry);
    await writeRecipe(recipe);

    const { status, stdout, stderr } = runDoctor();
    assert.equal(status, 0, `doctor exited ${status}\n${stdout}\n${stderr}`);
    assert.deepEqual(JSON.parse(stdout), { command: "doctor", ok: true, issues: [] });
  });
});

test("Given a legacy skill entry apply has not installed, doctor warns about the missing output instead of a missing source", async () => {
  await inProject(async () => {
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/project-goal" }]));

    const { status, stdout, stderr } = runDoctor();
    assert.equal(status, 0, `doctor exited ${status}\n${stdout}\n${stderr}`);
    assert.deepEqual(JSON.parse(stdout).issues, [
      {
        level: "warning",
        message:
          "Missing managed AI skill: .agents/skills/project-goal. Run create-project-calavera apply to regenerate managed AI artifacts.",
      },
    ]);
  });
});

test("Given a legacy entry selects a wired artifact apply installed, doctor treats its recorded wiring as selected", async () => {
  await inProject(async () => {
    const id = "skill-protected-branch-guard";
    const registry = stubRegistry(new Map([[id, "0.1.0"]]));
    await callMcpTool(
      "apply_recipe",
      { recipe: recipeWith([{ id, inputs: { protectedBranch: "main" } }]), noInstall: true },
      registry,
    );
    // The same artifact, selected by its legacy type and src.
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/protected-branch-guard" }]));
    // Each recorded block missing, so doctor names whether the recipe still selects the guard.
    await writeFile(".vite-hooks/pre-commit", "#!/bin/sh\n");

    const { stdout } = runDoctor();
    const messages = JSON.parse(stdout).issues.map(
      (/** @type {{ message: string }} */ { message }) => message,
    );
    assert.ok(
      messages.some((message) => message.includes(`the ${id} block that Calavera recorded`)),
      messages.join("\n"),
    );
    assert.deepEqual(
      messages.filter((message) => message.includes("no longer selects")),
      [],
    );
  });
});

test("Given a legacy entry that names a source no catalog provides, doctor reports an error and exits 1", async () => {
  await inProject(async () => {
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/not-in-catalog" }]));

    const { status, stdout, stderr } = runDoctor();
    assert.equal(status, 1, `doctor exited ${status}\n${stdout}\n${stderr}`);
    assert.match(`${stdout}${stderr}`, /skills\/not-in-catalog/);
  });
});
