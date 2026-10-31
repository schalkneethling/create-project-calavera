import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  artifactWiringWarnings,
  planArtifactWiring,
  writeArtifactWiring,
} from "../src/ai/artifact-wiring.js";
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

test("Given an installed payload without the Claude Code fragment, when apply plans, then the error names the artifact and the remedy", async () => {
  await using project = await createTemporaryFixture("wiring-old-payload", {});
  await assert.rejects(
    plan(project.root, { artifacts: [{ ...guard, payloadDirectory: project.root }] }),
    /skill-protected-branch-guard wires Claude Code with hooks\/claude-code\.settings\.json, but the installed payload in .* has no such file.*Run create-project-calavera artifacts update skill-protected-branch-guard/s,
  );
});
