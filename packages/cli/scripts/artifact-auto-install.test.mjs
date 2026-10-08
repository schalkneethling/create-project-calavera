// Issue #605: a project without a lock entry for a selected artifact previews and applies the
// recipe. Apply installs the unlocked selections first, through the same staging and transaction
// as `artifacts install`, and stops on a conflict or failure without changing the project.
import assert from "node:assert/strict";
import fsPromises, {
  cp,
  mkdir,
  mkdtempDisposable,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { hashArtifactPayload } from "@schalkneethling/calavera-artifact-core/registry";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { snapshotDirectory as snapshot } from "./project-snapshot.mjs";

const artifactPackagesRoot = fileURLToPath(new URL("../../artifacts/", import.meta.url));
const LOCK_PATH = ".calavera/artifacts.lock.json";

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

/** @param {string[]} ids */
function recipeWith(ids) {
  return { ...buildRecipe("minimal", [], "npm"), ai: ids.map((id) => ({ id })) };
}

/**
 * A registry stand-in that serves the workspace payload of each artifact at the version in
 * `releases`, and records every resolve request.
 *
 * @param {Map<string, string>} releases
 * @param {{ failFor?: string, error?: Error, registry?: { host: string, source: string }, warnings?: string[] }} [options]
 */
function stubRegistry(releases, options = {}) {
  /** @type {{ id: string, version?: string }[]} */
  const requests = [];
  return {
    requests,
    resolve: async (
      /** @type {{ id: string, tag?: string, version?: string, cache: string }} */ request,
    ) => {
      requests.push({ id: request.id, version: request.version });
      if (request.id === options.failFor) throw options.error;
      const artifact = artifactForId(request.id);
      assert.ok(artifact, `Unknown artifact ${request.id}`);
      const version = request.version ?? releases.get(request.id);
      assert.ok(version, `No release for ${request.id}`);
      return {
        artifact,
        packageName: artifact.packageName,
        version,
        resolved: `https://registry.example/${request.id}-${version}.tgz`,
        integrity: `sha512-${"a".repeat(86)}==`,
        tag: request.tag ?? "latest",
        cache: request.cache,
        offline: false,
        ...(options.registry ? { registry: options.registry } : {}),
        ...(options.warnings ? { warnings: options.warnings } : {}),
      };
    },
    extract: async (
      /** @type {{ artifact: { id: string } }} */ resolution,
      /** @type {string} */ destination,
    ) => {
      const artifact = artifactForId(resolution.artifact.id);
      assert.ok(artifact);
      const payloadPath = join(destination, artifact.payload);
      await mkdir(dirname(payloadPath), { recursive: true });
      await cp(join(artifactPackagesRoot, artifact.id, artifact.payload), payloadPath, {
        recursive: true,
      });
      return {
        manifest: { type: artifact.type, payload: artifact.payload },
        payloadPath,
        payloadHash: await hashArtifactPayload(payloadPath),
      };
    },
  };
}

/**
 * Runs `callback` in a new temporary project that holds only a package.json.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-auto-install-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    await writeFile(
      "package.json",
      `${JSON.stringify({ name: "fixture", scripts: {} }, null, 2)}\n`,
    );
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

async function readLock() {
  return JSON.parse(await readFile(LOCK_PATH, "utf8"));
}

/** @param {{ id: string, version: string }[]} entries */
function idsAndVersions(entries) {
  return entries.map(({ id, version }) => ({ id, version }));
}

test("apply --dry-run without a lock reports the artifacts it would lock and writes nothing", async () => {
  await inProject(async () => {
    const registry = stubRegistry(
      new Map([
        ["skill-project-goal", "0.1.0"],
        ["hook-block-dangerous-commands", "0.4.0"],
      ]),
    );
    const before = await snapshot();

    const result = await applyRecipeObject(
      recipeWith(["skill-project-goal", "hook-block-dangerous-commands"]),
      { ...applyOptions, dryRun: true },
      registry,
    );

    assert.deepEqual(idsAndVersions(result.autoInstalledArtifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
      { id: "hook-block-dangerous-commands", version: "0.4.0" },
    ]);
    assert.equal(
      result.autoInstalledArtifacts[0].package,
      "@schalkneethling/calavera-skill-project-goal",
    );
    const aiWrites = result.changes.filter(({ category }) => category === "ai");
    assert.deepEqual(aiWrites.map(({ path }) => path).sort(), [
      ".agents/hooks/claude-code/block-dangerous-commands.mjs",
      ".agents/hooks/claude-code/block-dangerous-commands.settings-fragment.json",
      ".agents/skills/project-goal",
    ]);
    assert.equal(
      result.changes.filter(({ path }) => path === ".agents/skills/project-goal").length,
      1,
      "each planned artifact write is reported once",
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("apply --dry-run reports the registry artifacts resolve from and the npm configuration warnings", async () => {
  await inProject(async () => {
    const registry = stubRegistry(
      new Map([
        ["skill-project-goal", "0.1.0"],
        ["hook-block-dangerous-commands", "0.4.0"],
      ]),
      {
        registry: { host: "npm.example.com", source: "project .npmrc" },
        warnings: ["Ignored //npm.example.com/:_authToken in the project .npmrc."],
      },
    );
    const recipe = recipeWith(["skill-project-goal", "hook-block-dangerous-commands"]);

    const result = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry);
    assert.deepEqual(result.artifactRegistries, [
      { host: "npm.example.com", source: "project .npmrc" },
    ]);
    assert.deepEqual(result.artifactWarnings, [
      "Ignored //npm.example.com/:_authToken in the project .npmrc.",
    ]);

    const preview = await callMcpTool("dry_run_apply", { recipe }, registry);
    assert.deepEqual(preview.result.artifactRegistries, result.artifactRegistries);
    assert.deepEqual(preview.result.artifactWarnings, result.artifactWarnings);

    await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
    const install = await runArtifactCommand(
      {
        config: "calavera.config.json",
        dryRun: true,
        artifactAction: "install",
      },
      registry,
    );
    assert.deepEqual(install.registries, result.artifactRegistries);
    assert.deepEqual(install.warnings, result.artifactWarnings);
  });
});

test("apply --dry-run reports no registry when the resolver gives none", async () => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    const result = await applyRecipeObject(
      recipeWith(["skill-project-goal"]),
      { ...applyOptions, dryRun: true },
      registry,
    );
    assert.deepEqual(result.artifactRegistries, []);
    assert.deepEqual(result.artifactWarnings, []);
  });
});

test("apply without a lock installs, locks, and applies the selected artifacts", async () => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));

    const result = await applyRecipeObject(
      recipeWith(["skill-project-goal"]),
      applyOptions,
      registry,
    );

    assert.deepEqual(idsAndVersions(result.autoInstalledArtifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    const lock = await readLock();
    assert.deepEqual(idsAndVersions(lock.artifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    const artifact = artifactForId("skill-project-goal");
    assert.ok(artifact);
    const storePayload = join(".calavera/packages/skill-project-goal/0.1.0", artifact.payload);
    assert.equal(await hashArtifactPayload(storePayload), lock.artifacts[0].payloadHash);
    assert.equal(
      await hashArtifactPayload(".agents/skills/project-goal"),
      await hashArtifactPayload(storePayload),
    );
    assert.ok(
      result.changes.some(
        ({ path, category }) => path === ".agents/skills/project-goal" && category === "ai",
      ),
      "the apply result names the artifact output it wrote",
    );
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.ok(state.aiArtifacts.some(({ path }) => path === ".agents/skills/project-goal"));

    const packageJSON = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(packageJSON.dependencies, undefined);
    assert.equal(packageJSON.devDependencies, undefined);
    await assert.rejects(() => stat("node_modules"), /ENOENT/);

    const reapplied = await applyRecipeObject(
      recipeWith(["skill-project-goal"]),
      applyOptions,
      registry,
    );
    assert.deepEqual(reapplied.autoInstalledArtifacts, []);
  });
});

test("auto-install keeps locked artifacts at their exact locked versions", async () => {
  await inProject(async () => {
    const releases = new Map([["skill-project-goal", "0.1.0"]]);
    const registry = stubRegistry(releases);
    await applyRecipeObject(recipeWith(["skill-project-goal"]), applyOptions, registry);

    releases.set("skill-project-goal", "0.2.0");
    releases.set("skill-code-review", "0.3.0");
    registry.requests.length = 0;
    const result = await applyRecipeObject(
      recipeWith(["skill-project-goal", "skill-code-review"]),
      applyOptions,
      registry,
    );

    assert.deepEqual(idsAndVersions(result.autoInstalledArtifacts), [
      { id: "skill-code-review", version: "0.3.0" },
    ]);
    assert.deepEqual(idsAndVersions((await readLock()).artifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
      { id: "skill-code-review", version: "0.3.0" },
    ]);
    assert.equal(
      registry.requests.some(({ id, version }) => id === "skill-project-goal" && !version),
      false,
      "a locked artifact is never resolved without its locked version",
    );
    await assert.rejects(() => stat(".calavera/packages/skill-project-goal/0.2.0"), /ENOENT/);
  });
});

test("apply installs the artifact versions an approved dry run reported, even after the tag moves", async () => {
  await inProject(async () => {
    const releases = new Map([["skill-project-goal", "0.1.0"]]);
    const registry = stubRegistry(releases);
    const recipe = recipeWith(["skill-project-goal"]);
    const preview = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry);

    releases.set("skill-project-goal", "0.2.0");
    registry.requests.length = 0;
    const result = await applyRecipeObject(
      recipe,
      { ...applyOptions, approvedArtifacts: preview.autoInstalledArtifacts },
      registry,
    );

    assert.deepEqual(idsAndVersions(result.autoInstalledArtifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.deepEqual(idsAndVersions((await readLock()).artifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.deepEqual(registry.requests, [{ id: "skill-project-goal", version: "0.1.0" }]);
  });
});

test("an untracked file at an artifact destination stops apply and dry run without changes", async () => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    await mkdir(".agents/skills/project-goal", { recursive: true });
    await writeFile(".agents/skills/project-goal/SKILL.md", "my own skill\n");
    const before = await snapshot();

    for (const dryRun of [true, false]) {
      await assert.rejects(
        () =>
          applyRecipeObject(
            recipeWith(["skill-project-goal"]),
            { ...applyOptions, dryRun },
            registry,
          ),
        (/** @type {Error} */ error) => {
          assert.match(error.message, /artifacts install/);
          assert.match(error.message, /skill-project-goal/);
          assert.match(
            error.message,
            /the artifact lock, artifact outputs, and Calavera state were not changed/,
          );
          assert.ok(error.cause instanceof Error);
          assert.match(
            error.cause.message,
            /Refusing to overwrite existing AI artifact: \.agents\/skills\/project-goal\. It is not recorded as Calavera-managed\./,
          );
          return true;
        },
      );
      assert.deepEqual(await snapshot(), before, `dryRun=${dryRun} left the project unchanged`);
    }
  });
});

test("a locally edited artifact output without a lock entry stops apply without changes", async () => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    await mkdir(".agents/skills/project-goal", { recursive: true });
    await writeFile(".agents/skills/project-goal/SKILL.md", "edited after install\n");
    await mkdir(".calavera", { recursive: true });
    await writeFile(
      ".calavera/state.json",
      `${JSON.stringify({
        version: 1,
        aiArtifacts: [
          {
            type: "skill",
            name: "project-goal",
            source: "skill-project-goal",
            path: ".agents/skills/project-goal",
            hash: "0".repeat(64),
          },
        ],
      })}\n`,
    );
    const before = await snapshot();

    await assert.rejects(
      () => applyRecipeObject(recipeWith(["skill-project-goal"]), applyOptions, registry),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /artifacts install/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /It appears to have local edits/);
        return true;
      },
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("a failed auto-install leaves the project unchanged and preserves the cause", async () => {
  await inProject(async () => {
    const registryError = new Error("registry.example is unreachable");
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]), {
      failFor: "skill-code-review",
      error: registryError,
    });
    await writeFile("calavera.config.json", "{}\n");
    const before = await snapshot();

    /** @type {Error | undefined} */
    let installError;
    await assert.rejects(
      () =>
        applyRecipeObject(
          recipeWith(["skill-project-goal", "skill-code-review"]),
          applyOptions,
          registry,
        ),
      (/** @type {Error} */ error) => {
        installError = error;
        return true;
      },
    );
    assert.ok(installError);
    assert.equal(installError.cause, registryError);
    assert.match(installError.message, /registry\.example is unreachable/);
    assert.match(installError.message, /artifacts install/);
    assert.deepEqual(await snapshot(), before);

    // A conflict and a registry failure stay distinguishable after wrapping.
    await mkdir(".agents/skills/project-goal", { recursive: true });
    await writeFile(".agents/skills/project-goal/SKILL.md", "my own skill\n");
    await assert.rejects(
      () => applyRecipeObject(recipeWith(["skill-project-goal"]), applyOptions, registry),
      (/** @type {Error} */ error) => {
        assert.notEqual(error.message, installError?.message);
        assert.doesNotMatch(error.message, /unreachable/);
        return true;
      },
    );
  });
});

test("dry_run_apply and apply_recipe auto-install unlocked artifacts the same way", async () => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    const recipe = recipeWith(["skill-project-goal"]);
    const before = await snapshot();

    const preview = await callMcpTool("dry_run_apply", { recipe }, registry);
    assert.deepEqual(idsAndVersions(preview.result.autoInstalledArtifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.deepEqual(await snapshot(), before);

    const applied = await callMcpTool("apply_recipe", { recipe, noInstall: true }, registry);
    assert.deepEqual(idsAndVersions(applied.result.autoInstalledArtifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.deepEqual(idsAndVersions((await readLock()).artifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.equal((await stat(".agents/skills/project-goal/SKILL.md")).isFile(), true);
  });
});

/**
 * Snapshot without `.calavera/.staging/`, where restoring a locked payload stages before this
 * change and leaves the directory behind on failure.
 */
async function snapshotWithoutRestoreStaging() {
  return Object.fromEntries(
    Object.entries(await snapshot()).filter(([path]) => !path.startsWith(".calavera/.staging")),
  );
}

test("a local edit to a locked artifact stops apply before an unlocked artifact is installed", async () => {
  await inProject(async () => {
    const releases = new Map([["skill-project-goal", "0.1.0"]]);
    const registry = stubRegistry(releases);
    await applyRecipeObject(recipeWith(["skill-project-goal"]), applyOptions, registry);
    await writeFile(".agents/skills/project-goal/SKILL.md", "local edit\n");
    releases.set("skill-code-review", "0.3.0");
    const before = await snapshot();

    await assert.rejects(
      () =>
        applyRecipeObject(
          recipeWith(["skill-project-goal", "skill-code-review"]),
          applyOptions,
          registry,
        ),
      (/** @type {Error} */ error) => {
        assert.match(
          error.message,
          /Apply stopped before installing the unlocked artifacts this recipe selects \(skill-code-review\)/,
        );
        assert.match(error.message, /artifacts install/);
        assert.ok(error.cause instanceof Error);
        assert.match(
          error.cause.message,
          /Refusing to overwrite existing AI artifact: \.agents\/skills\/project-goal\. It appears to have local edits/,
        );
        return true;
      },
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("a locked payload that cannot be restored stops apply before an unlocked artifact is installed", async () => {
  await inProject(async () => {
    await applyRecipeObject(
      recipeWith(["skill-project-goal"]),
      applyOptions,
      stubRegistry(new Map([["skill-project-goal", "0.1.0"]])),
    );
    await rm(".calavera/packages", { recursive: true });
    const offlineMiss = new Error("ENOTCACHED: skill-project-goal is not in the offline cache");
    const registry = stubRegistry(new Map([["skill-code-review", "0.3.0"]]), {
      failFor: "skill-project-goal",
      error: offlineMiss,
    });
    const before = await snapshotWithoutRestoreStaging();

    await assert.rejects(
      () =>
        applyRecipeObject(
          recipeWith(["skill-project-goal", "skill-code-review"]),
          applyOptions,
          registry,
        ),
      (/** @type {Error} */ error) => error === offlineMiss,
    );
    assert.equal(
      registry.requests.some(({ id }) => id === "skill-code-review"),
      false,
      "the unlocked artifact is not resolved once a locked payload fails",
    );
    assert.deepEqual(await snapshotWithoutRestoreStaging(), before);
  });
});

/**
 * Makes `rename` fail for the artifact output `.agents/skills/code-review`, so the artifact
 * transaction fails after it has moved the package into place, and optionally makes `rm` fail for
 * that package so the rollback fails too.
 *
 * @param {import("node:test").TestContext} t
 * @param {{ failRollback?: boolean }} [options]
 */
function failCommitPartway(t, options = {}) {
  const rename = fsPromises.rename;
  const remove = fsPromises.rm;
  t.mock.method(fsPromises, "rename", (/** @type {string} */ from, /** @type {string} */ to) =>
    String(to).endsWith(join(".agents", "skills", "code-review"))
      ? Promise.reject(new Error("ENOSPC: no space left on device"))
      : rename(from, to),
  );
  if (options.failRollback) {
    t.mock.method(
      fsPromises,
      "rm",
      (/** @type {string} */ path, /** @type {import("node:fs").RmOptions} */ rmOptions) =>
        String(path).endsWith(join(".calavera", "packages", "skill-code-review", "0.3.0"))
          ? Promise.reject(new Error("EBUSY: resource busy"))
          : remove(path, rmOptions),
    );
  }
  syncBuiltinESMExports();
  t.after(() => {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  });
}

test("a commit that fails part way is rolled back and leaves the project unchanged", async (t) => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-code-review", "0.3.0"]]));
    const before = await snapshot();
    failCommitPartway(t);

    await assert.rejects(
      () => applyRecipeObject(recipeWith(["skill-code-review"]), applyOptions, registry),
      (/** @type {Error} */ error) => {
        assert.match(error.message, /Could not install the unlocked artifacts/);
        assert.ok(error.cause instanceof Error);
        assert.match(error.cause.message, /ENOSPC/);
        return true;
      },
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("a failed rollback reports both the install failure and the rollback failure", async (t) => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-code-review", "0.3.0"]]));
    failCommitPartway(t, { failRollback: true });

    await assert.rejects(
      () => applyRecipeObject(recipeWith(["skill-code-review"]), applyOptions, registry),
      (/** @type {AggregateError} */ error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map(({ message }) => message.split(":")[0]),
          ["ENOSPC", "EBUSY"],
        );
        assert.equal(error.cause, error.errors[0]);
        assert.match(error.message, /ENOSPC/);
        assert.match(error.message, /Rollback failure: EBUSY/);
        assert.match(
          error.message,
          /Run create-project-calavera apply or any create-project-calavera artifacts command to retry the rollback\./,
        );
        return true;
      },
    );
    await stat(".calavera/artifact-transaction.json");
  });
});

test("a dry run with locked and unlocked artifacts reports only the unlocked ones", async () => {
  await inProject(async () => {
    const releases = new Map([["skill-project-goal", "0.1.0"]]);
    const registry = stubRegistry(releases);
    await applyRecipeObject(recipeWith(["skill-project-goal"]), applyOptions, registry);
    releases.set("skill-project-goal", "0.2.0");
    releases.set("skill-code-review", "0.3.0");
    const before = await snapshot();

    const result = await applyRecipeObject(
      recipeWith(["skill-project-goal", "skill-code-review"]),
      { ...applyOptions, dryRun: true },
      registry,
    );

    assert.deepEqual(idsAndVersions(result.autoInstalledArtifacts), [
      { id: "skill-code-review", version: "0.3.0" },
    ]);
    assert.deepEqual(
      result.changes.filter(({ category }) => category === "ai").map(({ path }) => path),
      [".agents/skills/code-review"],
    );
    assert.deepEqual(await snapshot(), before);
  });
});

test("a legacy type and src selection without a lock is auto-installed", async () => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    const recipe = {
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ type: "skill", src: "skills/project-goal" }],
    };
    const before = await snapshot();

    const preview = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry);
    assert.deepEqual(idsAndVersions(preview.autoInstalledArtifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.deepEqual(await snapshot(), before);

    const applied = await applyRecipeObject(recipe, applyOptions, registry);
    assert.deepEqual(idsAndVersions(applied.autoInstalledArtifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.deepEqual(idsAndVersions((await readLock()).artifacts), [
      { id: "skill-project-goal", version: "0.1.0" },
    ]);
    assert.equal(
      await hashArtifactPayload(".agents/skills/project-goal"),
      await hashArtifactPayload(
        join(artifactPackagesRoot, "skill-project-goal", "payload", "project-goal"),
      ),
    );
  });
});

test("a directory cleanup failure after a rollback is reported with the install failure", async (t) => {
  await inProject(async () => {
    const registry = stubRegistry(new Map([["skill-code-review", "0.3.0"]]));
    failCommitPartway(t);
    const removeDirectory = fsPromises.rmdir;
    t.mock.method(fsPromises, "rmdir", (/** @type {string} */ path) =>
      path === join(".agents", "skills")
        ? Promise.reject(
            Object.assign(new Error("EACCES: permission denied, rmdir '.agents/skills'"), {
              code: "EACCES",
            }),
          )
        : removeDirectory(path),
    );
    syncBuiltinESMExports();

    await assert.rejects(
      () => applyRecipeObject(recipeWith(["skill-code-review"]), applyOptions, registry),
      (/** @type {AggregateError} */ error) => {
        assert.ok(error instanceof AggregateError);
        assert.deepEqual(
          error.errors.map(({ message }) => message.split(":")[0]),
          ["ENOSPC", "EACCES"],
        );
        assert.equal(error.cause, error.errors[0]);
        assert.match(error.message, /the artifact lock, artifact outputs, and Calavera state/);
        assert.match(error.message, /empty directories may remain: EACCES/);
        return true;
      },
    );
    await assert.rejects(() => stat(".calavera"), /ENOENT/);
    await assert.rejects(() => stat(".agents/skills/code-review"), /ENOENT/);
  });
});
