// #1112 (ADR-0020, Decision 3, "Files Calavera would write that already exist without a record"):
// each output of an artifact without a lock entry that already exists without a state record is
// compared against an offline copy of the project's artifact cache, so the doctors can say whether
// it matches the cached package, without contacting the registry or writing to the project.
import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import { applyRecipeObject } from "../src/index.js";
import { deriveProjectPhase } from "../src/project-phase.js";
import { buildRecipe } from "../src/recipe.js";
import { fileExists } from "../src/utils/fs.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";

const CONFIG = "calavera.config.json";
const CACHE = ".calavera/cache/npm";
const SKILL_ID = "skill-project-goal";
const SKILL = ".agents/skills/project-goal";
const HOOK_ID = "hook-block-dangerous-commands";
const artifactsRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));

/**
 * A stub registry that records every resolve request in full, so a test can check that the phase
 * function asked offline and read a cache outside the project.
 *
 * @param {{ fail?: Error }} [options]
 */
function recordingRegistry({ fail } = {}) {
  const stub = stubRegistry(
    new Map([
      [SKILL_ID, "0.1.0"],
      [HOOK_ID, "0.3.0"],
    ]),
  );
  /** @type {{ id: string, tag?: string, version?: string, cache: string, offline?: boolean }[]} */
  const requests = [];
  return {
    requests,
    resolve: async (/** @type {(typeof requests)[number]} */ request) => {
      requests.push(request);
      if (fail) throw fail;
      return stub.resolve(request);
    },
    extract: stub.extract,
  };
}

/** @param {(directory: string) => Promise<void>} callback */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-phase-unrecorded-"));
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

/** A cache folder with one file, standing in for npm's cache, which the stub registry ignores. */
async function writeCache() {
  await mkdir(CACHE, { recursive: true });
  await writeFile(join(CACHE, "index-v5"), "cached\n");
}

/** Copies the workspace payload of the skill to its install path, as apply would write it. */
async function writePackagedSkill() {
  const artifact = artifactForId(SKILL_ID);
  assert.ok(artifact);
  await cp(join(artifactsRoot, SKILL_ID, artifact.payload), SKILL, { recursive: true });
}

/** @param {Awaited<ReturnType<typeof deriveProjectPhase>>} result @param {string} id */
function unrecordedFilesOf(result, id) {
  const artifact = result.artifacts.find((item) => item.id === id);
  assert.ok(artifact, `no artifact ${id}`);
  return artifact.unrecordedFiles;
}

test("without an artifact cache, an unrecorded output is listed with nothing compared, and no package is resolved", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await mkdir(SKILL, { recursive: true });
    await writeFile(join(SKILL, "SKILL.md"), "the person's own skill\n");
    const registry = recordingRegistry();

    const result = await deriveProjectPhase({ config: CONFIG, registry });

    assert.deepEqual(unrecordedFilesOf(result, SKILL_ID), [
      { path: SKILL, comparedVersion: null, matches: null },
    ]);
    assert.deepEqual(registry.requests, []);
    // The phase stays as the selection without a lock entry makes it.
    assert.equal(result.phase, "composed");
    assert.equal(result.artifacts[0]?.condition.name, "pending");
  });
});

test("with an artifact cache, an unrecorded output is compared offline against a copy of the cache, which is removed afterward", async () => {
  await inProject(async (directory) => {
    await writeRecipe([SKILL_ID]);
    await writeCache();
    await writePackagedSkill();
    const before = await snapshotDirectory(".calavera");
    const registry = recordingRegistry();

    const result = await deriveProjectPhase({ config: CONFIG, registry });

    assert.deepEqual(unrecordedFilesOf(result, SKILL_ID), [
      { path: SKILL, comparedVersion: "0.1.0", matches: true },
    ]);
    // One offline lookup on the artifact's channel, against a cache outside the project.
    assert.equal(registry.requests.length, 1);
    const [request] = registry.requests;
    assert.equal(request?.id, SKILL_ID);
    assert.equal(request?.offline, true);
    assert.equal(request?.tag, "latest");
    assert.equal(request?.version, undefined);
    assert.ok(request?.cache, "the lookup named no cache");
    assert.ok(!request.cache.startsWith(directory), request.cache);
    // The copy sits in its own named temporary folder, which the leftover check looks for.
    assert.match(request.cache, /[\\/]calavera-phase-cache-[^\\/]+[\\/]cache$/);
    // The copy held the project's cache, and it is gone once the function returns.
    assert.equal(await fileExists(request.cache), false, request.cache);
    // The project's cache and records are unchanged, byte for byte.
    assert.deepEqual(await snapshotDirectory(".calavera"), before);
  });
});

test("an unrecorded output that differs from the cached package is listed as not matching", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await writeCache();
    await writePackagedSkill();
    await writeFile(join(SKILL, "SKILL.md"), "the person's own skill\n");

    const result = await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() });

    assert.deepEqual(unrecordedFilesOf(result, SKILL_ID), [
      { path: SKILL, comparedVersion: "0.1.0", matches: false },
    ]);
  });
});

test("a cache that does not hold the package leaves the output uncompared, and the copy is still removed", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await writeCache();
    await writePackagedSkill();
    const notCached = Object.assign(new Error("not in the cache"), { code: "ENOTCACHED" });
    const registry = recordingRegistry({ fail: notCached });

    const result = await deriveProjectPhase({ config: CONFIG, registry });

    assert.deepEqual(unrecordedFilesOf(result, SKILL_ID), [
      { path: SKILL, comparedVersion: null, matches: null },
    ]);
    const [request] = registry.requests;
    assert.ok(request);
    assert.equal(await fileExists(request.cache), false, request.cache);
  });
});

test("an unlocked artifact with no file on disk lists nothing and reads no cache", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await writeCache();
    const registry = recordingRegistry();
    const result = await deriveProjectPhase({ config: CONFIG, registry });
    assert.deepEqual(unrecordedFilesOf(result, SKILL_ID), []);
    assert.deepEqual(registry.requests, []);
  });
});

test("a registry or cache error with a code, or an error that is not a programming error, leaves the output uncompared", async () => {
  for (const fail of [
    // npm-pick-manifest's TypeError, which the registry client gives a code (#993).
    Object.assign(new TypeError("unreadable package document"), { code: "EBADPACKUMENT" }),
    // artifact-core's own refusal of a cached package, which has no code.
    new Error("Resolved package identity mismatch."),
  ]) {
    await inProject(async () => {
      await writeRecipe([SKILL_ID]);
      await writeCache();
      await writePackagedSkill();
      const result = await deriveProjectPhase({
        config: CONFIG,
        registry: recordingRegistry({ fail }),
      });
      assert.deepEqual(
        unrecordedFilesOf(result, SKILL_ID),
        [{ path: SKILL, comparedVersion: null, matches: null }],
        fail.message,
      );
    });
  }
});

test("an error without a code, such as a programming error, still stops the function", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await writeCache();
    await writePackagedSkill();
    const registry = recordingRegistry({ fail: new TypeError("a bug") });

    await assert.rejects(deriveProjectPhase({ config: CONFIG, registry }), TypeError);
    const [request] = registry.requests;
    assert.ok(request);
    assert.equal(await fileExists(request.cache), false, request.cache);
  });
});

test("each output of a hook is compared on its own", async () => {
  await inProject(async () => {
    await writeRecipe([HOOK_ID]);
    await writeCache();
    const [hook] = (await deriveProjectPhase({ config: CONFIG })).artifacts;
    const [script, fragment] = hook?.outputs.map(({ path }) => path) ?? [];
    assert.ok(script && fragment);
    const artifact = artifactForId(HOOK_ID);
    assert.ok(artifact);
    const payload = join(artifactsRoot, HOOK_ID, artifact.payload);
    await mkdir(join(script, ".."), { recursive: true });
    await cp(join(payload, "hook.mjs"), script);
    // Only the script on disk: it is compared, and the absent fragment is not listed.
    assert.deepEqual(
      unrecordedFilesOf(
        await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() }),
        HOOK_ID,
      ),
      [{ path: script, comparedVersion: "0.3.0", matches: true }],
    );
    await writeFile(fragment, "{}\n");

    const result = await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() });

    assert.deepEqual(unrecordedFilesOf(result, HOOK_ID), [
      { path: script, comparedVersion: "0.3.0", matches: true },
      { path: fragment, comparedVersion: "0.3.0", matches: false },
    ]);

    // An output that cannot be read, such as a folder where the fragment belongs, is listed
    // without a verdict, and the function goes on.
    await rm(fragment);
    await mkdir(fragment);
    const unreadable = await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() });
    assert.deepEqual(unrecordedFilesOf(unreadable, HOOK_ID), [
      { path: script, comparedVersion: "0.3.0", matches: true },
      { path: fragment, comparedVersion: "0.3.0", matches: null },
    ]);
  });
});

test("an artifact whose outputs are recorded, or that has a lock entry, lists no unrecorded output", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await applyRecipeObject(
      recipeWith([SKILL_ID]),
      { json: true, noInstall: true, assumeYes: true },
      stubRegistry(new Map([[SKILL_ID, "0.1.0"]])),
    );
    const registry = recordingRegistry();
    assert.deepEqual(
      unrecordedFilesOf(await deriveProjectPhase({ config: CONFIG, registry }), SKILL_ID),
      [],
    );

    // A lock entry with an output that has no state record is the unrecorded error, with no note.
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    state.aiArtifacts = [];
    await writeFile(".calavera/state.json", `${JSON.stringify(state, null, 2)}\n`);
    const result = await deriveProjectPhase({ config: CONFIG, registry });
    assert.equal(result.artifacts[0]?.condition.name, "unrecorded");
    assert.deepEqual(unrecordedFilesOf(result, SKILL_ID), []);
    assert.deepEqual(registry.requests, []);
  });
});

test("a pending transaction reads no cache", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await writeCache();
    await writePackagedSkill();
    await writeFile(".calavera/artifact-transaction.json", "{}\n");
    const registry = recordingRegistry();
    const result = await deriveProjectPhase({ config: CONFIG, registry });
    assert.equal(result.phase, "pending-transaction");
    assert.deepEqual(registry.requests, []);
  });
});

test("the function leaves no temporary folder behind", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await writeCache();
    await writePackagedSkill();
    const prefix = "calavera-phase-cache-";
    const leftovers = async () =>
      (await readdir(tmpdir())).filter((name) => name.startsWith(prefix)).length;
    const before = await leftovers();
    await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() });
    assert.equal(await leftovers(), before);
  });
});
