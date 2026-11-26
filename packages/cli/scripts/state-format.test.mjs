// Issue #838: the Vite+ pre-commit hook runs `vp staged`, which runs `vp check --fix` on the
// staged files, so a file Calavera writes in another shape is rewritten in the next commit. Like
// the generated files (#669), `.calavera/state.json` and `.calavera/artifacts.lock.json` are
// written in the shape the project's own `vp fmt` produces. The stand-in `vp fmt` below runs this
// repository's Oxfmt on exactly the files it is given, as the hook does with the staged files.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { agentBootstrap, applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import {
  CALAVERA_EDITORCONFIG,
  editorConfigRemovalChange,
  renderEditorConfig,
} from "../src/utils/editorconfig.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  releaseFixturePath,
  writeVitePlusFormatter,
} from "./vite-plus-fixtures.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const STATE_PATH = ".calavera/state.json";
const LOCK_PATH = ".calavera/artifacts.lock.json";

// Two integrations keep the state's arrays short enough for Oxfmt to put each on one line, which
// is the change the hook made in #749.
const recipe = buildRecipe("default", ["editorconfig", "knip"], "pnpm", []);
const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

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

/**
 * Formats `paths` in place with the project's own `vp fmt`, as `vp check --fix` formats the staged
 * files in the pre-commit hook, and returns each file's text before and after.
 *
 * @param {string} root
 * @param {string[]} paths
 */
async function formatAsTheHookDoes(root, paths) {
  const before = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
  const format = spawnSync(
    process.execPath,
    [join(root, "node_modules/vite-plus/bin/vp"), "fmt", "--write", ...paths],
    { cwd: root, encoding: "utf8" },
  );
  assert.equal(format.status, 0, `${format.stdout}${format.stderr}`);
  const after = await Promise.all(paths.map((path) => readFile(join(root, path), "utf8")));
  return { before, after };
}

test("Given a Vite+ project, when apply writes .calavera/state.json, then vp fmt keeps it byte-for-byte, and the second dry run reports no change", async () => {
  await using project = await copyReleaseFixture("library");
  await inDirectory(project.root, () => applyRecipeObject(recipe, applyOptions));

  const { before, after } = await formatAsTheHookDoes(project.root, [STATE_PATH]);
  assert.match(before[0], /"integrations": \["editorconfig", "knip"\]/);
  assert.equal(after[0], before[0], "vp fmt rewrote .calavera/state.json");

  await inDirectory(project.root, async () => {
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
    assert.deepEqual(
      dryRun.changes.filter(({ type }) => type !== "unchanged").map(({ path }) => path),
      [],
    );
  });
});

test("Given a Vite+ project, when agent-init and clean rewrite .calavera/state.json, then vp fmt keeps it byte-for-byte", async () => {
  await using project = await copyReleaseFixture("library");
  await inDirectory(project.root, async () => {
    await applyRecipeObject(recipe, applyOptions);
    await agentBootstrap({ json: true, assumeYes: true, mcpHarness: "claude-code" });
  });

  const bootstrapped = await formatAsTheHookDoes(project.root, [STATE_PATH]);
  assert.match(bootstrapped.before[0], /"aiArtifacts": \[\n/);
  assert.equal(
    bootstrapped.after[0],
    bootstrapped.before[0],
    "vp fmt rewrote the agent-init state",
  );

  // Deselecting knip leaves its file for clean to remove, and clean records what it kept.
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify(buildRecipe("default", ["editorconfig"], "pnpm", []), null, 2)}\n`,
  );
  const clean = spawnSync(process.execPath, [cli, "clean", "--yes", "--json"], {
    cwd: project.root,
    encoding: "utf8",
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(
    JSON.parse(clean.stdout).changes.some(
      (/** @type {{ type: string, path: string }} */ { type, path }) =>
        type === "delete" && path === "knip.json",
    ),
    clean.stdout,
  );

  const cleaned = await formatAsTheHookDoes(project.root, [STATE_PATH]);
  assert.match(cleaned.before[0], /"files": \["\.editorconfig"\]/);
  assert.equal(cleaned.after[0], cleaned.before[0], "vp fmt rewrote the state clean wrote");
});

test("Given a Vite+ project that formats with tabs, when apply and artifacts install write the state and the artifact lock, then vp fmt keeps both byte-for-byte", async () => {
  await using project = await copyReleaseFixture("library");
  await writeFile(join(project.root, ".oxfmtrc.json"), '{ "useTabs": true }\n');
  const registry = stubRegistry(
    new Map([
      ["skill-project-goal", "0.1.0"],
      ["hook-block-dangerous-commands", "0.4.0"],
    ]),
  );

  await inDirectory(project.root, () =>
    applyRecipeObject({ ...recipe, ai: [{ id: "skill-project-goal" }] }, applyOptions, registry),
  );
  const applied = await formatAsTheHookDoes(project.root, [STATE_PATH, LOCK_PATH]);
  assert.match(applied.before[1], /^\{\n\t"schemaVersion": 1,/);
  assert.deepEqual(
    applied.after,
    applied.before,
    "vp fmt rewrote the state or the lock apply wrote",
  );

  // artifacts install commits the state and the lock without apply writing the state after it.
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify(
      { ...recipe, ai: [{ id: "skill-project-goal" }, { id: "hook-block-dangerous-commands" }] },
      null,
      2,
    )}\n`,
  );
  await inDirectory(project.root, () =>
    runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      registry,
    ),
  );
  const installed = await formatAsTheHookDoes(project.root, [STATE_PATH, LOCK_PATH]);
  assert.match(installed.before[0], /^\{\n\t"version": 1,/);
  assert.match(installed.before[1], /"id": "hook-block-dangerous-commands"/);
  assert.deepEqual(
    installed.after,
    installed.before,
    "vp fmt rewrote the state or the lock artifacts install wrote",
  );
});

test("Given a Vite+ project whose vite-plus is not installed, when nothing but the state needs the formatter, then the dry run and apply stop before writing anything", async () => {
  await using project = await copyReleaseFixture("library", { vitePlus: false });
  // .editorconfig is not formatted, and without writeConfig no recipe file is written, so only
  // the state needs vp fmt.
  const editorConfigOnly = buildRecipe("default", ["editorconfig"], "pnpm", []);
  const options = { ...applyOptions, writeConfig: false };

  await inDirectory(project.root, async () => {
    const before = await snapshotDirectory();
    const stop = /cannot find its vite-plus package, so it cannot format the files it writes/;
    await assert.rejects(applyRecipeObject(editorConfigOnly, { ...options, dryRun: true }), stop);
    await assert.rejects(applyRecipeObject(editorConfigOnly, options), stop);
    assert.deepEqual(await snapshotDirectory(), before, "apply wrote files before it stopped");
  });
});

test("Given a Vite+ project inside a folder whose .editorconfig sets four-space indentation, when only the state needs the formatter, then the dry run and apply both stop before writing anything", async () => {
  await using parent = await createTemporaryFixture("state-parent-editorconfig", {
    ".editorconfig": "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n",
  });
  const root = join(parent.root, "library");
  await cp(releaseFixturePath("library"), root, { recursive: true });
  await writeVitePlusFormatter(root);
  // Apply writes Calavera's .editorconfig, which would change how vp fmt formats the state. The
  // dry run cannot see that file on disk, so apply has to stop before writing it, as the dry run does.
  const editorConfigOnly = buildRecipe("default", ["editorconfig"], "pnpm", []);
  const options = { ...applyOptions, writeConfig: false };
  const stop = /Calavera's \.editorconfig would change how vp fmt formats \.calavera\/state\.json/;

  await inDirectory(root, async () => {
    const before = await snapshotDirectory();
    await assert.rejects(applyRecipeObject(editorConfigOnly, { ...options, dryRun: true }), stop);
    await assert.rejects(applyRecipeObject(editorConfigOnly, options), stop);
    assert.deepEqual(await snapshotDirectory(), before, "apply wrote files before it stopped");
  });
});

test("Given a Vite+ project whose vp fmt prints a banner, when artifacts install runs as a dry run, then it formats the state and the lock and stops as the install would", async () => {
  await using project = await copyReleaseFixture("library");
  await writeVitePlusFormatter(project.root, { banner: "dotenv: injected 2 variables" });
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify({ ...recipe, ai: [{ id: "skill-project-goal" }] }, null, 2)}\n`,
  );
  const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));

  await inDirectory(project.root, async () => {
    const before = await snapshotDirectory();
    await assert.rejects(
      runArtifactCommand(
        { config: "calavera.config.json", dryRun: true, artifactAction: "install" },
        registry,
      ),
      /returned text for \.calavera\/state\.json that is not JSON/,
    );
    assert.deepEqual(await snapshotDirectory(), before, "the dry run changed the project");
  });
});

test("Given a locked hook whose output is missing, in a Vite+ project inside a folder whose .editorconfig sets four-space indentation, when apply would add Calavera's .editorconfig, then apply stops without restoring the hook", async () => {
  await using parent = await createTemporaryFixture("state-locked-hook", {
    ".editorconfig": "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n",
  });
  const root = join(parent.root, "library");
  await cp(releaseFixturePath("library"), root, { recursive: true });
  await writeVitePlusFormatter(root);
  const hook = { id: "hook-block-dangerous-commands" };
  const options = { ...applyOptions, writeConfig: false };
  const registry = stubRegistry(new Map([["hook-block-dangerous-commands", "0.4.0"]]));
  const stop = /Calavera's \.editorconfig would change how vp fmt formats \.calavera\/state\.json/;

  await inDirectory(root, async () => {
    // The first apply locks the hook. Without editorconfig in the recipe, the parent's settings
    // stay in effect, so nothing stops it.
    await applyRecipeObject(
      { ...buildRecipe("default", [], "pnpm", []), ai: [hook] },
      options,
      registry,
    );
    await rm(".agents/hooks/claude-code/block-dangerous-commands.mjs");
    const before = await snapshotDirectory();
    const withEditorConfig = {
      ...buildRecipe("default", ["editorconfig"], "pnpm", []),
      ai: [hook],
    };

    await assert.rejects(
      applyRecipeObject(withEditorConfig, { ...options, dryRun: true }, registry),
      stop,
    );
    await assert.rejects(applyRecipeObject(withEditorConfig, options, registry), stop);
    assert.deepEqual(
      await snapshotDirectory(),
      before,
      "apply restored the hook before it stopped",
    );
  });
});

test("Given a locked hook whose package is missing from .calavera/packages, in a Vite+ project inside a folder whose .editorconfig sets four-space indentation, when apply would add Calavera's .editorconfig, then apply stops without restoring the package or leaving a staging folder", async () => {
  await using parent = await createTemporaryFixture("state-locked-package", {
    ".editorconfig": "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n",
  });
  const root = join(parent.root, "library");
  await cp(releaseFixturePath("library"), root, { recursive: true });
  await writeVitePlusFormatter(root);
  const hook = { id: "hook-block-dangerous-commands" };
  const options = { ...applyOptions, writeConfig: false };
  const registry = stubRegistry(new Map([["hook-block-dangerous-commands", "0.4.0"]]));
  const stop = /Calavera's \.editorconfig would change how vp fmt formats \.calavera\/state\.json/;

  await inDirectory(root, async () => {
    await applyRecipeObject(
      { ...buildRecipe("default", [], "pnpm", []), ai: [hook] },
      options,
      registry,
    );
    // #988: the restore point. The lock still records the package, so apply rebuilds it from the
    // cache, but only once nothing can stop apply.
    await rm(".calavera/packages", { recursive: true });
    const before = await snapshotDirectory();
    const withEditorConfig = {
      ...buildRecipe("default", ["editorconfig"], "pnpm", []),
      ai: [hook],
    };

    await assert.rejects(applyRecipeObject(withEditorConfig, options, registry), stop);
    assert.deepEqual(
      await snapshotDirectory(),
      before,
      "apply restored the locked package, or left a staging folder, before it stopped",
    );
  });
});

test("Given a Vite+ project inside a folder whose .editorconfig sets four-space indentation, when clean would remove Calavera's .editorconfig, then clean stops before changing anything, and runs once the person removes it", async () => {
  await using parent = await createTemporaryFixture("state-clean-editorconfig", {
    ".editorconfig": "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n",
  });
  const root = join(parent.root, "library");
  await cp(releaseFixturePath("library"), root, { recursive: true });
  await writeVitePlusFormatter(root);
  // Calavera's .editorconfig is already in place, so apply formats with its settings.
  await writeFile(join(root, ".editorconfig"), renderEditorConfig(CALAVERA_EDITORCONFIG));
  await inDirectory(root, () => applyRecipeObject(recipe, applyOptions));
  // Dropping editorconfig from the recipe leaves Calavera's .editorconfig for clean to remove.
  await writeFile(
    join(root, "calavera.config.json"),
    `${JSON.stringify(buildRecipe("default", ["knip"], "pnpm", []), null, 2)}\n`,
  );
  const runClean = (/** @type {string[]} */ args) =>
    spawnSync(process.execPath, [cli, "clean", "--yes", "--json", ...args], {
      cwd: root,
      encoding: "utf8",
    });
  const stop =
    /Removing Calavera's \.editorconfig would change how vp fmt formats \.calavera\/state\.json: indent_size is 2 now and 4 after clean/;
  const before = await inDirectory(root, () => snapshotDirectory());

  for (const args of [["--dry-run"], []]) {
    const clean = runClean(args);
    assert.notEqual(clean.status, 0, clean.stdout);
    // With --json, the stop is a JSON result (#1227).
    assert.match(JSON.parse(clean.stdout).issues[0].message, stop);
  }
  assert.deepEqual(
    await inDirectory(root, () => snapshotDirectory()),
    before,
    "clean changed files",
  );

  // The remedy the error names: remove the file first, so vp fmt reads the settings clean leaves.
  await rm(join(root, ".editorconfig"));
  const clean = runClean([]);
  assert.equal(clean.status, 0, clean.stderr);
  const { before: state, after } = await formatAsTheHookDoes(root, [STATE_PATH]);
  assert.match(state[0], /^\{\n {4}"version": 1,/);
  assert.equal(after[0], state[0], "vp fmt rewrote the state clean wrote");
});

test("Given a Vite+ project with no other .editorconfig, when clean removes Calavera's .editorconfig, then it does not stop, and vp fmt keeps the state it writes", async () => {
  await using project = await copyReleaseFixture("library");
  await inDirectory(project.root, () => applyRecipeObject(recipe, applyOptions));
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify(buildRecipe("default", ["knip"], "pnpm", []), null, 2)}\n`,
  );

  const clean = spawnSync(process.execPath, [cli, "clean", "--yes", "--json"], {
    cwd: project.root,
    encoding: "utf8",
  });
  assert.equal(clean.status, 0, clean.stderr);
  assert.ok(
    JSON.parse(clean.stdout).changes.some(
      (/** @type {{ type: string, path: string }} */ { type, path }) =>
        type === "delete" && path === ".editorconfig",
    ),
    clean.stdout,
  );
  const { before, after } = await formatAsTheHookDoes(project.root, [STATE_PATH]);
  assert.equal(after[0], before[0], "vp fmt rewrote the state clean wrote");
});

test("editorConfigRemovalChange compares the settings Oxfmt uses with and without the project root's .editorconfig", async () => {
  await using parent = await createTemporaryFixture("editorconfig-removal", {
    ".editorconfig": "root = true\n\n[*]\nindent_size = 4\n",
    "project/.editorconfig": renderEditorConfig(CALAVERA_EDITORCONFIG),
    // Oxfmt never reads a subfolder's .editorconfig, so neither does the comparison.
    "project/.calavera/.editorconfig": "[*]\nindent_size = 8\n",
  });
  const project = join(parent.root, "project");

  assert.deepEqual(await editorConfigRemovalChange(project, STATE_PATH), {
    property: "indent_size",
    current: 2,
    planned: 4,
    sources: [join(parent.root, ".editorconfig")],
  });

  // A project file that is not root = true still sets the values removal takes away.
  await writeFile(join(project, ".editorconfig"), "[*]\nindent_size = 2\n");
  assert.equal((await editorConfigRemovalChange(project, STATE_PATH))?.planned, 4);

  // Without a project file, there is nothing to remove.
  await rm(join(project, ".editorconfig"));
  assert.equal(await editorConfigRemovalChange(project, STATE_PATH), undefined);

  // Calavera's settings are Oxfmt's defaults, so removing them with no parent file changes nothing.
  await rm(join(parent.root, ".editorconfig"));
  await writeFile(join(project, ".editorconfig"), renderEditorConfig(CALAVERA_EDITORCONFIG));
  assert.equal(await editorConfigRemovalChange(project, STATE_PATH), undefined);
});

test("Given a Vite+ project whose vp fmt cannot format the state, when agent-init runs, then the dry run and agent-init both stop before writing anything", async () => {
  await using project = await copyReleaseFixture("library");
  // #986: the guidance and MCP notes still format, so the first step to fail is the state.
  // agent-init used to copy the skill files before that step.
  await writeVitePlusFormatter(project.root, { failFor: STATE_PATH });
  const options = { json: true, assumeYes: true, mcpHarness: "claude-code" };
  const stop =
    /could not format \.calavera\/state\.json: it exited with code 2\. Calavera does not show vp fmt's output/;

  await inDirectory(project.root, async () => {
    const before = await snapshotDirectory();
    await assert.rejects(agentBootstrap({ ...options, dryRun: true }), stop);
    await assert.rejects(agentBootstrap(options), stop);
    assert.deepEqual(await snapshotDirectory(), before, "agent-init wrote files before it stopped");
  });
});

test("Given a Vite+ project, when agent-init runs as a dry run, then it lists the skill files and the state and writes nothing", async () => {
  await using project = await copyReleaseFixture("library");

  await inDirectory(project.root, async () => {
    const before = await snapshotDirectory();
    // #986: agent-init now plans the skill files in a dry run before it formats the state, so this
    // guards that a dry run still only lists them, and the CodeRabbit config they bring.
    const dryRun = await agentBootstrap({ json: true, dryRun: true, mcpHarness: "claude-code" });
    const listed = dryRun.changes.map(({ path }) => path);
    assert.ok(listed.includes(".agents/skills/calavera"), listed.join(", "));
    assert.ok(listed.includes(".coderabbit.yaml"), listed.join(", "));
    assert.ok(listed.includes(STATE_PATH), listed.join(", "));
    assert.deepEqual(await snapshotDirectory(), before, "the dry run changed the project");
  });
});

test("Given a Vite+ project whose recipe names a legacy artifact path, when artifacts migrate rewrites calavera.config.json, then vp fmt keeps it byte-for-byte", async () => {
  await using project = await copyReleaseFixture("library");
  // #987: written the way JSON.stringify writes it, with each array item on its own line. vp fmt
  // puts the short integrations array on one line, which is the change the hook made.
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify({ ...recipe, ai: [{ type: "skill", src: "skills/project-goal" }] }, null, 2)}\n`,
  );

  const result = await inDirectory(project.root, () =>
    runArtifactCommand({
      config: "calavera.config.json",
      dryRun: false,
      artifactAction: "migrate",
    }),
  );
  assert.equal(result.migrated, 1);

  const { before, after } = await formatAsTheHookDoes(project.root, ["calavera.config.json"]);
  assert.match(before[0], /"integrations": \["editorconfig", "knip"\]/);
  assert.match(before[0], /"ai": \[\n\s+\{\n\s+"id": "skill-project-goal"\n/);
  assert.equal(after[0], before[0], "vp fmt rewrote calavera.config.json");
});

test("Given a Vite+ project whose vp fmt cannot format calavera.config.json, when artifacts migrate runs, then the dry run and the migration both stop before writing anything", async () => {
  await using project = await copyReleaseFixture("library");
  await writeVitePlusFormatter(project.root, { failFor: "calavera.config.json" });
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify({ ...recipe, ai: [{ type: "skill", src: "skills/project-goal" }] }, null, 2)}\n`,
  );
  const stop =
    /could not format calavera\.config\.json: it exited with code 2\. Calavera does not show vp fmt's output/;

  await inDirectory(project.root, async () => {
    const before = await snapshotDirectory();
    for (const dryRun of [true, false]) {
      await assert.rejects(
        runArtifactCommand({ config: "calavera.config.json", dryRun, artifactAction: "migrate" }),
        stop,
      );
    }
    assert.deepEqual(
      await snapshotDirectory(),
      before,
      "artifacts migrate wrote files before it stopped",
    );
  });
});

test("Given a Vite+ project whose recipe names a legacy artifact path, when artifacts migrate runs as a dry run, then it reports the migration and writes nothing", async () => {
  await using project = await copyReleaseFixture("library");
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify({ ...recipe, ai: [{ type: "skill", src: "skills/project-goal" }] }, null, 2)}\n`,
  );

  await inDirectory(project.root, async () => {
    const before = await snapshotDirectory();
    const result = await runArtifactCommand({
      config: "calavera.config.json",
      dryRun: true,
      artifactAction: "migrate",
    });
    assert.equal(result.migrated, 1);
    assert.deepEqual(result.recipe.ai, [{ id: "skill-project-goal" }]);
    assert.deepEqual(await snapshotDirectory(), before, "the dry run changed the project");
  });
});

test("Given a recipe with no legacy artifact path, when artifacts migrate runs, then it neither loads the formatter nor rewrites calavera.config.json", async () => {
  await using project = await copyReleaseFixture("library");
  // #987: the migration formats only the recipe it rewrites, so a recipe in a shape vp fmt would
  // change stays as the person left it when there is nothing to migrate.
  await writeFile(
    join(project.root, "calavera.config.json"),
    `${JSON.stringify({ ...recipe, ai: [{ id: "skill-project-goal" }] }, null, 2)}\n`,
  );
  const services = {
    loadFormatter: async () => {
      throw new Error("artifacts migrate loaded the formatter with nothing to migrate");
    },
  };

  await inDirectory(project.root, async () => {
    const before = await snapshotDirectory();
    const result = await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "migrate" },
      services,
    );
    assert.equal(result.migrated, 0);
    assert.deepEqual(await snapshotDirectory(), before, "artifacts migrate rewrote the recipe");
  });
});
