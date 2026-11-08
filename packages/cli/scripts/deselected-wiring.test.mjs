// #802: the wiring of an artifact the recipe no longer selects. Owner decision of 2026-11-05
// (ADR-0015, Decision 5): apply removes the artifact's unchanged hook blocks and Claude Code groups,
// the dry run lists each removal first, and an edited block or group is a conflict that names the
// file and stops apply. `doctor` reports recorded wiring that is missing or edited, and a block
// whose script is missing.
//
// #829: `clean` follows the same rules (owner decision of 2026-11-07), so running it before apply
// cannot delete a skill directory that recorded wiring still runs. An apply that deselects an
// artifact keeps its record of the installed directory, so a later `clean` removes the directory
// when it is unedited and reports it when it was edited.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
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
const script = `${skillDirectory}/scripts/guard.mjs`;
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

/**
 * The messages of doctor's errors about a block whose script does not exist.
 *
 * @returns {Promise<string[]>}
 */
async function missingScriptErrors() {
  return (await doctorIssues())
    .filter(({ level, message }) => level === "error" && message.includes("does not exist"))
    .map(({ message }) => message);
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

test("Given the skill directory deleted by hand, doctor reports each block whose script is missing as an error with the remedy, and apply repairs it", async () => {
  await inWiredProject(async (registry) => {
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

    // The remedy works: with the folder gone, apply installs the skill again.
    await callMcpTool("apply_recipe", { recipe: guardRecipe(), noInstall: true }, registry);
    assert.deepEqual(await missingScriptErrors(), []);
  });
});

test("Given only the guard's script deleted from a committed skill folder, apply refuses to reinstall the skill, and doctor's remedy restores the script from Git", async () => {
  await inWiredProject(async (registry) => {
    git(["add", "--all"]);
    // The identity and signing settings are fixed here, so the commit does not depend on the
    // machine's global Git configuration.
    git([
      "-c",
      "user.name=Calavera",
      "-c",
      "user.email=calavera@example.com",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "--message=Apply the guard",
    ]);
    await rm(script);

    const errors = await missingScriptErrors();
    assert.equal(errors.length, 3);
    for (const message of errors) {
      assert.match(
        message,
        /\.agents\/skills\/protected-branch-guard is still there, so apply counts the missing file as a local edit and does not install the skill again\. Restore the script with git checkout HEAD -- \.agents\/skills\/protected-branch-guard\/scripts\/guard\.mjs, which keeps any other changes in that folder\./,
      );
    }
    // Why the remedy is not "run apply": the changed folder is a conflict.
    await assert.rejects(
      callMcpTool("apply_recipe", { recipe: guardRecipe(), noInstall: true }, registry),
      /Refusing to overwrite existing AI artifact: \.agents\/skills\/protected-branch-guard\. It appears to have local edits/,
    );

    git(["checkout", "HEAD", "--", script]);
    assert.deepEqual(await missingScriptErrors(), []);
  });
});

test("Given only the guard's script deleted from a skill folder that was never committed, doctor's other remedy deletes the folder so apply installs the skill again", async () => {
  await inWiredProject(async (registry) => {
    await rm(script);

    for (const message of await missingScriptErrors()) {
      assert.match(
        message,
        /If the script was never committed, delete \.agents\/skills\/protected-branch-guard and run create-project-calavera apply to install the skill again; that discards any other changes in that folder\./,
      );
    }

    await rm(skillDirectory, { recursive: true });
    await callMcpTool("apply_recipe", { recipe: guardRecipe(), noInstall: true }, registry);
    assert.deepEqual(await missingScriptErrors(), []);
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

/** @param {object} recipe */
async function writeConfig(recipe) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
}

/**
 * Runs `clean` in the current directory, without a terminal, and returns what it printed.
 *
 * @param {string[]} args
 */
function runClean(args) {
  return spawnSync(process.execPath, [cli, "clean", ...args], {
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/** @param {string[]} args */
function cleanJson(args) {
  const { status, stdout, stderr } = runClean([...args, "--json"]);
  assert.equal(status, 0, stderr);
  return JSON.parse(stdout);
}

/** @param {string} path */
async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

const wiringPaths = [...hooks.map((hook) => `.vite-hooks/${hook}`), ".claude/settings.json"];

test("Given the guard applied and wired, when the recipe drops it and clean --dry-run runs before apply, then it lists the removal of each unchanged block and group with the skill directory, and writes nothing", async () => {
  await inWiredProject(async () => {
    await writeConfig(deselectedRecipe());
    const before = await snapshot();
    const result = cleanJson(["--dry-run"]);

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
    for (const path of wiringPaths) {
      assert.equal(result.changes.find((change) => change.path === path)?.type, "update", path);
    }
    assert.equal(result.changes.find((change) => change.path === skillDirectory)?.type, "delete");
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the guard deselected, clean --dry-run in a terminal says why each block and group would be removed", async () => {
  await inWiredProject(async () => {
    await writeConfig(deselectedRecipe());
    const { status, stdout, stderr } = runClean(["--dry-run"]);
    assert.equal(status, 0, stderr);

    for (const hook of hooks) {
      assert.match(
        stdout,
        new RegExp(
          `Would remove the ${id} block from \\.vite-hooks/${hook}, because the recipe no longer selects ${id}`,
        ),
      );
    }
    for (const event of ["SessionStart", "PreToolUse"]) {
      assert.match(
        stdout,
        new RegExp(
          `Would remove the ${event} group for ${id} from \\.claude/settings\\.json, because the recipe no longer selects ${id}`,
        ),
      );
    }
    assert.match(stdout, /Would remove \.agents\/skills\/protected-branch-guard/);
  });
});

test("Given the guard deselected, when clean runs before apply, then the hooks it wired still run, the person's own lines remain byte-for-byte, and the skill directory and its records are gone", async () => {
  await inWiredProject(async () => {
    await writeConfig(deselectedRecipe());
    const { status, stdout, stderr } = runClean(["--yes"]);
    assert.equal(status, 0, stderr);
    assert.match(stdout, /Removed \.agents\/skills\/protected-branch-guard/);
    for (const path of wiringPaths) {
      assert.match(
        stdout,
        new RegExp(`Removed the ${id} wiring from ${path.replaceAll(".", "\\.")}`),
      );
    }

    assert.equal(await exists(skillDirectory), false);
    assert.equal(await readFile(".vite-hooks/pre-commit", "utf8"), ownPreCommit);
    assert.equal(await readFile(".claude/settings.json", "utf8"), ownSettings);
    // The Vite+ dispatcher runs each hook script with sh -e, so a block whose script is gone
    // would stop every commit and push.
    for (const hook of ["prepare-commit-msg", "pre-push"]) {
      const run = spawnSync("sh", ["-e", `.vite-hooks/${hook}`], { encoding: "utf8" });
      assert.equal(run.status, 0, `${hook}: ${run.stderr}`);
    }
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.aiWiring, []);
    assert.deepEqual(
      state.aiArtifacts.filter(({ source }) => source === id),
      [],
    );

    const again = cleanJson(["--dry-run"]);
    assert.deepEqual(again.changes, []);
    assert.deepEqual(again.wiringChanges, []);
  });
});

test("Given the guard deselected and one character edited inside a guard block, clean and its dry run stop with a conflict naming the file, and nothing is written or deleted", async () => {
  await inWiredProject(async () => {
    await writeConfig(deselectedRecipe());
    await writeFile(
      ".vite-hooks/pre-push",
      (await readFile(".vite-hooks/pre-push", "utf8")).replace("pre-push main", "pre-push mainx"),
    );
    const before = await snapshot();

    for (const args of [["--dry-run"], ["--yes"]]) {
      const { status, stderr } = runClean(args);
      assert.notEqual(status, 0, args.join(" "));
      assert.match(
        stderr,
        /\.vite-hooks\/pre-push: the recipe no longer selects skill-protected-branch-guard, so Calavera would remove its block, but the block was edited since Calavera wrote it/,
      );
    }
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the guard deselected and an edited guard group, clean stops with a conflict naming the file, and nothing is written or deleted", async () => {
  await inWiredProject(async () => {
    await writeConfig(deselectedRecipe());
    const settings = JSON.parse(await readFile(".claude/settings.json", "utf8"));
    settings.hooks.SessionStart[0].hooks[0].timeout = 11;
    await writeFile(".claude/settings.json", `${JSON.stringify(settings, null, 2)}\n`);
    const before = await snapshot();

    const { status, stderr } = runClean(["--yes"]);
    assert.notEqual(status, 0);
    assert.match(
      stderr,
      /\.claude\/settings\.json: hooks\.SessionStart holds a group that runs \.agents\/skills\/protected-branch-guard\/ and was edited since Calavera wrote it/,
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the guard still selected, clean plans no change to its wiring or its skill directory", async () => {
  await inWiredProject(async () => {
    await writeConfig(guardRecipe());
    const result = cleanJson(["--dry-run"]);

    assert.deepEqual(result.wiringChanges, []);
    assert.deepEqual(
      result.changes.filter(({ path }) => [...wiringPaths, skillDirectory].includes(path)),
      [],
    );
  });
});

// The decision #829 asks for: an apply that deselects an artifact removes its wiring but keeps its
// skill directory, and keeps the record of what it installed there, so `clean` can tell an
// unedited directory, which it removes, from an edited one, which it keeps and reports.
test("Given an apply that deselected the guard, the state keeps its installed directory, and a later clean removes the unedited directory", async () => {
  await inWiredProject(async (registry) => {
    await writeConfig(deselectedRecipe());
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);

    assert.equal(await exists(skillDirectory), true);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(
      state.aiArtifacts.filter(({ source }) => source === id).map(({ path }) => path),
      [skillDirectory],
    );

    const dryRun = cleanJson(["--dry-run"]);
    assert.deepEqual(
      dryRun.changes.map(({ type, path }) => [type, path]),
      [["delete", skillDirectory]],
    );

    const { status, stderr } = runClean(["--yes"]);
    assert.equal(status, 0, stderr);
    assert.equal(await exists(skillDirectory), false);
    const after = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(
      after.aiArtifacts.filter(({ source }) => source === id),
      [],
    );
  });
});

test("Given an apply that deselected the guard and an edit inside its skill directory, clean keeps the directory and reports the local edit", async () => {
  await inWiredProject(async (registry) => {
    await writeConfig(deselectedRecipe());
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);
    const skillFile = `${skillDirectory}/SKILL.md`;
    await writeFile(skillFile, `${await readFile(skillFile, "utf8")}\nMy own note.\n`);
    const before = await snapshot();

    const result = cleanJson(["--yes"]);
    assert.deepEqual(
      result.changes.map(({ type, path }) => [type, path]),
      [["skip", skillDirectory]],
    );
    assert.match(result.changes[0].reason, /AI artifact has local edits/);
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given a deselected guard whose edited block the person kept by deleting its markers, clean keeps the skill directory that block still runs and says why", async () => {
  await inWiredProject(async (registry) => {
    await writeConfig(deselectedRecipe());
    const edited = (await readFile(".vite-hooks/pre-push", "utf8")).replace(
      "pre-push main",
      "pre-push mainx",
    );
    // The remedy the conflict names: delete the markers to keep the block as the person's own.
    await writeFile(".vite-hooks/pre-push", edited.replace(/^# calavera:.*\n/gm, ""));
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);
    const before = await snapshot();

    const result = cleanJson(["--yes"]);
    const skip = result.changes.find(({ path }) => path === skillDirectory);
    assert.equal(skip?.type, "skip");
    assert.match(
      skip.reason,
      /\.vite-hooks\/pre-push still mentions \.agents\/skills\/protected-branch-guard after clean/,
    );
    assert.equal(await exists(skillDirectory), true);
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given the guard deselected and its skill directory edited, clean removes the wiring, keeps the directory, and keeps reporting it on the next run", async () => {
  await inWiredProject(async () => {
    await writeConfig(deselectedRecipe());
    const skillFile = `${skillDirectory}/SKILL.md`;
    await writeFile(skillFile, `${await readFile(skillFile, "utf8")}\nMy own note.\n`);

    const first = cleanJson(["--yes"]);
    assert.equal(first.wiringChanges.length, 4);
    assert.equal(first.changes.find(({ path }) => path === skillDirectory)?.type, "skip");
    assert.equal(await exists(skillDirectory), true);

    const again = cleanJson(["--dry-run"]);
    assert.deepEqual(
      again.changes.map(({ type, path }) => [type, path]),
      [["skip", skillDirectory]],
    );
  });
});

// Greptile review of #856: a hook script that the person keeps through a symbolic link still runs
// with sh -e, so clean must read it through the link before it deletes the skill directory.
test("Given a deselected guard whose script a symbolically linked hook still runs, clean keeps the skill directory and names the link", async () => {
  await inWiredProject(async (registry) => {
    await writeConfig(deselectedRecipe());
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);
    await mkdir("scripts");
    await writeFile("scripts/post-merge.sh", `#!/bin/sh\n${line("pre-push")}\n`);
    await symlink("../scripts/post-merge.sh", ".vite-hooks/post-merge");
    const before = await snapshot();

    const result = cleanJson(["--yes"]);
    const skip = result.changes.find(({ path }) => path === skillDirectory);
    assert.equal(skip?.type, "skip");
    assert.match(
      skip.reason,
      /\.vite-hooks\/post-merge still mentions \.agents\/skills\/protected-branch-guard after clean/,
    );
    assert.equal(await exists(script), true);
    assert.deepEqual(await snapshot(), before);
  });
});

test("Given a deselected guard and a hook that is a broken symbolic link, clean keeps the skill directory, because it cannot read what the link would run", async () => {
  await inWiredProject(async (registry) => {
    await writeConfig(deselectedRecipe());
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);
    await symlink("../scripts/missing.sh", ".vite-hooks/post-merge");
    const before = await snapshot();

    const result = cleanJson(["--yes"]);
    const skip = result.changes.find(({ path }) => path === skillDirectory);
    assert.equal(skip?.type, "skip");
    assert.match(
      skip.reason,
      /\.vite-hooks\/post-merge is a symbolic link that Calavera cannot follow, so it cannot tell whether it runs \.agents\/skills\/protected-branch-guard/,
    );
    assert.equal(await exists(script), true);
    assert.deepEqual(await snapshot(), before);
  });
});

const hookId = "hook-block-dangerous-commands";
const hookScript = ".agents/hooks/claude-code/block-dangerous-commands.mjs";
const hookFragment = ".agents/hooks/claude-code/block-dangerous-commands.settings-fragment.json";

/**
 * Runs `callback` in a new project where block-dangerous-commands was applied, then deselected
 * by a second apply, which keeps the record of the installed hook script.
 *
 * @param {() => Promise<void>} callback
 */
async function inProjectWithDeselectedHook(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-deselected-hook-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    git(["init", "--quiet", "--initial-branch=main"]);
    git(["switch", "--quiet", "-c", "856-deselect-hook"]);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    const registry = stubRegistry(new Map([[hookId, "0.4.0"]]));
    const hookRecipe = { ...buildRecipe("minimal", [], "npm"), ai: [{ id: hookId }] };
    await callMcpTool("apply_recipe", { recipe: hookRecipe, noInstall: true }, registry);
    assert.equal(await exists(hookScript), true);
    await writeConfig(deselectedRecipe());
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

// Greptile review of #856: a hook artifact is a file, not a directory. When the person runs it from
// .claude/settings.json, as its README documents, clean must not delete it.
test("Given an apply that deselected block-dangerous-commands while .claude/settings.json still runs it, clean keeps the hook script and names the settings file", async () => {
  await inProjectWithDeselectedHook(async () => {
    await mkdir(".claude", { recursive: true });
    await writeFile(
      ".claude/settings.json",
      `${JSON.stringify(
        {
          hooks: {
            PreToolUse: [
              { matcher: "Bash", hooks: [{ type: "command", command: `node ${hookScript}` }] },
            ],
          },
        },
        null,
        2,
      )}\n`,
    );
    const script = await readFile(hookScript, "utf8");
    const settings = await readFile(".claude/settings.json", "utf8");

    const result = cleanJson(["--yes"]);
    const skip = result.changes.find(({ path }) => path === hookScript);
    assert.equal(skip?.type, "skip");
    assert.match(
      skip.reason,
      /\.claude\/settings\.json still mentions \.agents\/hooks\/claude-code\/block-dangerous-commands\.mjs after clean/,
    );
    assert.equal(await readFile(hookScript, "utf8"), script);
    assert.equal(await readFile(".claude/settings.json", "utf8"), settings);
    // The settings fragment is recorded on its own, and nothing runs it: it is the text a person
    // copies into their settings. So clean still removes it when it is unedited.
    assert.equal(result.changes.find(({ path }) => path === hookFragment)?.type, "delete");
  });
});

test("Given an apply that deselected block-dangerous-commands and nothing that runs it, clean removes the unedited hook script", async () => {
  await inProjectWithDeselectedHook(async () => {
    const result = cleanJson(["--yes"]);
    assert.equal(result.changes.find(({ path }) => path === hookScript)?.type, "delete");
    assert.equal(await exists(hookScript), false);
  });
});

// Owner decision on #856: when clean keeps stale items, its summary says why for each reason and
// what the person can do, and the JSON output tells the reasons apart with `skipReasons`.
test("Given an apply that deselected the guard, clean names each reason it keeps the skill directory, with the action, in its summary and in JSON", async () => {
  await inWiredProject(async (registry) => {
    await writeConfig(deselectedRecipe());
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);

    const keptFor = () => {
      const result = cleanJson(["--dry-run"]);
      const skip = result.changes.find(({ path }) => path === skillDirectory);
      return { message: result.message, reason: skip?.reason, skipReasons: skip?.skipReasons };
    };

    // Still mentioned by a hook script.
    await writeFile(".vite-hooks/post-merge", `${line("pre-push")}\n`);
    assert.deepEqual(keptFor(), {
      message: `No stale managed items were safe to remove. Kept ${skillDirectory}, because a hook script or Claude Code settings file still mentions it. Remove the lines or groups that run them from the files each item's reason names, then run clean again.`,
      reason: `.vite-hooks/post-merge still mentions ${skillDirectory} after clean, so deleting it would break what runs there. Remove those lines or groups, then run clean again.`,
      skipReasons: ["still-mentioned"],
    });
    await rm(".vite-hooks/post-merge");

    // A link that cannot be followed.
    await symlink("../scripts/missing.sh", ".vite-hooks/post-merge");
    assert.deepEqual(keptFor(), {
      message: `No stale managed items were safe to remove. Kept ${skillDirectory}, because a hook is a symbolic link that Calavera cannot follow. Repair or remove the links each item's reason names, then run clean again.`,
      reason: `.vite-hooks/post-merge is a symbolic link that Calavera cannot follow, so it cannot tell whether it runs ${skillDirectory}. Repair or remove that link, then run clean again.`,
      skipReasons: ["unfollowable-link"],
    });
    await rm(".vite-hooks/post-merge");

    // A file Calavera cannot read.
    await writeFile(".vite-hooks/post-merge", "vp install\n");
    await chmod(".vite-hooks/post-merge", 0o000);
    try {
      assert.deepEqual(keptFor(), {
        message: `No stale managed items were safe to remove. Kept ${skillDirectory}, because Calavera cannot read a hook script or settings file that may run it. Make the files each item's reason names readable, then run clean again.`,
        reason: `Calavera cannot read .vite-hooks/post-merge (EACCES), so it cannot tell whether it runs ${skillDirectory}. Make that file readable, then run clean again.`,
        skipReasons: ["unreadable"],
      });
    } finally {
      await chmod(".vite-hooks/post-merge", 0o644);
    }
    await rm(".vite-hooks/post-merge");

    // Local edits.
    const skillFile = `${skillDirectory}/SKILL.md`;
    await writeFile(skillFile, `${await readFile(skillFile, "utf8")}\nMy own note.\n`);
    const edited = keptFor();
    assert.equal(
      edited.message,
      `No stale managed items were safe to remove. Kept ${skillDirectory}, because it has local edits. Clean keeps your version. To have clean remove an item, restore the content Calavera wrote, or delete the item yourself.`,
    );
    assert.match(
      edited.reason ?? "",
      /^AI artifact has local edits \(installed=[^,]+, state=[^)]+\)\. Clean keeps your version\. To have clean remove it, restore the content Calavera wrote, or delete it yourself\.$/,
    );
    assert.deepEqual(edited.skipReasons, ["local-edits"]);
  });
});

test("Given a guard kept for two reasons and another item kept for a third, clean lists every reason, and each item keeps all of its reasons", async () => {
  await inWiredProject(async (registry) => {
    await writeConfig(deselectedRecipe());
    await callMcpTool("apply_recipe", { recipe: deselectedRecipe(), noInstall: true }, registry);
    await writeFile(".vite-hooks/post-merge", `${line("pre-push")}\n`);
    await symlink("../scripts/missing.sh", ".vite-hooks/post-checkout");

    const result = cleanJson(["--yes"]);
    const skip = result.changes.find(({ path }) => path === skillDirectory);
    assert.deepEqual(skip?.skipReasons, ["still-mentioned", "unfollowable-link"]);
    assert.match(
      result.message,
      /because a hook script or Claude Code settings file still mentions it\./,
    );
    assert.match(result.message, /because a hook is a symbolic link that Calavera cannot follow\./);
    assert.equal(await exists(script), true);
  });
});
