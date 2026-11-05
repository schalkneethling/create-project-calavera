// #802: the wiring of an artifact the recipe no longer selects. Owner decision of 2026-11-05
// (ADR-0015, Decision 5): apply removes the artifact's unchanged hook blocks and Claude Code groups,
// the dry run lists each removal first, and an edited block or group is a conflict that names the
// file and stops apply. `doctor` reports recorded wiring that is missing or edited, and a block
// whose script is missing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempDisposable, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";

const id = "skill-protected-branch-guard";
const skillDirectory = ".agents/skills/protected-branch-guard";
const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const line = (/** @type {string} */ mode) =>
  `node ${skillDirectory}/scripts/guard.mjs ${mode} main`;
const hooks = /** @type {const} */ (["pre-commit", "prepare-commit-msg", "pre-push"]);

// The person's own text in the files the guard wires. Apply inserts its block after the `#!`
// line, and the settings file is written as two-space JSON, so removal must give these bytes back.
const ownPreCommit = "#!/bin/sh\n# my own check\nvp staged\n";
const ownSettings = `${JSON.stringify(
  {
    model: "mine",
    hooks: {
      PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] }],
    },
  },
  null,
  2,
)}\n`;

/** @param {string[]} args */
function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

function guardRecipe() {
  return {
    ...buildRecipe("minimal", [], "npm"),
    ai: [{ id, inputs: { protectedBranch: "main" } }],
  };
}

function deselectedRecipe() {
  return { ...buildRecipe("minimal", [], "npm"), ai: [] };
}

/**
 * Runs `callback` in a new Git repository, on a feature branch, where the guard was applied and
 * wired into the person's own pre-commit script and settings file.
 *
 * @param {(registry: ReturnType<typeof stubRegistry>) => Promise<void>} callback
 */
async function inWiredProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-deselected-wiring-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["switch", "--quiet", "-c", "802-deselect"]);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    execFileSync("mkdir", [".vite-hooks", ".claude"]);
    await writeFile(".vite-hooks/pre-commit", ownPreCommit);
    await writeFile(".claude/settings.json", ownSettings);
    const registry = stubRegistry(new Map([[id, "0.1.0"]]));
    await callMcpTool("apply_recipe", { recipe: guardRecipe(), noInstall: true }, registry);
    await callback(registry);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @returns {Promise<{ level: string, message: string }[]>} */
async function doctorIssues() {
  const output = execFileSync(process.execPath, [cli, "doctor", "--json"], { encoding: "utf8" });
  return JSON.parse(output).issues;
}

test("Given a project where the guard was applied and wired, when the recipe drops skill-protected-branch-guard and dry_run_apply runs, then it lists the removal of each unchanged block and group and writes nothing", async () => {
  await inWiredProject(async (registry) => {
    const before = await snapshot();
    const { result } = await callMcpTool("dry_run_apply", { recipe: deselectedRecipe() }, registry);

    assert.deepEqual(
      result.wiringChanges.map(({ artifact, path, kind, removedBlock, deselected }) => [
        artifact,
        path,
        kind,
        removedBlock,
        deselected,
      ]),
      [
        [id, ".vite-hooks/pre-commit", "vite-hook", line("commit"), true],
        [id, ".vite-hooks/prepare-commit-msg", "vite-hook", line("commit"), true],
        [id, ".vite-hooks/pre-push", "vite-hook", line("pre-push"), true],
        [id, ".claude/settings.json", "claude-settings", undefined, true],
      ],
    );
    const groupChanges = result.wiringChanges.find(
      ({ kind }) => kind === "claude-settings",
    )?.groupChanges;
    assert.deepEqual(
      groupChanges?.map(({ event, action }) => [event, action]),
      [
        ["SessionStart", "remove"],
        ["PreToolUse", "remove"],
      ],
    );
    for (const path of [...hooks.map((hook) => `.vite-hooks/${hook}`), ".claude/settings.json"]) {
      assert.equal(result.changes.find((change) => change.path === path)?.type, "update", path);
    }
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the guard deselected, apply --dry-run in a terminal says why each block and group would be removed and writes nothing", async () => {
  await inWiredProject(async () => {
    await writeFile("calavera.config.json", `${JSON.stringify(deselectedRecipe(), null, 2)}\n`);
    const before = await snapshot();
    const output = execFileSync(process.execPath, [cli, "apply", "--dry-run", "--yes"], {
      encoding: "utf8",
      env: { ...process.env, NO_COLOR: "1" },
    });

    for (const hook of hooks) {
      assert.match(
        output,
        new RegExp(
          `Would remove the ${id} block from \\.vite-hooks/${hook}, because the recipe no longer selects ${id}`,
        ),
      );
    }
    for (const event of ["SessionStart", "PreToolUse"]) {
      assert.match(
        output,
        new RegExp(
          `Would remove the ${event} group for ${id} from \\.claude/settings\\.json, because the recipe no longer selects ${id}`,
        ),
      );
    }
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given a project where the guard was applied and wired, when apply runs with skill-protected-branch-guard dropped from the recipe, then the blocks and groups are gone, the person's own lines in those files remain byte-for-byte, and a later dry run plans nothing", async () => {
  await inWiredProject(async (registry) => {
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);

    assert.equal(await readFile(".vite-hooks/pre-commit", "utf8"), ownPreCommit);
    assert.equal(await readFile(".claude/settings.json", "utf8"), ownSettings);
    for (const hook of ["prepare-commit-msg", "pre-push"]) {
      assert.doesNotMatch(await readFile(`.vite-hooks/${hook}`, "utf8"), /calavera|guard\.mjs/);
    }
    // The record goes with the wiring it described (criterion 3).
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.aiWiring, []);

    const before = await snapshot();
    const { result: again } = await callMcpTool(
      "dry_run_apply",
      { recipe: deselectedRecipe() },
      registry,
    );
    assert.deepEqual(again.wiringChanges, []);
    const wiringPaths = [...hooks.map((hook) => `.vite-hooks/${hook}`), ".claude/settings.json"];
    assert.deepEqual(
      again.changes.filter(({ path }) => wiringPaths.includes(path)),
      [],
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the guard's wiring was removed and its record dropped, when the recipe selects the guard again, then apply writes the blocks and groups again", async () => {
  await inWiredProject(async (registry) => {
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);
    await callMcpTool("apply_recipe", { recipe: guardRecipe(), noInstall: true }, registry);

    assert.equal(
      await readFile(".vite-hooks/pre-commit", "utf8"),
      `#!/bin/sh\n# calavera:${id}:start\n${line("commit")}\n# calavera:${id}:end\n# my own check\nvp staged\n`,
    );
    const settings = JSON.parse(await readFile(".claude/settings.json", "utf8"));
    assert.equal(settings.hooks.PreToolUse.length, 2);
    assert.equal(settings.hooks.SessionStart.length, 1);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(
      state.aiWiring.map(({ artifact }) => artifact),
      [id],
    );
  });
});

test("Given the same project with one character edited inside a guard block, when apply runs with the artifact deselected, then it stops with a conflict naming the file and writes nothing", async () => {
  await inWiredProject(async (registry) => {
    await writeFile(
      ".vite-hooks/pre-push",
      (await readFile(".vite-hooks/pre-push", "utf8")).replace("pre-push main", "pre-push mainx"),
    );
    const before = await snapshot();

    await assert.rejects(
      callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry),
      /Calavera stopped before writing anything[\s\S]*\.vite-hooks\/pre-push: the recipe no longer selects skill-protected-branch-guard, so Calavera would remove its block, but the block was edited since Calavera wrote it/,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the same project with an edited guard group, when apply runs with the artifact deselected, then it stops with a conflict naming the file and writes nothing", async () => {
  await inWiredProject(async (registry) => {
    const settings = JSON.parse(await readFile(".claude/settings.json", "utf8"));
    settings.hooks.SessionStart[0].hooks[0].timeout = 11;
    await writeFile(".claude/settings.json", `${JSON.stringify(settings, null, 2)}\n`);
    const before = await snapshot();

    await assert.rejects(
      callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry),
      /Calavera stopped before writing anything[\s\S]*\.claude\/settings\.json: hooks\.SessionStart holds a group that runs \.agents\/skills\/protected-branch-guard\/ and was edited since Calavera wrote it[\s\S]*The recipe no longer selects skill-protected-branch-guard, so Calavera would remove its groups, but it never deletes a group that was edited/,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given recorded wiring that is intact, doctor reports no wiring issue", async () => {
  await inWiredProject(async () => {
    assert.deepEqual(
      (await doctorIssues()).filter(({ message }) => message.includes(id)),
      [],
    );
  });
});

test("Given a recorded block and a recorded group that are missing, doctor names each file and the remedy", async () => {
  await inWiredProject(async () => {
    await writeFile(".vite-hooks/prepare-commit-msg", "");
    const settings = JSON.parse(await readFile(".claude/settings.json", "utf8"));
    delete settings.hooks.SessionStart;
    await writeFile(".claude/settings.json", `${JSON.stringify(settings, null, 2)}\n`);

    const messages = (await doctorIssues()).map(({ message }) => message);
    assert.ok(
      messages.some((message) =>
        /^\.vite-hooks\/prepare-commit-msg: the skill-protected-branch-guard block that Calavera recorded is missing[\s\S]*Run create-project-calavera apply/.test(
          message,
        ),
      ),
      messages.join("\n"),
    );
    assert.ok(
      messages.some((message) =>
        /^\.claude\/settings\.json: the SessionStart group for skill-protected-branch-guard that Calavera recorded is missing[\s\S]*Run create-project-calavera apply/.test(
          message,
        ),
      ),
      messages.join("\n"),
    );
  });
});

test("Given an edited block and an edited group, doctor names each file and the remedy", async () => {
  await inWiredProject(async () => {
    await writeFile(
      ".vite-hooks/pre-push",
      (await readFile(".vite-hooks/pre-push", "utf8")).replace("pre-push main", "pre-push mainx"),
    );
    const settings = JSON.parse(await readFile(".claude/settings.json", "utf8"));
    settings.hooks.PreToolUse[1].matcher = "Write";
    await writeFile(".claude/settings.json", `${JSON.stringify(settings, null, 2)}\n`);

    const messages = (await doctorIssues()).map(({ message }) => message);
    assert.ok(
      messages.some((message) =>
        /^\.vite-hooks\/pre-push: the skill-protected-branch-guard block was edited since Calavera wrote it[\s\S]*Restore it to/.test(
          message,
        ),
      ),
      messages.join("\n"),
    );
    assert.ok(
      messages.some((message) =>
        /^\.claude\/settings\.json: a PreToolUse group that runs \.agents\/skills\/protected-branch-guard\/ was edited since Calavera wrote it[\s\S]*Restore it to/.test(
          message,
        ),
      ),
      messages.join("\n"),
    );
  });
});

test("Given the skill directory deleted by hand, doctor reports each block whose script is missing as an error with the remedy", async () => {
  await inWiredProject(async () => {
    await rm(skillDirectory, { recursive: true });

    const issues = (await doctorIssues()).filter(({ message }) => message.includes("not exist"));
    assert.deepEqual(
      issues.map(({ level, message }) => [level, message.split(":")[0]]),
      hooks.map((hook) => ["error", `.vite-hooks/${hook}`]),
    );
    for (const { message } of issues) {
      assert.match(
        message,
        /runs \.agents\/skills\/protected-branch-guard\/scripts\/guard\.mjs, which does not exist[\s\S]*Run create-project-calavera apply to install the skill again/,
      );
    }
  });
});

test("Given the skill directory deleted by hand and the guard deselected, doctor's remedy is the apply that removes the blocks", async () => {
  await inWiredProject(async () => {
    await rm(skillDirectory, { recursive: true });
    await writeFile("calavera.config.json", `${JSON.stringify(deselectedRecipe(), null, 2)}\n`);

    const issues = (await doctorIssues()).filter(({ message }) => message.includes("not exist"));
    assert.equal(issues.length, 3);
    for (const { message } of issues) {
      assert.match(
        message,
        /Because the recipe no longer selects skill-protected-branch-guard, create-project-calavera apply removes the block/,
      );
    }
  });
});
