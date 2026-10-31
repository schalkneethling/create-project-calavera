// #745: the protected branch guard through the agent flow. compose_recipe reports the input,
// dry_run_apply shows the wiring and returns the recipe with the value filled in, apply_recipe
// refuses a recipe without it, and an approved apply writes the skill and its wiring.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempDisposable, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";

const id = "skill-protected-branch-guard";
const line = (mode, branch) =>
  `node .agents/skills/protected-branch-guard/scripts/guard.mjs ${mode} ${branch}`;

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

/**
 * Runs `callback` in a new Git repository on main that holds a package.json and the scaffold's
 * pre-commit script.
 *
 * @param {(registry: ReturnType<typeof stubRegistry>) => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-guard-apply-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    git(["init", "--quiet", "--initial-branch=main"]);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    execFileSync("mkdir", [".vite-hooks"]);
    await writeFile(".vite-hooks/pre-commit", "vp staged\n");
    await callback(
      stubRegistry(
        new Map([
          [id, "0.1.0"],
          ["skill-project-goal", "0.1.0"],
        ]),
      ),
    );
  } finally {
    process.chdir(originalDirectory);
  }
}

function composed() {
  return { ...buildRecipe("minimal", [], "npm"), ai: [{ id }] };
}

test("compose_recipe reports the protected branch input with the current branch as its default", async () => {
  await inProject(async () => {
    const response = await callMcpTool("compose_recipe", {
      profile: "minimal",
      packageManager: "npm",
      tools: [],
      aiArtifacts: [{ id }],
    });
    assert.deepEqual(
      response.artifactInputs.map(({ artifact, name, recorded, default: value }) => ({
        artifact,
        name,
        recorded,
        value,
      })),
      [{ artifact: id, name: "protectedBranch", recorded: null, value: "main" }],
    );
  });
});

test("dry_run_apply shows the wiring and the warnings, returns the recipe with the value filled in, and writes nothing", async () => {
  await inProject(async (registry) => {
    const before = await snapshot();
    const { result } = await callMcpTool("dry_run_apply", { recipe: composed() }, registry);

    assert.deepEqual(result.artifactInputs, [
      { artifact: id, index: 0, name: "protectedBranch", value: "main", source: "default" },
    ]);
    assert.deepEqual(result.recipe.ai, [{ id, inputs: { protectedBranch: "main" } }]);
    assert.deepEqual(
      result.wiringChanges.map(({ path, type, block }) => [path, type, block]),
      [
        [".vite-hooks/pre-commit", "update", line("commit", "main")],
        [".vite-hooks/prepare-commit-msg", "write", line("commit", "main")],
        [".vite-hooks/pre-push", "write", line("pre-push", "main")],
        [".claude/settings.json", "write", undefined],
      ],
    );
    const paths = result.changes.map(({ path }) => path);
    for (const path of [
      ".vite-hooks/pre-commit",
      ".vite-hooks/prepare-commit-msg",
      ".vite-hooks/pre-push",
      ".claude/settings.json",
    ]) {
      assert.ok(paths.includes(path), path);
    }
    const warnings = result.wiringWarnings.join("\n");
    assert.match(warnings, /only the Vite\+ hook dispatcher runs the scripts in \.vite-hooks/);
    assert.match(warnings, /You are on main, the branch skill-protected-branch-guard protects/);
    assert.deepEqual(await snapshot(), before);
  });
});

test("apply_recipe refuses an input the recipe does not record and leaves the project unchanged", async () => {
  await inProject(async (registry) => {
    const before = await snapshot();
    await assert.rejects(
      callMcpTool("apply_recipe", { recipe: composed(), noInstall: true }, registry),
      /Calavera stopped before writing anything, because the recipe records no value for these artifact inputs[\s\S]*- skill-protected-branch-guard needs protectedBranch; the dry run would use main\. Record it as ai\[0\]\.inputs\.protectedBranch\./,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("apply_recipe with the dry run's recipe writes the skill and its wiring, and the next dry run finds them unchanged", async () => {
  await inProject(async (registry) => {
    git(["switch", "--quiet", "-c", "745-guard"]);
    const { result: preview } = await callMcpTool(
      "dry_run_apply",
      { recipe: { ...composed(), ai: [{ id, inputs: { protectedBranch: "main" } }] } },
      registry,
    );
    await callMcpTool("apply_recipe", { recipe: preview.recipe, noInstall: true }, registry);

    assert.equal(
      await readFile(".vite-hooks/pre-commit", "utf8"),
      `# calavera:${id}:start\n${line("commit", "main")}\n# calavera:${id}:end\nvp staged\n`,
    );
    assert.match(await readFile(".vite-hooks/pre-push", "utf8"), /guard\.mjs pre-push main/);
    const settings = JSON.parse(await readFile(".claude/settings.json", "utf8"));
    assert.deepEqual(Object.keys(settings.hooks), ["SessionStart", "PreToolUse"]);
    await readFile(".agents/skills/protected-branch-guard/scripts/guard.mjs", "utf8");
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(Object.keys(state.aiWiring[0].viteHooks), [
      "pre-commit",
      "prepare-commit-msg",
      "pre-push",
    ]);
    const config = JSON.parse(await readFile("calavera.config.json", "utf8"));
    assert.deepEqual(config.ai, [{ id, inputs: { protectedBranch: "main" } }]);

    const { result: again } = await callMcpTool(
      "dry_run_apply",
      { recipe: preview.recipe },
      registry,
    );
    assert.deepEqual(
      again.wiringChanges.map(({ type }) => type),
      ["unchanged", "unchanged", "unchanged", "unchanged"],
    );
    // On a feature branch, only the missing dispatcher is reported.
    assert.doesNotMatch(again.wiringWarnings.join("\n"), /You are on/);
  });
});

test("an edited guard block stops apply before any skill or any wiring is written", async () => {
  await inProject(async (registry) => {
    const recipe = { ...composed(), ai: [{ id, inputs: { protectedBranch: "main" } }] };
    await callMcpTool("apply_recipe", { recipe, noInstall: true }, registry);
    await writeFile(
      ".vite-hooks/pre-push",
      (await readFile(".vite-hooks/pre-push", "utf8")).replace("pre-push main", "pre-push dev"),
    );
    const before = await snapshot();

    await assert.rejects(
      callMcpTool(
        "apply_recipe",
        {
          // A newly selected skill would be copied first if the wiring were checked after it.
          recipe: {
            ...recipe,
            ai: [{ id, inputs: { protectedBranch: "trunk" } }, { id: "skill-project-goal" }],
          },
          noInstall: true,
        },
        registry,
      ),
      /Calavera stopped before writing anything[\s\S]*\.vite-hooks\/pre-push: the Calavera block for skill-protected-branch-guard was edited/,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("in a workspace member, the guard stops before anything is written, because Git runs hooks from the repository root", async () => {
  await inProject(async (registry) => {
    execFileSync("mkdir", ["app"]);
    process.chdir("app");
    try {
      await writeFile("package.json", `${JSON.stringify({ name: "app" }, null, 2)}\n`);
      const before = await snapshot("..");
      await assert.rejects(
        callMcpTool("dry_run_apply", { recipe: composed() }, registry),
        /skill-protected-branch-guard applies at the repository root, not in a workspace member\. It writes Git hooks, and Git runs every hook from the repository root/,
      );
      assert.deepEqual(await snapshot(".."), before);
    } finally {
      process.chdir("..");
    }
  });
});
