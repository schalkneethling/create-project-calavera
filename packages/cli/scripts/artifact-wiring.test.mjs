import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import {
  artifactWiringFindings,
  artifactWiringWarnings,
  installedSkillDirectory,
  planArtifactWiring,
  wiringFilesThatMention,
  writeArtifactWiring,
} from "../src/ai/artifact-wiring.js";
import { normalizeState } from "../src/state.js";
import { loadProjectFormatter } from "../src/utils/project-formatter.js";
import { createTemporaryFixture } from "./vite-plus-fixtures.mjs";

const id = "skill-protected-branch-guard";
const skillDirectory = ".agents/skills/protected-branch-guard";
const payloadDirectory = fileURLToPath(
  new URL(
    "../../artifacts/skill-protected-branch-guard/payload/protected-branch-guard/",
    import.meta.url,
  ),
);
const guard = { id, index: 0, skillDirectory, payloadDirectory };
const recipeFor = (branch = "main") => ({ ai: [{ id, inputs: { protectedBranch: branch } }] });
const line = (mode, branch = "main") =>
  `node ${skillDirectory}/scripts/guard.mjs ${mode} ${branch}`;
const block = (mode, branch = "main") =>
  `# calavera:${id}:start\n${line(mode, branch)}\n# calavera:${id}:end\n`;

/** A formatter that keeps the text, as in a project without Vite+, and counts its loads. */
function countingFormatter() {
  const loads = { count: 0 };
  return {
    loads,
    loadFormatter: async () => {
      loads.count += 1;
      return loadProjectFormatter(process.cwd(), "unmanaged");
    },
  };
}

/** @param {string} root @param {Partial<Parameters<typeof planArtifactWiring>[0]>} [options] */
function plan(root, options = {}) {
  return planArtifactWiring({
    recipe: recipeFor(),
    artifacts: [guard],
    previousRecords: [],
    loadFormatter: countingFormatter().loadFormatter,
    cwd: root,
    ...options,
  });
}

/** @param {string} root @param {string[]} args */
function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

test("Given the scaffold's pre-commit, when the guard is planned, then apply writes its three blocks and its Claude Code groups and records them", async () => {
  await using project = await createTemporaryFixture("wiring-fresh", {
    ".vite-hooks/pre-commit": "vp staged\n",
  });
  const result = await plan(project.root);

  assert.deepEqual(
    result.files.map(({ path, type }) => [path, type]),
    [
      [".vite-hooks/pre-commit", "update"],
      [".vite-hooks/prepare-commit-msg", "write"],
      [".vite-hooks/pre-push", "write"],
      [".claude/settings.json", "write"],
    ],
  );
  const contents = Object.fromEntries(result.files.map((file) => [file.path, file.contents]));
  assert.equal(contents[".vite-hooks/pre-commit"], `${block("commit")}vp staged\n`);
  assert.equal(contents[".vite-hooks/prepare-commit-msg"], block("commit"));
  assert.equal(contents[".vite-hooks/pre-push"], block("pre-push"));
  const settings = JSON.parse(contents[".claude/settings.json"]);
  assert.equal(
    settings.hooks.PreToolUse[0].hooks[0].command,
    `node "$CLAUDE_PROJECT_DIR/${skillDirectory}/scripts/guard.mjs" claude-pre-tool-use main`,
  );
  assert.deepEqual(result.records, [
    {
      artifact: id,
      viteHooks: {
        "pre-commit": line("commit"),
        "prepare-commit-msg": line("commit"),
        "pre-push": line("pre-push"),
      },
      claudeCode: settings.hooks,
    },
  ]);
  // The dry run shows each block and each group, not only the file names.
  assert.deepEqual(
    result.changes.filter(({ kind }) => kind === "vite-hook").map(({ block: text }) => text),
    [line("commit"), line("commit"), line("pre-push")],
  );
  const groupChanges = result.changes.find(({ kind }) => kind === "claude-settings")?.groupChanges;
  assert.deepEqual(
    groupChanges?.map(({ event, action }) => [event, action]),
    [
      ["SessionStart", "add"],
      ["PreToolUse", "add"],
    ],
  );
});

test("Given the wiring apply wrote and recorded, when nothing changed, then every file is unchanged", async () => {
  await using project = await createTemporaryFixture("wiring-unchanged", {
    ".vite-hooks/pre-commit": "vp staged\n",
  });
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);

  const second = await plan(project.root, { previousRecords: first.records });
  assert.deepEqual(
    second.files.map(({ type }) => type),
    ["unchanged", "unchanged", "unchanged", "unchanged"],
  );
  assert.deepEqual(second.records, first.records);
});

test("Given a recorded branch, when the recipe names another, then apply replaces only its own blocks and groups", async () => {
  await using project = await createTemporaryFixture("wiring-branch", {
    ".vite-hooks/pre-commit": "#!/bin/sh\necho mine\nvp staged\n",
  });
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);

  const trunk = await plan(project.root, {
    recipe: recipeFor("trunk"),
    previousRecords: first.records,
  });
  assert.deepEqual(
    trunk.files.map(({ type }) => type),
    ["update", "update", "update", "update"],
  );
  assert.equal(
    trunk.files[0]?.contents,
    `#!/bin/sh\n${block("commit", "trunk")}echo mine\nvp staged\n`,
  );
});

test("Given edited wiring, when apply plans, then it stops with every conflict and writes nothing", async () => {
  await using project = await createTemporaryFixture("wiring-conflict", {});
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);
  const prePush = join(project.root, ".vite-hooks/pre-push");
  await writeFile(prePush, (await readFile(prePush, "utf8")).replace("main", "main # mine"));
  const settingsPath = join(project.root, ".claude/settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  settings.hooks.PreToolUse[0].matcher = "Write";
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  await assert.rejects(plan(project.root, { previousRecords: first.records }), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /^Calavera stopped before writing anything/);
    assert.match(error.message, /\n- \.vite-hooks\/pre-push: the Calavera block for .* was edited/);
    assert.match(error.message, /\n- \.claude\/settings\.json: hooks\.PreToolUse holds a group/);
    return true;
  });
});

test("An artifact without wiring plans no files and never loads the formatter", async () => {
  await using project = await createTemporaryFixture("wiring-none", {});
  const { loads, loadFormatter } = countingFormatter();
  const result = await plan(project.root, {
    recipe: { ai: [{ id: "skill-project-goal" }] },
    artifacts: [{ ...guard, id: "skill-project-goal", skillDirectory: ".agents/skills/x" }],
    loadFormatter,
  });
  assert.deepEqual(result, { files: [], changes: [], records: [] });
  assert.equal(loads.count, 0);
});

test("A recipe without the guard's input value is a diagnosable error, not a guess", async () => {
  await using project = await createTemporaryFixture("wiring-no-input", {});
  await assert.rejects(
    plan(project.root, { recipe: { ai: [{ id }] } }),
    /\{\{protectedBranch\}\} has no recorded value; no inputs are recorded for this artifact/,
  );
});

test("Two artifacts wiring the same hook are planned one after the other, each in its own block", async () => {
  await using project = await createTemporaryFixture("wiring-two", {});
  const other = {
    viteHooks: { "pre-commit": "node .agents/skills/other/run.mjs {{protectedBranch}}" },
  };
  const result = await plan(project.root, {
    recipe: { ai: [...recipeFor().ai, { id: "skill-other", inputs: { protectedBranch: "dev" } }] },
    artifacts: [
      guard,
      { id: "skill-other", index: 1, skillDirectory: ".agents/skills/other", payloadDirectory },
    ],
    wiringFor: (artifactId) =>
      artifactId === "skill-other"
        ? other
        : {
            viteHooks: {
              "pre-commit": `node ${skillDirectory}/scripts/guard.mjs commit {{protectedBranch}}`,
            },
          },
  });
  assert.deepEqual(
    result.files.map(({ path, type }) => [path, type]),
    [[".vite-hooks/pre-commit", "write"]],
  );
  assert.equal(
    result.files[0]?.contents,
    `# calavera:skill-other:start\nnode .agents/skills/other/run.mjs dev\n# calavera:skill-other:end\n${block("commit")}`,
  );
});

test("writeArtifactWiring writes only the files that change", async () => {
  await using project = await createTemporaryFixture("wiring-write", {});
  await writeArtifactWiring(
    [
      { path: ".vite-hooks/pre-push", type: "write", contents: "new\n" },
      { path: "kept.txt", type: "unchanged", contents: "ignored\n" },
    ],
    project.root,
  );
  assert.equal(await readFile(join(project.root, ".vite-hooks/pre-push"), "utf8"), "new\n");
  await assert.rejects(readFile(join(project.root, "kept.txt")), { code: "ENOENT" });
});

test("The hooks warning names the remedy that fits the clone: vp config, vp hooks enable, or the other hooks path", async () => {
  await using project = await createTemporaryFixture("wiring-warnings", {});
  const warnings = (status = "managed") =>
    artifactWiringWarnings({
      recipe: recipeFor("release"),
      vitePlusStatus: status,
      cwd: project.root,
    });

  const notRepository = await warnings();
  assert.match(notRepository.join("\n"), /is not a Git repository/);

  git(project.root, ["init", "--quiet", "--initial-branch=main"]);
  assert.match(
    (await warnings()).join("\n"),
    /The Vite\+ hook dispatcher is not installed in this clone, so Git runs none of the scripts in \.vite-hooks, and the hooks skill-protected-branch-guard wires there will not run\. Run vp config to install it\./,
  );

  git(project.root, ["config", "core.hooksPath", ".husky"]);
  assert.match(
    (await warnings()).join("\n"),
    /core\.hooksPath is \.husky, so Git runs hooks from there.*vp config leaves a different hooks path alone/s,
  );

  git(project.root, ["config", "core.hooksPath", ".vite-hooks/_"]);
  await mkdir(join(project.root, ".vite-hooks/_"), { recursive: true });
  assert.deepEqual(await warnings(), []);
  // Vite+ compares resolved paths, so an absolute path to the same dispatcher is not foreign.
  git(project.root, [
    "config",
    "core.hooksPath",
    join(git(project.root, ["rev-parse", "--show-toplevel"]), ".vite-hooks/_"),
  ]);
  assert.deepEqual(await warnings(), []);

  // The same dispatcher through a symbolic link, as /var and /private/var are on macOS.
  await symlink(join(project.root, ".vite-hooks"), join(project.root, "linked-hooks"));
  git(project.root, ["config", "core.hooksPath", join(project.root, "linked-hooks/_")]);
  assert.deepEqual(await warnings(), []);
  git(project.root, ["config", "core.hooksPath", ".vite-hooks/_"]);

  git(project.root, ["config", "vp.hooks.dir", ".custom-hooks"]);
  assert.match(
    (await warnings()).join("\n"),
    /Vite\+ runs the hook scripts in \.custom-hooks in this clone \(vp\.hooks\.dir\), not the ones in \.vite-hooks.*Run vp hooks enable --hooks-dir \.vite-hooks/s,
  );
  git(project.root, ["config", "--unset", "vp.hooks.dir"]);

  git(project.root, ["config", "vp.hooks.disabled", "true"]);
  assert.match(
    (await warnings()).join("\n"),
    /Vite\+ hooks are turned off in this clone \(vp hooks disable\).*Run vp hooks enable/s,
  );

  git(project.root, ["config", "--unset", "vp.hooks.disabled"]);
  assert.match(
    (await warnings("unmanaged")).join("\n"),
    /does not use Vite\+, and only the Vite\+ hook dispatcher runs the scripts in \.vite-hooks/,
  );
});

test("Given the protected branch is the current branch, the warning says the commit of the applied files will be refused", async () => {
  await using project = await createTemporaryFixture("wiring-current-branch", {});
  git(project.root, ["init", "--quiet", "--initial-branch=main"]);
  git(project.root, ["config", "core.hooksPath", ".vite-hooks/_"]);
  await mkdir(join(project.root, ".vite-hooks/_"), { recursive: true });

  const warnings = await artifactWiringWarnings({
    recipe: recipeFor("main"),
    vitePlusStatus: "managed",
    cwd: project.root,
  });
  assert.match(
    warnings.join("\n"),
    /You are on main, the branch skill-protected-branch-guard protects \(protectedBranch\), so the guard will refuse to commit the applied files here\. Create a feature branch first, for example with git switch -c <name>, and commit there\./,
  );
});

test("Given a hook the artifact no longer wires, when apply plans, then its unchanged block is removed and an edited one is a conflict", async () => {
  await using project = await createTemporaryFixture("wiring-dropped-hook", {});
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);
  const guardWiring = /** @type {any} */ ({
    ...artifactForId(id)?.wiring,
    viteHooks: {
      "pre-commit": `node ${skillDirectory}/scripts/guard.mjs commit {{protectedBranch}}`,
    },
  });

  const shrunk = await plan(project.root, {
    previousRecords: first.records,
    wiringFor: () => guardWiring,
  });
  assert.deepEqual(
    shrunk.files.map(({ path, type, contents }) => [path, type, contents]),
    [
      [".vite-hooks/prepare-commit-msg", "update", ""],
      [".vite-hooks/pre-push", "update", ""],
      [".vite-hooks/pre-commit", "unchanged", block("commit")],
      [
        ".claude/settings.json",
        "unchanged",
        await readFile(join(project.root, ".claude/settings.json"), "utf8"),
      ],
    ],
  );
  assert.deepEqual(
    shrunk.changes
      .filter(({ removedBlock }) => removedBlock)
      .map(({ path, removedBlock }) => [path, removedBlock]),
    [
      [".vite-hooks/prepare-commit-msg", line("commit")],
      [".vite-hooks/pre-push", line("pre-push")],
    ],
  );
  assert.deepEqual(shrunk.records[0]?.viteHooks, { "pre-commit": line("commit") });

  const prePush = join(project.root, ".vite-hooks/pre-push");
  await writeFile(prePush, (await readFile(prePush, "utf8")).replace("main", "main # mine"));
  await assert.rejects(
    plan(project.root, { previousRecords: first.records, wiringFor: () => guardWiring }),
    /\.vite-hooks\/pre-push: skill-protected-branch-guard no longer wires this hook/,
  );
});

test("Given Claude Code wiring the artifact no longer declares, when apply plans, then its unchanged groups are removed and an edited one is a conflict", async () => {
  await using project = await createTemporaryFixture("wiring-dropped-claude-code", {});
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);
  const settingsPath = join(project.root, ".claude/settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  await writeFile(settingsPath, JSON.stringify({ ...settings, model: "mine" }, null, 2));
  const hooksOnly = /** @type {any} */ ({
    viteHooks: {
      "pre-commit": `node ${skillDirectory}/scripts/guard.mjs commit {{protectedBranch}}`,
      "prepare-commit-msg": `node ${skillDirectory}/scripts/guard.mjs commit {{protectedBranch}}`,
      "pre-push": `node ${skillDirectory}/scripts/guard.mjs pre-push {{protectedBranch}}`,
    },
  });

  const dropped = await plan(project.root, {
    previousRecords: first.records,
    wiringFor: () => hooksOnly,
  });
  const settingsFile = dropped.files.find(({ path }) => path === ".claude/settings.json");
  assert.equal(settingsFile?.type, "update");
  // The groups go, and the user's own setting stays.
  assert.deepEqual(JSON.parse(settingsFile?.contents ?? ""), { model: "mine" });
  assert.deepEqual(
    dropped.changes
      .find(({ kind }) => kind === "claude-settings")
      ?.groupChanges?.map(({ event, action }) => [event, action]),
    [
      ["SessionStart", "remove"],
      ["PreToolUse", "remove"],
    ],
  );
  assert.equal(Object.hasOwn(dropped.records[0] ?? {}, "claudeCode"), false);

  // With the groups gone and nothing recorded, a later plan leaves the file alone.
  await writeArtifactWiring(dropped.files, project.root);
  const again = await plan(project.root, {
    previousRecords: dropped.records,
    wiringFor: () => hooksOnly,
  });
  assert.equal(
    again.files.some(({ path }) => path === ".claude/settings.json"),
    false,
  );

  const edited = { ...settings };
  edited.hooks.PreToolUse[0].matcher = "Write";
  await writeFile(settingsPath, JSON.stringify(edited, null, 2));
  await assert.rejects(
    plan(project.root, { previousRecords: first.records, wiringFor: () => hooksOnly }),
    /\.claude\/settings\.json: hooks\.PreToolUse holds a group that runs .* was edited since Calavera wrote it/s,
  );
});

test("Given recorded Claude Code wiring and no settings file, when the artifact no longer declares it, then apply writes no settings file", async () => {
  await using project = await createTemporaryFixture("wiring-dropped-claude-code-no-file", {});
  const first = await plan(project.root);
  await writeArtifactWiring(
    first.files.filter(({ path }) => path !== ".claude/settings.json"),
    project.root,
  );

  const dropped = await plan(project.root, {
    previousRecords: first.records,
    wiringFor: () => /** @type {any} */ ({}),
  });
  assert.equal(
    dropped.files.some(({ path }) => path === ".claude/settings.json"),
    false,
  );
  assert.equal(Object.hasOwn(dropped.records[0] ?? {}, "claudeCode"), false);
});

test("Given recorded wiring, when the catalog no longer wires the artifact at all, then apply removes its blocks and groups", async () => {
  await using project = await createTemporaryFixture("wiring-dropped-entirely", {
    ".vite-hooks/pre-commit": "vp staged\n",
  });
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);

  const dropped = await plan(project.root, {
    previousRecords: first.records,
    wiringFor: () => undefined,
  });
  assert.deepEqual(
    dropped.files.map(({ path, type, contents }) => [path, type, contents]),
    [
      [".vite-hooks/pre-commit", "update", "vp staged\n"],
      [".vite-hooks/prepare-commit-msg", "update", ""],
      [".vite-hooks/pre-push", "update", ""],
      [".claude/settings.json", "update", "{}\n"],
    ],
  );
  assert.deepEqual(dropped.records, [{ artifact: id }]);
});

test("Given an installed payload without the Claude Code fragment, when apply plans, then the error names the artifact and the remedy", async () => {
  await using project = await createTemporaryFixture("wiring-old-payload", {});
  await assert.rejects(
    plan(project.root, { artifacts: [{ ...guard, payloadDirectory: project.root }] }),
    /skill-protected-branch-guard wires Claude Code with hooks\/claude-code\.settings\.json, but the installed payload in .* has no such file.*Run create-project-calavera artifacts update skill-protected-branch-guard/s,
  );
});

test("Given recorded wiring of an artifact the recipe no longer selects, when apply plans, then it removes the blocks and groups and keeps no record", async () => {
  await using project = await createTemporaryFixture("wiring-deselected", {
    ".vite-hooks/pre-commit": "vp staged\n",
  });
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);

  // With no state entry for the skill, its directory comes from the catalog.
  const deselected = await plan(project.root, {
    recipe: { ai: [] },
    artifacts: [],
    previousRecords: first.records,
  });
  assert.deepEqual(
    deselected.files.map(({ path, type, contents }) => [path, type, contents]),
    [
      [".vite-hooks/pre-commit", "update", "vp staged\n"],
      [".vite-hooks/prepare-commit-msg", "update", ""],
      [".vite-hooks/pre-push", "update", ""],
      [".claude/settings.json", "update", "{}\n"],
    ],
  );
  assert.ok(deselected.changes.every((change) => change.deselected === true));
  assert.deepEqual(deselected.records, []);

  // Once the groups are gone, a deselected artifact reports no settings change.
  await writeArtifactWiring(deselected.files, project.root);
  const again = await plan(project.root, {
    recipe: { ai: [] },
    artifacts: [],
    previousRecords: first.records,
  });
  assert.deepEqual(again.changes, []);
  assert.deepEqual(again.records, []);
});

test("Given a deselected artifact that neither the state nor the catalog places, when its groups are planned, then the error names the artifact and the remedy", async () => {
  await using project = await createTemporaryFixture("wiring-deselected-unknown", {});
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);

  await assert.rejects(
    plan(project.root, {
      recipe: { ai: [] },
      artifacts: [],
      previousRecords: first.records,
      skillDirectoryFor: () => undefined,
    }),
    /neither the state record nor this version of Calavera says where skill-protected-branch-guard was installed[\s\S]*Run apply with a version of Calavera that knows skill-protected-branch-guard/,
  );
});

test("installedSkillDirectory reads the state record first, then the catalog, and knows no other artifact", () => {
  // The entries before it share either the type or the source, so only both together match.
  const installed = [
    { type: "skill", name: "y", source: "skill-project-goal", path: ".agents/skills/y", hash: "h" },
    { type: "hook", name: "z", source: id, path: ".agents/hooks/z.mjs", hash: "h" },
    { type: "skill", name: "x", source: id, path: ".agents/skills/moved", hash: "h" },
  ];
  assert.equal(installedSkillDirectory(id, /** @type {any} */ (installed)), ".agents/skills/moved");
  assert.equal(installedSkillDirectory(id, []), skillDirectory);
  assert.equal(installedSkillDirectory("hook-block-dangerous-commands", []), undefined);
  assert.equal(installedSkillDirectory("skill-unknown", []), undefined);
});

test("Given unreadable settings or a broken marker pair, doctor's wiring findings name the file and the remedy", async () => {
  await using project = await createTemporaryFixture("wiring-doctor-broken", {
    ".vite-hooks/pre-commit": "vp staged\n",
  });
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);
  await mkdir(join(project.root, skillDirectory, "scripts"), { recursive: true });
  await writeFile(join(project.root, skillDirectory, "scripts/guard.mjs"), "");
  const findings = () =>
    artifactWiringFindings({
      records: first.records,
      selected: new Set([id]),
      skillDirectoryFor: () => skillDirectory,
      cwd: project.root,
    });

  assert.deepEqual(await findings(), []);

  await writeFile(join(project.root, ".claude/settings.json"), "{");
  const prePush = join(project.root, ".vite-hooks/pre-push");
  await writeFile(prePush, (await readFile(prePush, "utf8")).replace(`# calavera:${id}:end\n`, ""));
  const messages = (await findings()).map(({ level, message }) => `${level} ${message}`);
  assert.equal(messages.length, 2);
  assert.match(
    messages[0] ?? "",
    /^warning \.vite-hooks\/pre-push: the Calavera block for skill-protected-branch-guard has a start marker without an end marker[\s\S]*run apply again/,
  );
  assert.match(
    messages[1] ?? "",
    /^warning \.claude\/settings\.json is not valid JSON .*Fix the JSON and run doctor again\./,
  );
});

test("Given a deselected artifact's wiring that is missing or edited, doctor's remedy is the apply that drops the record or the person's own removal", async () => {
  await using project = await createTemporaryFixture("wiring-doctor-deselected", {
    ".vite-hooks/pre-commit": "vp staged\n",
  });
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);
  await mkdir(join(project.root, skillDirectory, "scripts"), { recursive: true });
  await writeFile(join(project.root, skillDirectory, "scripts/guard.mjs"), "");
  await writeFile(join(project.root, ".vite-hooks/pre-commit"), "vp staged\n");
  const prePush = join(project.root, ".vite-hooks/pre-push");
  await writeFile(
    prePush,
    (await readFile(prePush, "utf8")).replace("pre-push main", "pre-push x"),
  );
  const settingsPath = join(project.root, ".claude/settings.json");
  const settings = JSON.parse(await readFile(settingsPath, "utf8"));
  delete settings.hooks.SessionStart;
  settings.hooks.PreToolUse[0].matcher = "Write";
  await writeFile(settingsPath, JSON.stringify(settings, null, 2));

  const messages = (
    await artifactWiringFindings({
      records: first.records,
      selected: new Set(),
      skillDirectoryFor: () => skillDirectory,
      cwd: project.root,
    })
  ).map(({ message }) => message);
  assert.deepEqual(
    messages.map((message) => message.split(":")[0]),
    [
      ".vite-hooks/pre-commit",
      ".vite-hooks/pre-push",
      ".claude/settings.json",
      ".claude/settings.json",
    ],
  );
  assert.match(
    messages[0] ?? "",
    /is missing, and the recipe no longer selects skill-protected-branch-guard, so nothing needs to run there\. Run create-project-calavera apply to drop the record\./,
  );
  assert.match(
    messages[1] ?? "",
    /was edited since Calavera wrote it, and the recipe no longer selects skill-protected-branch-guard, so the next apply stops with a conflict instead of removing it\. Restore it to "node \.agents\/skills\/protected-branch-guard\/scripts\/guard\.mjs pre-push main" so apply removes it/,
  );
  assert.match(
    messages[2] ?? "",
    /the SessionStart group for skill-protected-branch-guard that Calavera recorded is missing, and the recipe no longer selects/,
  );
  assert.match(
    messages[3] ?? "",
    /a PreToolUse group that runs \.agents\/skills\/protected-branch-guard\/ was edited since Calavera wrote it, and the recipe no longer selects .* so apply removes it, or remove that group yourself/,
  );
});

test("A recorded hook name that would leave .vite-hooks is a damaged state record, so neither apply nor doctor reaches the file", () => {
  assert.throws(
    () =>
      normalizeState({
        aiWiring: [{ artifact: "evil", viteHooks: { "../outside/victim": "node x.mjs" } }],
      }),
    /Calavera state contains invalid aiWiring entries\./,
  );
  assert.deepEqual(
    normalizeState({ aiWiring: [{ artifact: id, viteHooks: { "pre-push": line("pre-push") } }] })
      .aiWiring,
    [{ artifact: id, viteHooks: { "pre-push": line("pre-push") } }],
  );
});

test("Given a hand-edited record whose command leaves the skill directory, doctor reports the damaged record instead of checking that path", async () => {
  const tampered = `node ../outside/x.mjs main`;
  await using project = await createTemporaryFixture("wiring-doctor-tampered", {
    ".vite-hooks/pre-push": `# calavera:${id}:start\n${tampered}\n# calavera:${id}:end\n`,
  });
  const findings = await artifactWiringFindings({
    records: [{ artifact: id, viteHooks: { "pre-push": tampered } }],
    selected: new Set([id]),
    skillDirectoryFor: () => skillDirectory,
    cwd: project.root,
  });
  assert.deepEqual(
    findings.map(({ level }) => level),
    ["warning"],
  );
  assert.match(
    findings[0]?.message ?? "",
    /^\.vite-hooks\/pre-push: the skill-protected-branch-guard block holds what Calavera recorded, but the record is not a command Calavera writes: .*must start with "node \.agents\/skills\/protected-branch-guard\/"/,
  );
});

test("Given intact blocks whose script is missing, doctor reports an error per block, and the remedy follows the selection", async () => {
  await using project = await createTemporaryFixture("wiring-doctor-missing-script", {
    ".vite-hooks/pre-commit": "vp staged\n",
  });
  const first = await plan(project.root);
  await writeArtifactWiring(first.files, project.root);
  const findings = (/** @type {Set<string>} */ selected) =>
    artifactWiringFindings({
      records: [{ artifact: id, viteHooks: first.records[0]?.viteHooks }],
      selected,
      skillDirectoryFor: () => skillDirectory,
      cwd: project.root,
    });

  const selectedFindings = await findings(new Set([id]));
  assert.deepEqual(
    selectedFindings.map(({ level, message }) => [level, message.split(":")[0]]),
    [
      ["error", ".vite-hooks/pre-commit"],
      ["error", ".vite-hooks/prepare-commit-msg"],
      ["error", ".vite-hooks/pre-push"],
    ],
  );
  assert.match(
    selectedFindings[2]?.message ?? "",
    /runs \.agents\/skills\/protected-branch-guard\/scripts\/guard\.mjs, which does not exist, so the pre-push hook fails and Git refuses every push\. Run create-project-calavera apply to install the skill again\./,
  );
  assert.match(
    (await findings(new Set()))[0]?.message ?? "",
    /so the pre-commit hook fails and Git refuses every commit\. Because the recipe no longer selects skill-protected-branch-guard, create-project-calavera apply removes the block/,
  );

  await mkdir(join(project.root, skillDirectory, "scripts"), { recursive: true });
  await writeFile(join(project.root, skillDirectory, "scripts/guard.mjs"), "");
  assert.deepEqual(await findings(new Set([id])), []);
});

// #829: clean keeps an artifact that a hook script or the settings file still mentions.
test("wiringFilesThatMention lists, in order, each hook script and the settings file that mention the directory, read as the planned wiring leaves them", async () => {
  await using project = await createTemporaryFixture("wiring-mentions", {
    ".vite-hooks/pre-push": `node ${skillDirectory}/scripts/guard.mjs pre-push main\n`,
    ".vite-hooks/commit-msg": `node ${skillDirectory}/scripts/guard.mjs commit main\n`,
    ".vite-hooks/pre-commit": "vp staged\n",
    ".vite-hooks/post-merge": `node ${skillDirectory}-extra/run.mjs\n`,
    ".vite-hooks/_/pre-push": `node ${skillDirectory}/scripts/guard.mjs\n`,
    ".claude/settings.json": JSON.stringify({ command: `node ${skillDirectory}/x.mjs` }),
  });

  assert.deepEqual(await wiringFilesThatMention(skillDirectory, [], project.root), [
    ".vite-hooks/commit-msg",
    ".vite-hooks/pre-push",
    ".claude/settings.json",
  ]);
  // A planned file counts as the text it will hold, whether that removes a mention or adds one.
  assert.deepEqual(
    await wiringFilesThatMention(
      skillDirectory,
      [
        { path: ".vite-hooks/commit-msg", type: "update", contents: "" },
        { path: ".vite-hooks/pre-commit", type: "update", contents: `${skillDirectory}/a\n` },
      ],
      project.root,
    ),
    [".vite-hooks/pre-commit", ".vite-hooks/pre-push", ".claude/settings.json"],
  );
});

test("wiringFilesThatMention reads only the settings file when .vite-hooks is missing, and reports other read errors", async () => {
  await using bare = await createTemporaryFixture("wiring-mentions-bare", {
    ".claude/settings.json": `"${skillDirectory}/x.mjs"`,
  });
  assert.deepEqual(await wiringFilesThatMention(skillDirectory, [], bare.root), [
    ".claude/settings.json",
  ]);

  await using empty = await createTemporaryFixture("wiring-mentions-empty", {});
  assert.deepEqual(await wiringFilesThatMention(skillDirectory, [], empty.root), []);

  await using broken = await createTemporaryFixture("wiring-mentions-broken", {
    ".vite-hooks": "not a directory\n",
  });
  await assert.rejects(wiringFilesThatMention(skillDirectory, [], broken.root), {
    code: "ENOTDIR",
  });
});
