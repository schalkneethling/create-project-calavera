// Issue #734, ADR-0014, and the owner's decision of 2026-11-09 on #734: the stryker integration
// writes a managed stryker.config.json and a test:mutation script in a project that Vite+
// manages, stops at a workspace root and in a project Vite+ does not manage, and warns when no
// file matches Vitest's default test pattern. Each case applies to a temporary copy of a
// committed vp create fixture, never to the fixture itself.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { integrationCatalog } from "../src/catalog.js";
import { callMcpTool } from "../src/mcp.js";
import { textHash } from "../src/utils/hash.js";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  readStubInvocations,
  writeVitePlusStub,
} from "./vite-plus-fixtures.mjs";

const strykerDependencies = ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"];
// The config issue #734 verified with Stryker 10.0.0 and 10.1.1. Apply formats it with the
// project's own vp fmt, so the test compares the parsed value and the recorded hash.
const strykerConfig = {
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "vitest",
  plugins: ["@stryker-mutator/vitest-runner"],
  tsconfigFile: "stryker-skips-tsconfig-preprocessing.json",
  reporters: ["clear-text", "html"],
};
const strykerBlock = [
  "# calavera:stryker:start",
  ".stryker-tmp/",
  "reports/mutation/",
  "# calavera:stryker:end",
];

/**
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const originalDirectory = process.cwd();
  process.chdir(directory);

  try {
    return await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * Every file under `root`, keyed by its path relative to `root`.
 *
 * @param {string} root
 * @returns {Promise<Map<string, Buffer>>}
 */
async function snapshotTree(root) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = new Map();

  for (const entry of entries.filter((candidate) => candidate.isFile())) {
    const path = join(entry.parentPath, entry.name);
    files.set(relative(root, path), await readFile(path));
  }

  return files;
}

/** @param {string[]} tools */
async function composeRecipe(tools) {
  const { recipe } = await callMcpTool("compose_recipe", {
    profile: "minimal",
    packageManager: "pnpm",
    tools,
  });
  return recipe;
}

/** @param {Array<{ kind: string, severity: string }>} findings */
const noTestFindings = (findings) => findings.filter(({ kind }) => kind === "no-vitest-test-files");

test("vp create library: the dry run plans the Stryker setup, apply writes it, and a second dry run reports no drift", async () => {
  await using fixture = await copyReleaseFixture("library");
  // The committed fixture has no test file, and vp create now ships tests/index.test.ts.
  await mkdir(join(fixture.root, "tests"));
  await writeFile(join(fixture.root, "tests/index.test.ts"), "export {};\n");

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["editorconfig", "knip", "stryker"]);
    const before = await snapshotTree(fixture.root);

    const dryRun = await callMcpTool("dry_run_apply", { recipe });
    const { changes, dependencies, installCommand, ignoreChanges, projectInspection } =
      dryRun.result;

    assert.ok(
      changes.some(
        ({ type, path, ownership }) =>
          type === "write" && path === "stryker.config.json" && ownership === "calavera",
      ),
      JSON.stringify(changes),
    );
    assert.ok(
      changes
        .find(({ type, path }) => type === "update" && path === "package.json")
        ?.scripts?.includes("test:mutation"),
      "the dry run does not plan test:mutation",
    );
    for (const dependency of strykerDependencies) {
      assert.ok(dependencies.includes(dependency), `${dependency} is not installed`);
    }
    assert.equal(installCommand, `vp add -D ${dependencies.join(" ")}`);
    assert.deepEqual(
      ignoreChanges.filter(({ integration }) => integration === "stryker"),
      [
        {
          path: ".gitignore",
          integration: "stryker",
          type: "update",
          lines: [".stryker-tmp/", "reports/mutation/"],
        },
      ],
    );
    assert.deepEqual(noTestFindings(projectInspection.findings), []);
    assert.deepEqual(await snapshotTree(fixture.root), before, "the dry run changed a file");

    const applied = await callMcpTool("apply_recipe", { recipe, noInstall: true });
    assert.deepEqual(applied.result.changes, changes);

    const configText = await readFile("stryker.config.json", "utf8");
    assert.deepEqual(JSON.parse(configText), strykerConfig);
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(
      state.managedFiles.find(({ path }) => path === "stryker.config.json")?.hash,
      textHash(configText),
    );

    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    assert.equal(manifest.scripts["test:mutation"], "stryker run");
    // ADR-0014 Decision 3: Stryker stays out of quality.
    assert.equal(manifest.scripts.quality, "vp check && vp test --passWithNoTests && pnpm knip");
    assert.doesNotMatch(manifest.scripts.quality, /stryker|test:mutation/);
    assert.deepEqual(
      (await readFile(".gitignore", "utf8")).trimEnd().split("\n").slice(-strykerBlock.length),
      strykerBlock,
    );

    const secondDryRun = await callMcpTool("dry_run_apply", { recipe });
    assert.deepEqual(
      secondDryRun.result.changes,
      changes.map((change) => ({ ...change, type: "unchanged" })),
    );
    assert.deepEqual(
      secondDryRun.result.projectInspection.findings.filter(({ severity }) => severity !== "info"),
      [],
    );
  });
});

test("vp create library: a local edit to stryker.config.json is a managed-file conflict", async () => {
  await using fixture = await copyReleaseFixture("library");

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["stryker"]);
    await callMcpTool("apply_recipe", { recipe, noInstall: true });
    const edited = `${JSON.stringify({ ...strykerConfig, reporters: ["progress"] }, null, 2)}\n`;
    await writeFile("stryker.config.json", edited);

    const inspection = await callMcpTool("inspect_project", { recipe });
    assert.ok(
      inspection.findings.some(
        ({ kind, path }) => kind === "managed-file-conflict" && path === "stryker.config.json",
      ),
      JSON.stringify(inspection.findings),
    );
    const conflict = /Refusing to overwrite existing managed file: stryker\.config\.json/;
    await assert.rejects(callMcpTool("dry_run_apply", { recipe }), conflict);
    await assert.rejects(callMcpTool("apply_recipe", { recipe, noInstall: true }), conflict);
    assert.equal(await readFile("stryker.config.json", "utf8"), edited);
  });
});

test("vp create library: the dry run warns, without stopping, when no file matches Vitest's default test pattern", async () => {
  await using fixture = await copyReleaseFixture("library");

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["stryker"]);

    const withoutTests = await callMcpTool("dry_run_apply", { recipe });
    assert.deepEqual(
      noTestFindings(withoutTests.result.projectInspection.findings).map(
        ({ severity, message }) => ({ severity, message }),
      ),
      [
        {
          severity: "warning",
          message:
            'No file in this project matches Vitest\'s default test pattern, "**/*.{test,spec}.?(c|m)[jt]s?(x)", so stryker has no tests to run, and its run stops with an error until the project has Vitest tests. A project whose Vite config sets test.include to other files can ignore this warning.',
        },
      ],
    );
    const inspection = await callMcpTool("inspect_project", { recipe });
    assert.equal(noTestFindings(inspection.findings).length, 1);

    // Vitest's default exclude: a test file under node_modules does not count.
    await mkdir("node_modules/dependency", { recursive: true });
    await writeFile("node_modules/dependency/index.test.js", "");
    const dependencyTestOnly = await callMcpTool("dry_run_apply", { recipe });
    assert.equal(noTestFindings(dependencyTestOnly.result.projectInspection.findings).length, 1);

    for (const testFile of ["src/index.spec.mts", "tests/index.test.ts", "src/view.test.jsx"]) {
      await mkdir(join(testFile, ".."), { recursive: true });
      await writeFile(testFile, "export {};\n");
      const withTests = await callMcpTool("dry_run_apply", { recipe });
      assert.deepEqual(
        noTestFindings(withTests.result.projectInspection.findings),
        [],
        `${testFile} does not count as a test file`,
      );
      await rm(testFile);
    }
  });
});

test("a project that Vite+ does not manage stops on stryker, names vp create and vp migrate, and writes nothing", async () => {
  await using fixture = await createTemporaryFixture("stryker-unmanaged", {
    "package.json": `${JSON.stringify({ name: "plain", private: true }, null, 2)}\n`,
    "src/index.test.js": "",
  });
  const before = await snapshotTree(fixture.root);

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["editorconfig", "stryker"]);
    const refusal =
      "stryker needs a project that Vite+ manages, because it runs the project's tests with the Vitest that vite-plus installs, and Vite+ does not manage this project. The dry run and apply stop before writing anything. Run vp create or vp migrate to adopt Vite+, then apply again, or remove stryker from this recipe.";
    const refuses = (/** @type {unknown} */ error) =>
      error instanceof Error && error.message === refusal;

    const inspection = await callMcpTool("inspect_project", { recipe });
    assert.deepEqual(
      inspection.findings.filter(({ kind }) => kind === "vite-plus-required"),
      [{ severity: "error", kind: "vite-plus-required", message: refusal }],
    );
    await assert.rejects(callMcpTool("dry_run_apply", { recipe }), refuses);
    await assert.rejects(callMcpTool("apply_recipe", { recipe, noInstall: true }), refuses);

    // Without stryker the same project applies, so the stop belongs to stryker alone.
    const withoutStryker = await composeRecipe(["editorconfig"]);
    await callMcpTool("dry_run_apply", { recipe: withoutStryker });
  });

  assert.deepEqual(await snapshotTree(fixture.root), before, "the refusal changed a file");
});

test("vp create monorepo root: stryker stops, tells the person to apply it in each member, and writes nothing", async () => {
  await using fixture = await copyReleaseFixture("monorepo");
  const before = await snapshotTree(fixture.root);

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["editorconfig", "stryker"]);
    const refusal =
      "stryker applies in each workspace member, not at the workspace root, because it runs the tests of the project it is applied to and a workspace root has none of its own. The dry run and apply stop before writing anything. Apply a recipe that selects stryker from each workspace member that has Vitest tests (cd <member> && pnpm dlx create-project-calavera apply --dry-run), and remove stryker from this recipe.";
    const refuses = (/** @type {unknown} */ error) =>
      error instanceof Error && error.message === refusal;

    const inspection = await callMcpTool("inspect_project", { recipe });
    assert.deepEqual(
      inspection.findings.filter(({ kind }) => kind === "workspace-root"),
      [{ severity: "error", kind: "workspace-root", message: refusal }],
    );
    await assert.rejects(callMcpTool("dry_run_apply", { recipe }), refuses);
    await assert.rejects(callMcpTool("apply_recipe", { recipe, noInstall: true }), refuses);
  });

  assert.deepEqual(await snapshotTree(fixture.root), before, "the refusal changed a file");
});

test("vp create monorepo member packages/utils: apply_recipe installs Stryker with vp add -D, without -w, and writes the setup", async () => {
  await using fixture = await copyReleaseFixture("monorepo");
  await using logs = await createTemporaryFixture("stryker-install", {});
  const logPath = join(logs.root, "vp.log");
  const member = join(fixture.root, "packages/utils");
  await writeVitePlusStub(fixture.root, { logPath });

  await inDirectory(member, async () => {
    const recipe = await composeRecipe(["stryker"]);
    const dryRun = await callMcpTool("dry_run_apply", { recipe });
    assert.equal(dryRun.result.installCommand, `vp add -D ${strykerDependencies.join(" ")}`);

    await callMcpTool("apply_recipe", { recipe });
    assert.deepEqual(
      (await readStubInvocations(logPath)).map(({ argv, cwd }) => ({ argv, cwd })),
      [{ argv: ["add", "-D", ...strykerDependencies], cwd: member }],
    );
    assert.deepEqual(JSON.parse(await readFile("stryker.config.json", "utf8")), strykerConfig);
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts["test:mutation"],
      "stryker run",
    );
  });
});

test("every catalog appliesAt value is one apply acts on, runsProjectTests is a boolean, and each test runner names its Stryker plugin", () => {
  for (const { id, appliesAt, runsProjectTests, testRunners } of integrationCatalog) {
    assert.ok(
      appliesAt === undefined || ["repository-root", "package"].includes(appliesAt),
      `${id} declares appliesAt ${appliesAt}, which apply ignores`,
    );
    assert.ok(
      runsProjectTests === undefined || typeof runsProjectTests === "boolean",
      `${id} declares runsProjectTests ${runsProjectTests}`,
    );
    for (const runner of testRunners ?? []) {
      assert.ok(runner.testFiles.length > 0, `${id} ${runner.id} lists no test files`);
      // Knip's Stryker plugin maps testRunner to @stryker-mutator/<testRunner>-runner, so the
      // installed plugin is not reported as unused.
      assert.deepEqual(
        runner.dependencies,
        [`@stryker-mutator/${runner.strykerTestRunner}-runner`],
        `${id} ${runner.id}`,
      );
    }
  }
});

test("vp create monorepo root: a packageManager override does not get past the workspace-root stop", async () => {
  await using fixture = await copyReleaseFixture("monorepo");
  const before = await snapshotTree(fixture.root);

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["stryker"]);
    // npm reads workspaces in package.json, which the pnpm fixture does not declare.
    await assert.rejects(
      callMcpTool("dry_run_apply", { recipe, packageManager: "npm" }),
      /^Error: stryker applies in each workspace member, not at the workspace root/,
    );
    await assert.rejects(
      callMcpTool("apply_recipe", { recipe, packageManager: "npm", noInstall: true }),
      /^Error: stryker applies in each workspace member, not at the workspace root/,
    );
  });

  assert.deepEqual(await snapshotTree(fixture.root), before, "the refusal changed a file");
});

test("the root of an npm workspace that Vite+ manages stops on stryker and writes nothing", async () => {
  await using fixture = await createTemporaryFixture("stryker-npm-workspace", {
    "package.json": `${JSON.stringify(
      {
        name: "npm-workspace",
        private: true,
        workspaces: ["packages/*"],
        devDependencies: { "vite-plus": "1.5.1" },
      },
      null,
      2,
    )}\n`,
    "packages/utils/package.json": `${JSON.stringify({ name: "utils" }, null, 2)}\n`,
    "packages/utils/tests/index.test.ts": "export {};\n",
  });
  const before = await snapshotTree(fixture.root);

  await inDirectory(fixture.root, async () => {
    const { recipe } = await callMcpTool("compose_recipe", {
      profile: "minimal",
      packageManager: "npm",
      tools: ["stryker"],
    });
    const refusal =
      "stryker applies in each workspace member, not at the workspace root, because it runs the tests of the project it is applied to and a workspace root has none of its own. The dry run and apply stop before writing anything. Apply a recipe that selects stryker from each workspace member that has Vitest tests (cd <member> && npm create project-calavera apply -- --dry-run), and remove stryker from this recipe.";
    await assert.rejects(
      callMcpTool("dry_run_apply", { recipe }),
      (/** @type {unknown} */ error) => error instanceof Error && error.message === refusal,
    );
  });

  assert.deepEqual(await snapshotTree(fixture.root), before, "the refusal changed a file");
});

test("vp create monorepo: a new member without a package.json is planned, because its workspace is managed", async () => {
  await using fixture = await copyReleaseFixture("monorepo");
  const member = join(fixture.root, "packages/new");
  await mkdir(join(member, "tests"), { recursive: true });
  await writeFile(join(member, "tests/index.test.ts"), "export {};\n");

  await inDirectory(member, async () => {
    const dryRun = await callMcpTool("dry_run_apply", { recipe: await composeRecipe(["stryker"]) });
    assert.equal(dryRun.result.vitePlus.status, "unknown");
    assert.ok(
      dryRun.result.changes.some(({ path }) => path === "stryker.config.json"),
      JSON.stringify(dryRun.result.changes),
    );
    assert.deepEqual(
      dryRun.result.projectInspection.findings.filter(({ severity }) => severity === "error"),
      [],
    );
  });
});

test("vp create library: with HTML Validate, the Stryker report folder is in .htmlvalidateignore", async () => {
  await using fixture = await copyReleaseFixture("library");

  await inDirectory(fixture.root, async () => {
    await callMcpTool("apply_recipe", {
      recipe: await composeRecipe(["html-validate", "stryker"]),
      noInstall: true,
    });
    assert.deepEqual((await readFile(".htmlvalidateignore", "utf8")).trimEnd().split("\n"), [
      "node_modules/",
      "dist/",
      "coverage/",
      ".claude/worktrees/",
      "reports/mutation/",
    ]);
  });
});

test("vp create library: doctor reports a missing stryker.config.json", async () => {
  await using fixture = await copyReleaseFixture("library");
  const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["editorconfig", "stryker"]);
    await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
    await callMcpTool("apply_recipe", { recipe, noInstall: true });
    const missing = (/** @type {{ issues: Array<{ message: string }> }} */ report) =>
      report.issues.some(({ message }) =>
        message.startsWith("Missing managed file: stryker.config.json."),
      );
    const doctor = () =>
      JSON.parse(
        execFileSync(process.execPath, [cliPath, "doctor", "--json"], {
          encoding: "utf8",
          env: { ...process.env, NO_COLOR: "1" },
        }),
      );

    assert.equal(missing(doctor()), false);
    await rm("stryker.config.json");
    assert.equal(missing(doctor()), true);

    // Without stryker in the recipe, a missing stryker.config.json is not doctor's concern.
    const withoutStryker = await composeRecipe(["editorconfig"]);
    await writeFile("calavera.config.json", `${JSON.stringify(withoutStryker, null, 2)}\n`);
    assert.equal(missing(doctor()), false);
  });
});

test("an existing Stryker config of the person's own is reported, whichever name Stryker reads", async () => {
  for (const name of ["stryker.conf.cjs", ".stryker.config.mjs", "stryker.config.json"]) {
    await using fixture = await createTemporaryFixture("stryker-existing-config", {
      "package.json": `${JSON.stringify({ name: "own", devDependencies: { "vite-plus": "1.5.1" } }, null, 2)}\n`,
      [name]: "{}\n",
    });

    await inDirectory(fixture.root, async () => {
      const inspection = await callMcpTool("inspect_project", {
        recipe: await composeRecipe(["stryker"]),
      });
      assert.deepEqual(
        inspection.findings
          .filter(({ kind }) => kind === "existing-config")
          .map(({ path }) => path),
        [name],
      );
      assert.equal(await readFile(name, "utf8"), "{}\n");
    });
  }
});
