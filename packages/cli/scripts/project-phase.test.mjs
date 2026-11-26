// #1112 (ADR-0020, Decisions 1 to 3): one function derives the project's phase from Calavera's
// records and the files they name, and classifies each artifact with a condition and its reason,
// so that every doctor reads the same answer. Each phase test builds its project with the real
// commands where one exists (`--init`, `artifacts install`, `apply`), and each test fails when the
// rule of the phase tree it covers is removed.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtempDisposable, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { artifactCatalog } from "@schalkneethling/calavera-artifact-core";

import { hashAiInstall } from "../src/ai/artifacts.js";
import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { integrationCatalog } from "../src/catalog.js";
import { EJECTED_BLOCK, EJECTED_LINE, readEjectedMarker } from "../src/ejected-marker.js";
import { applyRecipeObject } from "../src/index.js";
import { deriveProjectPhase } from "../src/project-phase.js";
import { buildRecipe } from "../src/recipe.js";
import { JSONParseError } from "../src/utils/fs.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const CONFIG = "calavera.config.json";
const STATE = ".calavera/state.json";
const LOCK = ".calavera/artifacts.lock.json";
const JOURNAL = ".calavera/artifact-transaction.json";
const ARTIFACT = "skill-project-goal";
const SKILL = ".agents/skills/project-goal";
const OTHER = "skill-code-review";
const OTHER_SKILL = ".agents/skills/code-review";
const BASE_SKILL = ".agents/skills/calavera";
const applyOptions = { json: true, noInstall: true, assumeYes: true };
const registry = () =>
  stubRegistry(
    new Map([
      [ARTIFACT, "0.1.0"],
      [OTHER, "0.2.0"],
    ]),
  );
const marker = (/** @type {string} */ inside) =>
  `node_modules/\n# calavera:${EJECTED_BLOCK}:start\n${inside}\n# calavera:${EJECTED_BLOCK}:end\n`;

/** @param {(directory: string) => Promise<void>} callback */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-project-phase-"));
  const directory = await realpath(project.path);
  const originalDirectory = process.cwd();
  process.chdir(directory);
  try {
    await writeFile("package.json", `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
    await callback(directory);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string[]} ids */
const recipeWith = (ids) => ({
  ...buildRecipe("minimal", [], "npm"),
  ai: ids.map((id) => ({ id })),
});

/** @param {string[]} ids */
async function writeRecipe(ids) {
  await writeFile(CONFIG, `${JSON.stringify(recipeWith(ids), null, 2)}\n`);
}

/** @param {string[]} ids */
async function applied(ids) {
  await writeRecipe(ids);
  await applyRecipeObject(recipeWith(ids), applyOptions, registry());
}

/** @param {string} path */
async function readJsonFile(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

/** @param {string} path @param {unknown} value */
async function writeJsonFile(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** @param {string[]} args */
function runCli(args) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `${args.join(" ")} exited ${result.status}\n${result.stderr}`);
}

const derive = () => deriveProjectPhase({ config: CONFIG });

/** @param {Awaited<ReturnType<typeof derive>>} result @param {string} id */
function conditionOf(result, id) {
  const artifact = result.artifacts.find((item) => item.id === id);
  assert.ok(artifact, `no artifact ${id}`);
  return { selected: artifact.selected, ...artifact.condition };
}

test("a project without a recipe, state, lock, or marker is unmanaged", async () => {
  await inProject(async () => {
    const result = await derive();
    assert.equal(result.phase, "unmanaged");
    assert.deepEqual(result.artifacts, []);
    assert.deepEqual(result.marker, { status: "absent" });
    assert.equal(result.rollbackFiles, null);
  });
});

test("an empty lock file counts as no lock entries", async () => {
  await inProject(async () => {
    await mkdir(".calavera");
    await writeJsonFile(LOCK, { schemaVersion: 1, artifacts: [] });
    assert.equal((await derive()).phase, "unmanaged");
  });
});

test("the ejected marker without any record is ejected, edited or not", async () => {
  await inProject(async () => {
    await writeFile(".gitignore", marker(EJECTED_LINE));
    let result = await derive();
    assert.equal(result.phase, "ejected");
    assert.deepEqual(result.marker, { status: "complete" });

    await writeFile(".gitignore", marker(`${EJECTED_LINE}\ndist/`));
    result = await derive();
    assert.equal(result.phase, "ejected");
    assert.deepEqual(result.marker, { status: "edited" });
  });
});

test("a broken or unreadable marker counts as no marker", async () => {
  await inProject(async () => {
    await writeFile(".gitignore", `# calavera:${EJECTED_BLOCK}:start\n${EJECTED_LINE}\n`);
    let result = await derive();
    assert.equal(result.phase, "unmanaged");
    assert.deepEqual(result.marker, { status: "broken" });

    await writeFile(
      ".gitignore",
      marker(EJECTED_LINE).replace(
        `# calavera:${EJECTED_BLOCK}:end`,
        `  # calavera:${EJECTED_BLOCK}:end`,
      ),
    );
    result = await derive();
    assert.equal(result.phase, "unmanaged");
    assert.deepEqual(result.marker, { status: "broken" });

    await rm(".gitignore");
    await mkdir(".gitignore");
    result = await derive();
    assert.equal(result.phase, "unmanaged");
    assert.deepEqual(result.marker, { status: "unreadable", code: "EISDIR" });
  });
});

test("the marker next to a record is ignored for the phase but still read", async () => {
  await inProject(async () => {
    await writeFile(".gitignore", marker("edited by hand"));
    await writeRecipe([]);
    const result = await derive();
    assert.equal(result.phase, "composed");
    assert.deepEqual(result.marker, { status: "edited" });
  });
});

test("--init leaves a bootstrapped project until the base skill is gone", async () => {
  await inProject(async () => {
    runCli(["--init", "--yes", "--mcp-harness", "skip"]);
    let result = await derive();
    assert.equal(result.phase, "bootstrapped");
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.records?.baseSkillRecorded, true);

    // An edited base skill still reads as bootstrapped.
    await writeFile(join(BASE_SKILL, "SKILL.md"), "edited\n");
    assert.equal((await derive()).phase, "bootstrapped");

    // After an eject that removed the base skill and could not write its marker, or a person
    // deleting it, the same state remains, and the project reads as incomplete (owner decision 18).
    await rm(BASE_SKILL, { recursive: true });
    result = await derive();
    assert.equal(result.phase, "incomplete");
    assert.equal(result.records?.baseSkillPresent, false);
  });
});

test("a state without profile that records no base skill, and no recipe, is incomplete", async () => {
  await inProject(async () => {
    await mkdir(".calavera");
    await writeJsonFile(STATE, { version: 1, aiArtifacts: [] });
    assert.equal((await derive()).phase, "incomplete");
  });
});

test("a base skill folder that the state does not record is not bootstrapped", async () => {
  await inProject(async () => {
    await mkdir(BASE_SKILL, { recursive: true });
    await writeFile(join(BASE_SKILL, "SKILL.md"), "the person's copy\n");
    await mkdir(".calavera");
    await writeJsonFile(STATE, { version: 1, aiArtifacts: [] });
    const result = await derive();
    assert.equal(result.phase, "incomplete");
    assert.equal(result.records?.baseSkillPresent, false);
  });
});

test("--init and then init move the project from bootstrapped to composed", async () => {
  await inProject(async () => {
    runCli(["--init", "--yes", "--mcp-harness", "skip"]);
    assert.equal((await derive()).phase, "bootstrapped");
    runCli(["init", "--yes", "--profile", "minimal", "--ai-artifact", ARTIFACT]);
    const result = await derive();
    assert.equal(result.phase, "composed");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "pending",
      reason: `The recipe selects ${ARTIFACT}, which has no lock entry yet, so artifacts install or apply installs it.`,
    });
  });
});

test("init alone leaves a composed project whose selections are pending", async () => {
  await inProject(async () => {
    runCli(["init", "--yes", "--profile", "minimal", "--ai-artifact", ARTIFACT]);
    const result = await derive();
    assert.equal(result.phase, "composed");
    assert.equal(result.records?.state, false);
    assert.equal(conditionOf(result, ARTIFACT).name, "pending");
  });
});

test("artifacts install before apply stays composed, with the artifact current", async () => {
  await inProject(async () => {
    await writeRecipe([ARTIFACT]);
    await runArtifactCommand(
      { config: CONFIG, dryRun: false, artifactAction: "install" },
      registry(),
    );
    let result = await derive();
    assert.equal(result.phase, "composed");
    assert.equal(result.records?.profile, false);
    assert.equal(conditionOf(result, ARTIFACT).name, "current");

    // Before apply, an edited artifact is still edited, but the project is not drifted, because
    // drifted describes a difference from what apply recorded (Decision 3).
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    result = await derive();
    assert.equal(result.phase, "composed");
    assert.equal(conditionOf(result, ARTIFACT).name, "edited");
  });
});

test("apply makes the project applied, and each change to an artifact drifts it", async () => {
  await inProject(async () => {
    await applied([ARTIFACT, OTHER]);
    let result = await derive();
    assert.equal(result.phase, "applied");
    // One entry per lock entry; a locked selection is not listed again as a selection.
    assert.deepEqual(
      result.artifacts.map(({ id, lockEntry }) => [id, lockEntry?.version]),
      [
        [ARTIFACT, "0.1.0"],
        [OTHER, "0.2.0"],
      ],
    );
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "current",
      reason: `The lock entry artifacts[0] records ${ARTIFACT}, and every file it installed matches the hash the state records.`,
    });

    // One drifted artifact drifts the project while the other stays current.
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    result = await derive();
    assert.equal(result.phase, "drifted");
    assert.equal(conditionOf(result, OTHER).name, "current");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "edited",
      reason: `The lock entry artifacts[0] records ${ARTIFACT}, and ${SKILL} differs from the hash the state records.`,
    });

    await rm(SKILL, { recursive: true });
    result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "missing",
      reason: `The lock entry artifacts[0] records ${ARTIFACT}, and ${SKILL} does not exist.`,
    });

    // apply again writes the artifact back, which returns the project to applied.
    await applyRecipeObject(recipeWith([ARTIFACT, OTHER]), applyOptions, registry());
    assert.equal((await derive()).phase, "applied");
  });
});

test("an installed output without a state record is unrecorded and drifts the project", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    const state = await readJsonFile(STATE);
    state.aiArtifacts = state.aiArtifacts.filter(
      (/** @type {{ path: string }} */ { path }) => path !== SKILL,
    );
    await writeJsonFile(STATE, state);
    const result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "unrecorded",
      reason: `The lock entry artifacts[0] records ${ARTIFACT}, and ${SKILL} has no record in the state, so Calavera does not manage it.`,
    });
  });
});

test("a missing output wins over an edited one, and an edited one over an unrecorded one", async () => {
  await inProject(async () => {
    // A hook has two outputs, the hook and its settings fragment, so one lock entry can show two
    // problems at once. The lock and the state are written by hand to set each output apart.
    const hook = "hook-block-dangerous-commands";
    await writeFile(
      CONFIG,
      `${JSON.stringify({ ...recipeWith([]), ai: [{ id: hook }] }, null, 2)}\n`,
    );
    const [hookPath, fragmentPath] =
      (await derive()).artifacts[0]?.outputs.map(({ path }) => path) ?? [];
    assert.ok(hookPath && fragmentPath);
    await mkdir(join(hookPath, ".."), { recursive: true });
    await writeFile(hookPath, "hook\n");
    await writeFile(fragmentPath, "{}\n");
    const record = async (/** @type {string} */ path) => ({
      type: "hook",
      name: "block-dangerous-commands",
      source: hook,
      path,
      hash: await hashAiInstall("hook", path),
    });
    await mkdir(".calavera", { recursive: true });
    await writeJsonFile(LOCK, {
      schemaVersion: 1,
      artifacts: [
        { id: hook, type: "hook", version: "1.0.0", tag: "latest", destination: hookPath },
      ],
    });
    // Neither output has a record, and a reason names both in one sentence.
    await writeJsonFile(STATE, { version: 1, profile: "minimal", aiArtifacts: [] });
    assert.equal(
      conditionOf(await derive(), hook).reason,
      `The lock entry artifacts[0] records ${hook}, and ${hookPath} and ${fragmentPath} have no record in the state, so Calavera does not manage them.`,
    );

    // Both outputs recorded and both edited.
    await writeJsonFile(STATE, {
      version: 1,
      profile: "minimal",
      aiArtifacts: [await record(hookPath), await record(fragmentPath)],
    });
    await writeFile(hookPath, "edited\n");
    await writeFile(fragmentPath, "[]\n");
    assert.equal(
      conditionOf(await derive(), hook).reason,
      `The lock entry artifacts[0] records ${hook}, and ${hookPath} and ${fragmentPath} differ from the hashes the state records.`,
    );

    // Without a lock entry, both recorded outputs edited, then both missing.
    await rm(LOCK);
    assert.equal(
      conditionOf(await derive(), hook).reason,
      `The recipe selects ${hook}, which has no lock entry, and ${hookPath} and ${fragmentPath} differ from the hashes the state records.`,
    );
    await rm(hookPath);
    await rm(fragmentPath);
    assert.equal(
      conditionOf(await derive(), hook).reason,
      `The recipe selects ${hook}, which has no lock entry, and ${hookPath} and ${fragmentPath} do not exist, although the state records them.`,
    );
    await writeJsonFile(LOCK, {
      schemaVersion: 1,
      artifacts: [
        { id: hook, type: "hook", version: "1.0.0", tag: "latest", destination: hookPath },
      ],
    });
    await writeFile(hookPath, "hook\n");
    await writeFile(fragmentPath, "{}\n");

    // The hook is edited, and the fragment has no record: edited wins.
    await writeJsonFile(STATE, {
      version: 1,
      profile: "minimal",
      aiArtifacts: [await record(hookPath)],
    });
    await writeFile(hookPath, "edited\n");
    assert.equal(conditionOf(await derive(), hook).name, "edited");

    // The fragment is missing as well: missing wins.
    await rm(fragmentPath);
    assert.deepEqual(conditionOf(await derive(), hook), {
      selected: true,
      name: "missing",
      reason: `The lock entry artifacts[0] records ${hook}, and ${fragmentPath} does not exist.`,
    });

    // A reason names every output that has the problem.
    await rm(hookPath);
    assert.equal(
      conditionOf(await derive(), hook).reason,
      `The lock entry artifacts[0] records ${hook}, and ${hookPath} and ${fragmentPath} do not exist.`,
    );
  });
});

test("a lock entry the recipe no longer selects never drifts the project", async () => {
  await inProject(async () => {
    await applied([ARTIFACT, OTHER]);
    await writeRecipe([ARTIFACT]);
    let result = await derive();
    assert.equal(result.phase, "applied");
    assert.deepEqual(conditionOf(result, OTHER), {
      selected: false,
      name: "current",
      reason: `The lock entry artifacts[1] records ${OTHER}, the recipe no longer selects it, so artifacts install drops its lock entry, and every file it installed matches the hash the state records.`,
    });

    // #1111: deselected, then its files deleted, as clean leaves it.
    await rm(OTHER_SKILL, { recursive: true });
    result = await derive();
    assert.equal(result.phase, "applied");
    assert.deepEqual(conditionOf(result, OTHER), {
      selected: false,
      name: "missing",
      reason: `The lock entry artifacts[1] records ${OTHER}, the recipe no longer selects it, so artifacts install drops its lock entry, and ${OTHER_SKILL} does not exist.`,
    });
  });
});

test("a new selection after apply is pending and keeps the project applied", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    await writeRecipe([ARTIFACT, OTHER]);
    const result = await derive();
    assert.equal(result.phase, "applied");
    assert.equal(conditionOf(result, OTHER).name, "pending");
  });
});

test("a selection whose files are recorded but not locked is pending, or edited or missing", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    await rm(LOCK);
    let result = await derive();
    assert.equal(result.phase, "applied");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "pending",
      reason: `The recipe selects ${ARTIFACT}, which has no lock entry, but its files are present and match what the state records, so artifacts install records it in the lock.`,
    });

    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "edited",
      reason: `The recipe selects ${ARTIFACT}, which has no lock entry, and ${SKILL} differs from the hash the state records.`,
    });

    await rm(SKILL, { recursive: true });
    result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "missing",
      reason: `The recipe selects ${ARTIFACT}, which has no lock entry, and ${SKILL} does not exist, although the state records it.`,
    });
  });
});

test("a selection with files on disk but no state record stays pending", async () => {
  await inProject(async () => {
    await writeRecipe([ARTIFACT]);
    await mkdir(SKILL, { recursive: true });
    await writeFile(join(SKILL, "SKILL.md"), "the person's own skill\n");
    const result = await derive();
    assert.equal(result.phase, "composed");
    // The files are not Calavera's, so the reason says that apply stops on them.
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "pending",
      reason: `The recipe selects ${ARTIFACT}, which has no lock entry yet, and ${SKILL} already exists without a state record, so apply stops on it unless it matches the package.`,
    });
  });
});

test("a hook selection with one recorded output that differs is edited", async () => {
  await inProject(async () => {
    // ADR-0020 leaves this case open ("Items for the implementation issues"): a hook has two
    // outputs, and only one has a state record. The recorded output that differs makes it edited.
    const hook = "hook-block-dangerous-commands";
    await writeFile(
      CONFIG,
      `${JSON.stringify({ ...recipeWith([]), ai: [{ id: hook }] }, null, 2)}\n`,
    );
    const result0 = await derive();
    const [output] = result0.artifacts[0]?.outputs ?? [];
    assert.ok(output);
    await mkdir(join(output.path, ".."), { recursive: true });
    await writeFile(output.path, "original\n");
    const hash = await hashAiInstall("hook", output.path);
    await writeFile(output.path, "edited\n");
    await mkdir(".calavera", { recursive: true });
    await writeJsonFile(STATE, {
      version: 1,
      aiArtifacts: [
        { type: "hook", name: "block-dangerous-commands", source: hook, path: output.path, hash },
      ],
    });
    assert.equal(conditionOf(await derive(), hook).name, "edited");

    // The recorded output unchanged and the other absent: the artifact is not fully installed.
    await writeFile(output.path, "original\n");
    assert.deepEqual(conditionOf(await derive(), hook), {
      selected: true,
      name: "pending",
      reason: `The recipe selects ${hook}, which has no lock entry yet, so artifacts install or apply installs it.`,
    });

    // Both outputs on disk without a record: the reason names both.
    const [, fragment] = result0.artifacts[0]?.outputs ?? [];
    assert.ok(fragment);
    await writeFile(fragment.path, "{}\n");
    await writeJsonFile(STATE, { version: 1, aiArtifacts: [] });
    assert.equal(
      conditionOf(await derive(), hook).reason,
      `The recipe selects ${hook}, which has no lock entry yet, and ${output.path} and ${fragment.path} already exist without a state record, so apply stops on them unless they match the package.`,
    );
  });
});

test("a deleted recipe after apply is incomplete, with every artifact still classified", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    await rm(CONFIG);
    const result = await derive();
    assert.equal(result.phase, "incomplete");
    assert.deepEqual(result.records, {
      recipe: false,
      state: true,
      profile: true,
      lockEntries: 1,
      baseSkillRecorded: false,
      baseSkillPresent: false,
      packagesPresent: true,
    });
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: null,
      name: "current",
      reason: `The lock entry artifacts[0] records ${ARTIFACT}, and every file it installed matches the hash the state records.`,
    });
  });
});

test("a deleted state is incomplete with lock entries and composed without", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    await rm(STATE);
    assert.equal((await derive()).phase, "incomplete");

    await rm(LOCK);
    assert.equal((await derive()).phase, "composed");
  });
});

test("lock entries without a recipe or a state are incomplete", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    await rm(CONFIG);
    await rm(STATE);
    assert.equal((await derive()).phase, "incomplete");
  });
});

test("a pending transaction wins over every other record and lists the rollback", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    const root = ".calavera/.transactions/stopped";
    await mkdir(`${root}/backup`, { recursive: true });
    await writeJsonFile(JOURNAL, {
      schemaVersion: 1,
      transactionRoot: root,
      operations: [
        {
          staged: `${root}/staged/lock`,
          target: LOCK,
          backup: `${root}/backup/lock`,
          hadTarget: false,
        },
      ],
    });
    // A record that would otherwise stop the function is not read.
    await writeFile(STATE, "{ not json");
    const before = await snapshotDirectory();
    const result = await derive();
    assert.deepEqual(await snapshotDirectory(), before);
    assert.equal(result.phase, "pending-transaction");
    assert.deepEqual(result.rollbackFiles, [LOCK]);
    assert.deepEqual(result.artifacts, []);
    assert.equal(result.records, null);
    assert.equal(result.marker, null);

    await writeFile(JOURNAL, "{ not json");
    assert.equal((await derive()).rollbackFiles, null);
  });
});

test("an unreadable recipe, state, or lock stops the function", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    const state = await readFile(STATE, "utf8");
    const lock = await readFile(LOCK, "utf8");

    await writeFile(STATE, "{ not json");
    await assert.rejects(derive(), JSONParseError);
    await writeFile(STATE, state);

    await writeJsonFile(LOCK, { schemaVersion: 1 });
    await assert.rejects(derive(), { message: "Invalid artifact lockfile." });
    await writeFile(LOCK, lock);

    await writeFile(CONFIG, "[]");
    await assert.rejects(derive(), { message: `${CONFIG} must hold a JSON object.` });
  });
});

test("a lock entry with an untrusted shape stops the function and quotes none of it", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    const lock = await readJsonFile(LOCK);
    const [entry] = lock.artifacts;
    const cases = [
      ["not an object", "is not an object"],
      [{ ...entry, id: "x. Injected sentence" }, "has no artifact ID in the form Calavera writes"],
      [{ ...entry, id: undefined }, "has no artifact ID in the form Calavera writes"],
      [{ ...entry, version: "text from the file" }, "has no valid version"],
      [{ ...entry, type: "plugin" }, "has no artifact type Calavera knows"],
      [{ ...entry, target: 1 }, "has a target that is not a string"],
      [
        { ...entry, destination: "package.json" },
        "has a destination outside the artifact output folders",
      ],
      [
        { ...entry, destination: ".agents/skills" },
        "has a destination outside the artifact output folders",
      ],
      [
        { ...entry, destination: undefined },
        "has a destination outside the artifact output folders",
      ],
    ];
    for (const [value, problem] of cases) {
      await writeJsonFile(LOCK, { ...lock, artifacts: [value] });
      await assert.rejects(derive(), {
        message: `${LOCK} artifacts[0] ${problem}, so Calavera cannot check it. Restore the lock from version control, or run artifacts install to write it again.`,
      });
    }
    await writeJsonFile(LOCK, lock);
    assert.equal((await derive()).phase, "applied");
  });
});

test("a Codex agent is hashed as its target installs it", async () => {
  await inProject(async () => {
    const agent = artifactCatalog.find(({ type }) => type === "agent");
    assert.ok(agent);
    const destination = ".codex/agents/reviewer.toml";
    await mkdir(".codex/agents", { recursive: true });
    // Bytes that are not valid UTF-8: the Codex target hashes the text it reads, which replaces
    // them, so its hash differs from the hash of the bytes that another target would compute.
    await writeFile(destination, Buffer.from([0x6e, 0x3d, 0xff, 0xfe, 0x0a]));
    await mkdir(".calavera");
    await writeJsonFile(LOCK, {
      schemaVersion: 1,
      artifacts: [
        {
          id: agent.id,
          type: "agent",
          version: "1.0.0",
          tag: "latest",
          target: "codex",
          destination,
        },
      ],
    });
    await writeJsonFile(STATE, {
      version: 1,
      profile: "minimal",
      aiArtifacts: [
        {
          type: "agent",
          name: "reviewer",
          source: agent.id,
          path: destination,
          target: "codex",
          hash: await hashAiInstall("agent", destination, "codex"),
        },
      ],
    });
    await writeRecipe([]);
    assert.equal(conditionOf(await derive(), agent.id).name, "current");
  });
});

test("an output that cannot be hashed is unreadable, and the run classifies the rest", async () => {
  await inProject(async () => {
    await applied([ARTIFACT, OTHER]);
    // A file where the skill's folder was.
    await rm(SKILL, { recursive: true });
    await writeFile(SKILL, "not a folder\n");
    const result = await derive();
    assert.equal(result.phase, "drifted");
    assert.deepEqual(conditionOf(result, ARTIFACT), {
      selected: true,
      name: "unreadable",
      reason: `The lock entry artifacts[0] records ${ARTIFACT}, and Calavera cannot read ${SKILL} (ENOTDIR) for the comparison with the state.`,
    });
    assert.equal(conditionOf(result, OTHER).name, "current");

    // Without a lock entry the selection is named by the recipe.
    await rm(LOCK);
    assert.deepEqual(conditionOf(await derive(), ARTIFACT), {
      selected: true,
      name: "unreadable",
      reason: `The recipe selects ${ARTIFACT}, which has no lock entry, and Calavera cannot read ${SKILL} (ENOTDIR) for the comparison with the state.`,
    });
  });
});

test("a lock entry whose type differs from its catalog artifact stops the function", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    const lock = await readJsonFile(LOCK);
    lock.artifacts[0].type = "agent";
    await writeJsonFile(LOCK, lock);
    await assert.rejects(derive(), {
      message: `${LOCK} artifacts[0] has a type that differs from its catalog artifact, so Calavera cannot check it. Restore the lock from version control, or run artifacts install to write it again.`,
    });
  });
});

test("the recipe's ai field must be a list of known selections, named by the recipe file", async () => {
  await inProject(async () => {
    await writeFile(CONFIG, `${JSON.stringify({ ...recipeWith([]), ai: ARTIFACT })}\n`);
    await assert.rejects(derive(), {
      message: `${CONFIG} ai must be a list of artifact selections.`,
    });
    await writeFile(
      CONFIG,
      `${JSON.stringify({ ...recipeWith([]), ai: [{ id: "not-an-artifact" }] })}\n`,
    );
    await assert.rejects(derive(), (error) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        `${CONFIG} has an artifact selection Calavera cannot use: Unknown artifact selection.`,
      );
      assert.ok(error.cause instanceof Error);
      return true;
    });
  });
});

test("a lock entry for an ID the catalog no longer holds is still classified", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    const lock = await readJsonFile(LOCK);
    lock.artifacts[0].id = "skill-retired";
    await writeJsonFile(LOCK, lock);
    await writeRecipe([]);
    const result = await derive();
    assert.equal(result.phase, "applied");
    assert.equal(conditionOf(result, "skill-retired").name, "current");
  });
});

test("a recipe without an ai field selects nothing", async () => {
  await inProject(async () => {
    const { ai, ...recipe } = recipeWith([]);
    assert.ok(ai);
    await writeJsonFile(CONFIG, recipe);
    const result = await derive();
    assert.equal(result.phase, "composed");
    assert.deepEqual(result.artifacts, []);
  });
});

test("a reason names the lock entry by position and never quotes its version", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    const lock = await readJsonFile(LOCK);
    lock.artifacts[0].version = "1.0.0-any.words.here";
    await writeJsonFile(LOCK, lock);
    const { reason } = conditionOf(await derive(), ARTIFACT);
    assert.equal(reason.includes("words"), false);
    assert.match(reason, /^The lock entry artifacts\[0\] records skill-project-goal,/);
  });
});

test("the phase function writes nothing into the project", async () => {
  await inProject(async () => {
    await applied([ARTIFACT]);
    await writeFile(join(SKILL, "SKILL.md"), "edited\n");
    const before = await snapshotDirectory();
    await derive();
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("the ejected block is the fixed text ADR-0017, Amendment 5 names", async () => {
  await inProject(async () => {
    await writeFile(
      ".gitignore",
      "# calavera:ejected:start\n# create-project-calavera eject removed Calavera's records from this project.\n# calavera:ejected:end\n",
    );
    assert.deepEqual(await readEjectedMarker(), { status: "complete" });
  });
});

test("a project that --init and apply managed reads incomplete once its recipe is gone", async () => {
  await inProject(async () => {
    runCli(["--init", "--yes", "--mcp-harness", "skip"]);
    await applied([]);
    await rm(CONFIG);
    const result = await derive();
    // The state has a profile, so the base skill does not make it bootstrapped.
    assert.equal(result.phase, "incomplete");
    assert.equal(result.records?.profile, true);
    assert.equal(result.records?.baseSkillPresent, true);
  });
});

test("a bootstrapped project with lock entries reads incomplete once its recipe is gone", async () => {
  await inProject(async () => {
    runCli(["--init", "--yes", "--mcp-harness", "skip"]);
    await writeRecipe([ARTIFACT]);
    await runArtifactCommand(
      { config: CONFIG, dryRun: false, artifactAction: "install" },
      registry(),
    );
    await rm(CONFIG);
    const result = await derive();
    assert.equal(result.phase, "incomplete");
    assert.deepEqual(result.records, {
      recipe: false,
      state: true,
      profile: false,
      lockEntries: 1,
      baseSkillRecorded: true,
      baseSkillPresent: true,
      packagesPresent: true,
    });
  });
});

test("no catalog integration or artifact takes the ejected block's ID", () => {
  // ADR-0017, Amendment 5: the markers alone identify the block.
  const ids = [...integrationCatalog, ...artifactCatalog].map(({ id }) => id);
  assert.ok(ids.length > 0);
  assert.equal(ids.includes(EJECTED_BLOCK), false);
});

test("readEjectedMarker reports a missing .gitignore as no marker", async () => {
  await inProject(async () => {
    assert.deepEqual(await readEjectedMarker(), { status: "absent" });
    await writeFile(".gitignore", "node_modules/\n");
    assert.deepEqual(await readEjectedMarker(), { status: "absent" });
  });
});
