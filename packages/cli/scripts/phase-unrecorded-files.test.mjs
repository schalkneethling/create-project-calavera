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
  lstat,
  realpath,
  rm,
  symlink,
  chmod,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
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
  const registry = {
    requests,
    /** @type {boolean[]} */
    cacheWasLink: [],
    resolve: async (/** @type {(typeof requests)[number]} */ request) => {
      requests.push(request);
      registry.cacheWasLink.push((await lstat(request.cache)).isSymbolicLink());
      if (fail) throw fail;
      return stub.resolve(request);
    },
    extract: stub.extract,
  };
  return registry;
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
      {
        path: SKILL,
        comparedVersion: null,
        matches: null,
        notCompared: "there is no artifact cache",
      },
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
      { path: SKILL, comparedVersion: "0.1.0", matches: true, notCompared: null },
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
      { path: SKILL, comparedVersion: "0.1.0", matches: false, notCompared: null },
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
      {
        path: SKILL,
        comparedVersion: null,
        matches: null,
        notCompared: "the artifact cache cannot supply it offline (ENOTCACHED)",
      },
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
  for (const { fail, notCompared } of [
    // npm-pick-manifest's TypeError, which the registry client gives a code (#993).
    {
      fail: Object.assign(new TypeError("unreadable package document"), {
        code: "EBADPACKUMENT",
      }),
      notCompared: "the artifact cache cannot supply it offline (EBADPACKUMENT)",
    },
    // artifact-core's own refusal of a cached package, which has no code: it is told apart from
    // a cache miss, so a tampered cache does not read like one.
    {
      fail: new Error("Resolved package identity mismatch."),
      notCompared: "Calavera refused the package the artifact cache holds",
    },
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
        [{ path: SKILL, comparedVersion: null, matches: null, notCompared }],
        fail.message,
      );
    });
  }
});

test("a linked cache is copied as files, so the lookup never reads the project's cache", async () => {
  await using elsewhere = await mkdtempDisposable(join(tmpdir(), "calavera-linked-cache-"));
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await writeFile(join(elsewhere.path, "index-v5"), "cached\n");
    await mkdir(".calavera/cache", { recursive: true });
    await symlink(elsewhere.path, CACHE, "dir");
    await writePackagedSkill();
    const registry = recordingRegistry();

    const result = await deriveProjectPhase({ config: CONFIG, registry });

    assert.deepEqual(registry.cacheWasLink, [false]);
    assert.equal(unrecordedFilesOf(result, SKILL_ID)[0]?.matches, true);
  });
});

test(
  "a cache that cannot be copied leaves every output uncompared, with the error code, and does not stop the function",
  { skip: process.getuid?.() === 0 ? "root reads every file" : false },
  async () => {
    await inProject(async () => {
      await writeRecipe([SKILL_ID]);
      await writeCache();
      await writePackagedSkill();
      const locked = join(CACHE, "index-v5");
      await chmod(locked, 0o000);
      try {
        const registry = recordingRegistry();
        const result = await deriveProjectPhase({ config: CONFIG, registry });
        assert.deepEqual(unrecordedFilesOf(result, SKILL_ID), [
          {
            path: SKILL,
            comparedVersion: null,
            matches: null,
            notCompared: "Calavera could not copy the artifact cache (EACCES)",
          },
        ]);
        assert.deepEqual(registry.requests, []);
      } finally {
        await chmod(locked, 0o644);
      }
    });
  },
);

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
      [{ path: script, comparedVersion: "0.3.0", matches: true, notCompared: null }],
    );
    await writeFile(fragment, "{}\n");

    const result = await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() });

    assert.deepEqual(unrecordedFilesOf(result, HOOK_ID), [
      { path: script, comparedVersion: "0.3.0", matches: true, notCompared: null },
      { path: fragment, comparedVersion: "0.3.0", matches: false, notCompared: null },
    ]);

    // The package's own fragment matches, so each output is compared with its own file in the
    // package, not with the script's.
    await cp(join(payload, "settings-fragment.json"), fragment);
    assert.deepEqual(
      unrecordedFilesOf(
        await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() }),
        HOOK_ID,
      ),
      [
        { path: script, comparedVersion: "0.3.0", matches: true, notCompared: null },
        { path: fragment, comparedVersion: "0.3.0", matches: true, notCompared: null },
      ],
    );

    // An output that cannot be read, such as a folder where the fragment belongs, is listed
    // without a verdict, and the function goes on.
    await rm(fragment);
    await mkdir(fragment);
    const unreadable = await deriveProjectPhase({ config: CONFIG, registry: recordingRegistry() });
    assert.deepEqual(unrecordedFilesOf(unreadable, HOOK_ID), [
      { path: script, comparedVersion: "0.3.0", matches: true, notCompared: null },
      {
        path: fragment,
        comparedVersion: "0.3.0",
        matches: null,
        notCompared: "it cannot be read (EISDIR)",
      },
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

test("a selection without a lock entry whose outputs the state records lists no unrecorded output", async () => {
  await inProject(async () => {
    await writeRecipe([SKILL_ID]);
    await applyRecipeObject(
      recipeWith([SKILL_ID]),
      { json: true, noInstall: true, assumeYes: true },
      stubRegistry(new Map([[SKILL_ID, "0.1.0"]])),
    );
    // The state still records the skill, but the lock has no entry for it, as after the lock
    // was deleted: the recorded output is not unrecorded, so it gets no note and no lookup.
    await rm(".calavera/artifacts.lock.json");
    await writeCache();
    const registry = recordingRegistry();
    const result = await deriveProjectPhase({ config: CONFIG, registry });
    const artifact = result.artifacts.find(({ id }) => id === SKILL_ID);
    assert.equal(artifact?.lockEntry, null);
    assert.equal(artifact?.condition.name, "pending");
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
    const registry = recordingRegistry();
    await deriveProjectPhase({ config: CONFIG, registry });
    // The exact folder this call made, which holds the cache copy and the staged package, so
    // other runs that make the same kind of folder in parallel cannot change the result.
    const [request] = registry.requests;
    assert.ok(request);
    const folder = dirname(request.cache);
    assert.match(basename(folder), /^calavera-phase-cache-/);
    assert.equal(await fileExists(folder), false, folder);
  });
});
