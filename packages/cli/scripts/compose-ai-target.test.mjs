// #1077: composing a recipe accepted any single directory name as an AI target, while validation
// accepts only the targets the artifact supports, so `init --ai-artifact id@target` and the MCP
// compose_recipe tool could build a recipe that validation rejects, and init wrote it to disk.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { aiArtifactCatalog } from "../src/ai/catalog.js";
import { initRecipe } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, composeRecipe, validateRecipe } from "../src/recipe.js";
import { createTemporaryFixture, json, plainViteManifest } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));

const HOOK = "hook-block-dangerous-commands";
const UNSUPPORTED = "windsurf";
const hookArtifact = aiArtifactCatalog.find(({ id }) => id === HOOK);

/**
 * The message validateRecipe gives for the same selection, so each path below is held to it.
 *
 * @param {Array<{ id: string, target?: string }>} ai
 */
function validationMessage(ai) {
  try {
    validateRecipe({ ...buildRecipe("minimal", [], "npm"), ai });
  } catch (error) {
    return /** @type {Error} */ (error).message;
  }
  return assert.fail("validateRecipe accepted the unsupported target");
}

test("the fixture target is one the hook does not support", () => {
  assert.ok(hookArtifact?.targets);
  assert.equal(hookArtifact.targets.includes(UNSUPPORTED), false);
});

test("composeRecipe rejects an unsupported target with validateRecipe's message", () => {
  const ai = [{ id: HOOK, target: UNSUPPORTED }];
  assert.equal(validationMessage(ai), `AI item at index 0 target is not supported by ${HOOK}.`);
  assert.throws(() => composeRecipe({ profile: "minimal", aiArtifacts: ai }), {
    message: validationMessage(ai),
  });
});

test("composeRecipe names the index of the unsupported selection", () => {
  const ai = [{ id: "skill-frontend-engineering" }, { id: HOOK, target: UNSUPPORTED }];
  assert.throws(() => composeRecipe({ profile: "minimal", aiArtifacts: ai }), {
    message: validationMessage(ai),
  });
});

test("composeRecipe resolves a label before it checks the target", () => {
  assert.throws(
    () =>
      composeRecipe({
        profile: "minimal",
        aiArtifacts: [{ id: hookArtifact.label, target: UNSUPPORTED }],
      }),
    { message: validationMessage([{ id: HOOK, target: UNSUPPORTED }]) },
  );
});

test("composeRecipe accepts every target the artifact supports, and the recipe validates", () => {
  for (const target of hookArtifact.targets) {
    const recipe = composeRecipe({ profile: "minimal", aiArtifacts: [{ id: HOOK, target }] });
    assert.deepEqual(recipe.ai, [{ id: HOOK, target }]);
    assert.doesNotThrow(() => validateRecipe(structuredClone(recipe)));
  }
});

test("composeRecipe still gives an empty target the artifact's default target", () => {
  for (const target of ["", "  "]) {
    const recipe = composeRecipe({ profile: "minimal", aiArtifacts: [{ id: HOOK, target }] });
    assert.deepEqual(recipe.ai, [{ id: HOOK, target: hookArtifact.defaultTarget }]);
  }
});

test("MCP compose_recipe rejects an unsupported target with validateRecipe's message", async () => {
  const ai = [{ id: HOOK, target: UNSUPPORTED }];
  await assert.rejects(callMcpTool("compose_recipe", { profile: "minimal", aiArtifacts: ai }), {
    message: validationMessage(ai),
  });
});

test("init --ai-artifact id@target with an unsupported target fails and writes no recipe", async () => {
  await using fixture = await createTemporaryFixture("init-unsupported-ai-target", {
    "package.json": json(plainViteManifest),
  });
  const before = await readdir(fixture.root);

  const result = spawnSync(
    process.execPath,
    [cliPath, "init", "--yes", "--profile", "minimal", "--ai-artifact", `${HOOK}@${UNSUPPORTED}`],
    {
      cwd: fixture.root,
      env: { ...process.env, NO_COLOR: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 60_000,
    },
  );

  assert.equal(result.signal, null, `init timed out or was killed:\n${result.stdout}`);
  assert.notEqual(result.status, 0, `init succeeded:\n${result.stdout}`);
  assert.match(
    `${result.stdout}\n${result.stderr}`,
    new RegExp(`target is not supported by ${HOOK}`),
  );
  assert.deepEqual(await readdir(fixture.root), before);
});

/**
 * Runs init in-process, so Stryker sees which tests reach the compose and write steps; it cannot
 * see into the child process the test above starts.
 */
test("initRecipe rejects an unsupported target before it writes the recipe", async () => {
  await using fixture = await createTemporaryFixture("init-unsupported-ai-target-in-process", {
    "package.json": json(plainViteManifest),
  });
  const before = await readdir(fixture.root);
  const originalDirectory = process.cwd();
  process.chdir(fixture.root);
  try {
    await assert.rejects(
      initRecipe({
        command: "init",
        config: "calavera.config.json",
        dryRun: false,
        json: true,
        noInstall: true,
        apply: false,
        assumeYes: true,
        profile: "minimal",
        packageManager: "npm",
        integrations: [],
        aiArtifacts: [{ id: HOOK, target: UNSUPPORTED }],
      }),
      { message: validationMessage([{ id: HOOK, target: UNSUPPORTED }]) },
    );
  } finally {
    process.chdir(originalDirectory);
  }
  assert.deepEqual(await readdir(fixture.root), before);
});
