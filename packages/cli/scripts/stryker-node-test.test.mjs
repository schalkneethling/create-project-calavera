// Issue #736 and the owner's decision of 2026-11-10: the stryker integration also runs a project's
// node:test tests, through Stryker's tap runner, when the recipe sets
// integrationOptions.stryker.testRunner to "node:test". Vitest stays the default, and the litmus
// test still holds: the project must be one that Vite+ manages (ADR-0009, ADR-0014). Each case
// applies to a temporary copy of a committed vp create fixture, never to the fixture itself.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import Ajv2020 from "ajv/dist/2020.js";

import { integrationCatalog } from "../src/catalog.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { textHash } from "../src/utils/hash.js";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  readStubInvocations,
  writeVitePlusStub,
} from "./vite-plus-fixtures.mjs";

const execFileAsync = promisify(execFile);

// The files node --test runs when it is given no paths, in Node.js 24 and 26, including the
// TypeScript patterns that both match because they strip types by default.
const nodeTestFiles = [
  "**/{*.test,*-test,*_test,test-*,test}.{cjs,mjs,js,cts,mts,ts}",
  "**/test/**/*.{cjs,mjs,js,cts,mts,ts}",
];
const nodeArgs = ["--test-reporter=tap", "-r", "{{hookFile}}", "{{testFile}}"];
const tapDependencies = ["@stryker-mutator/core", "@stryker-mutator/tap-runner"];
/** @param {string[]} testFiles */
const tapConfig = (testFiles) => ({
  $schema: "./node_modules/@stryker-mutator/core/schema/stryker-schema.json",
  testRunner: "tap",
  plugins: ["@stryker-mutator/tap-runner"],
  tap: { testFiles, nodeArgs },
  tsconfigFile: "stryker-skips-tsconfig-preprocessing.json",
  reporters: ["clear-text", "html"],
});
const tapRunnerNote = `stryker runs the project's node:test tests through @stryker-mutator/tap-runner, so stryker.config.json sets testRunner to "tap", tap.testFiles to "${nodeTestFiles.join('", "')}", and tap.nodeArgs to "${nodeArgs.join('", "')}". The tap runner measures coverage inside each test file's own process, so code that a test reaches only through a child process does not count as covered by that test: Stryker reports a mutant there as not covered, or as survived when another test file covers it, although that test might kill it. Check those mutants by hand.`;
const nodeTestIndex = `import assert from "node:assert/strict";
import test from "node:test";

import { fn } from "../src/index.ts";

test("fn greets", () => {
  assert.equal(fn(), "Hello, tsdown!");
});
`;
const strykerCli = fileURLToPath(
  new URL("bin/stryker.js", import.meta.resolve("@stryker-mutator/core/package.json")),
);

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

/**
 * @param {string[]} tools
 * @param {Record<string, unknown>} [strykerOptions]
 */
async function composeRecipe(tools, strykerOptions = { testRunner: "node:test" }) {
  const { recipe } = await callMcpTool("compose_recipe", {
    profile: "minimal",
    packageManager: "pnpm",
    tools,
    integrationOptions: { stryker: strykerOptions },
  });
  return recipe;
}

/** @param {Array<{ kind: string }>} findings @param {string} kind */
const findingsOf = (findings, kind) =>
  findings
    .filter((finding) => finding.kind === kind)
    .map(({ severity, message }) => ({
      severity,
      message,
    }));

test("integrationOptions.stryker records only a runner other than Vitest, in the recipe and the published schema", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL("../../../apps/composer/public/calavera.config.schema.json", import.meta.url),
      "utf8",
    ),
  );
  const validate = new Ajv2020({ allErrors: true, validateFormats: false }).compile(schema);
  /** @param {unknown} options */
  const build = (options) => buildRecipe("minimal", ["stryker"], "pnpm", [], { stryker: options });

  assert.equal(build({ testRunner: "vitest" }).integrationOptions, undefined);
  assert.equal(build({}).integrationOptions, undefined);
  for (const options of [
    { testRunner: "node:test" },
    { testRunner: "node:test", testFiles: ["scripts/*.test.mjs"] },
  ]) {
    const recipe = build(options);
    assert.deepEqual(recipe.integrationOptions, { stryker: options });
    assert.equal(validate(recipe), true, JSON.stringify(validate.errors));
  }

  const rejected = [
    {
      options: { testRunner: "jest" },
      message:
        'integrationOptions.stryker.testRunner is "jest", but Calavera sets Stryker up for these test runners only: "vitest", "node:test". Use one of them, or remove stryker from this recipe.',
    },
    {
      options: { testFiles: ["tests/*.test.ts"] },
      message:
        'integrationOptions.stryker.testFiles applies only when testRunner is "node:test", because Stryker\'s Vitest runner reads the test files from the Vite config. Remove testFiles, or set testRunner to "node:test".',
    },
    {
      options: { testRunner: "node:test", testFiles: [] },
      message:
        "integrationOptions.stryker.testFiles must list at least one glob, and each must be a non-empty string. Record the paths that the project's test script passes to node --test, or remove testFiles to use the files node --test runs by default.",
    },
    {
      options: { testRunner: "node:test", testFiles: [""] },
      message:
        "integrationOptions.stryker.testFiles must list at least one glob, and each must be a non-empty string. Record the paths that the project's test script passes to node --test, or remove testFiles to use the files node --test runs by default.",
    },
    {
      options: { testRunner: "node:test", reporter: "tap" },
      message: "Unknown integrationOptions.stryker fields: reporter.",
    },
    ...["/srv/**/*.test.js", "../shared/*.test.js", "tests/../../x.test.js"].map((glob) => ({
      options: { testRunner: "node:test", testFiles: ["tests/*.test.js", glob] },
      message: `integrationOptions.stryker.testFiles must stay inside the project, but ${JSON.stringify(glob)} starts at the file system root or leaves the project through "..". Write each glob relative to the folder that holds package.json, such as "tests/**/*.test.ts".`,
    })),
  ];
  for (const { options, message } of rejected) {
    assert.throws(() => build(options), { message });
    const recipe = {
      ...buildRecipe("minimal", ["stryker"], "pnpm"),
      integrationOptions: { stryker: options },
    };
    assert.equal(validate(recipe), false, `the schema accepts ${JSON.stringify(options)}`);
  }

  // The schema is static JSON, so this keeps its runner list in step with the catalog.
  assert.deepEqual(
    schema.$defs.strykerOptions.properties.testRunner.enum,
    integrationCatalog.find(({ id }) => id === "stryker").testRunners.map(({ id }) => id),
  );

  assert.throws(
    () => buildRecipe("minimal", ["knip"], "pnpm", [], { stryker: { testRunner: "node:test" } }),
    { message: "integrationOptions.stryker requires the stryker integration." },
  );
  assert.equal(
    validate({
      ...buildRecipe("minimal", ["knip"], "pnpm"),
      integrationOptions: { stryker: { testRunner: "node:test" } },
    }),
    false,
  );
});

test("vp create library with node:test tests: the dry run names the tap runner and its config, apply writes it, and a second dry run reports no drift", async () => {
  await using fixture = await copyReleaseFixture("library");
  await mkdir(join(fixture.root, "tests"));
  await writeFile(join(fixture.root, "tests/index.test.ts"), nodeTestIndex);

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["stryker"]);
    assert.deepEqual(recipe.integrationOptions, { stryker: { testRunner: "node:test" } });
    const before = await snapshotTree(fixture.root);

    const dryRun = await callMcpTool("dry_run_apply", { recipe });
    const { changes, dependencies, installCommand, projectInspection } = dryRun.result;
    assert.deepEqual(dependencies, tapDependencies);
    assert.equal(installCommand, `vp add -D ${tapDependencies.join(" ")}`);
    assert.ok(
      changes.some(
        ({ type, path, ownership }) =>
          type === "write" && path === "stryker.config.json" && ownership === "calavera",
      ),
      JSON.stringify(changes),
    );
    assert.deepEqual(findingsOf(projectInspection.findings, "test-runner"), [
      { severity: "info", message: tapRunnerNote },
    ]);
    assert.deepEqual(findingsOf(projectInspection.findings, "no-node-test-files"), []);
    assert.deepEqual(await snapshotTree(fixture.root), before, "the dry run changed a file");

    const explained = await callMcpTool("explain_recipe", { recipe });
    assert.deepEqual(explained.dependencies, tapDependencies);

    await callMcpTool("apply_recipe", { recipe, noInstall: true });
    const configText = await readFile("stryker.config.json", "utf8");
    assert.deepEqual(JSON.parse(configText), tapConfig(nodeTestFiles));
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.equal(
      state.managedFiles.find(({ path }) => path === "stryker.config.json")?.hash,
      textHash(configText),
    );
    assert.equal(
      JSON.parse(await readFile("package.json", "utf8")).scripts["test:mutation"],
      "stryker run",
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

test("vp create library with node:test tests: Stryker's dry run passes with the managed config, and a mutation run kills both mutants", async () => {
  await using fixture = await copyReleaseFixture("library");
  await mkdir(join(fixture.root, "tests"));
  await writeFile(join(fixture.root, "tests/index.test.ts"), nodeTestIndex);

  await inDirectory(fixture.root, async () => {
    await callMcpTool("apply_recipe", {
      recipe: await composeRecipe(["stryker"]),
      noInstall: true,
    });
  });
  // The fixture installs nothing, so Stryker and the tap runner come from this repository's own
  // install, the same release, 10.1.1, that the managed config was verified with. node --test
  // gives this file's process NODE_TEST_CONTEXT, which would make each test process Stryker starts
  // report to a parent test runner instead of printing TAP, so Stryker runs without it, as it does
  // when a person runs test:mutation.
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.NODE_TEST_WORKER_ID;
  const stryker = (/** @type {string[]} */ ...args) =>
    execFileAsync(process.execPath, [strykerCli, "run", ...args], { cwd: fixture.root, env });

  const dryRun = await stryker("--dryRunOnly");
  assert.match(dryRun.stdout, /Initial test run succeeded\. Ran 1 tests/);
  assert.match(dryRun.stdout, /The dry-run has been completed successfully/);

  await stryker("--reporters", "json");
  const report = JSON.parse(
    await readFile(join(fixture.root, "reports/mutation/mutation.json"), "utf8"),
  );
  const statuses = Object.values(report.files).flatMap(({ mutants }) =>
    mutants.map(({ status }) => status),
  );
  assert.deepEqual(statuses, ["Killed", "Killed"]);
});

test("vp create library: the dry run warns, without stopping, when no file matches the files node --test runs by default", async () => {
  await using fixture = await copyReleaseFixture("library");

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["stryker"]);
    const warning = {
      severity: "warning",
      message: `No file in this project matches the files node --test runs by default, "${nodeTestFiles.join('", "')}", so stryker has no tests to run, and its run stops with an error until the project has node:test tests that match them. If the project's test script passes other paths to node --test, record those paths in integrationOptions.stryker.testFiles.`,
    };
    const noTestFiles = async () =>
      findingsOf(
        (await callMcpTool("dry_run_apply", { recipe })).result.projectInspection.findings,
        "no-node-test-files",
      );

    assert.deepEqual(await noTestFiles(), [warning]);
    assert.deepEqual(
      findingsOf((await callMcpTool("inspect_project", { recipe })).findings, "no-node-test-files"),
      [warning],
    );

    // node --test skips node_modules and does not run .spec files, so neither counts.
    await mkdir("node_modules/dependency", { recursive: true });
    await writeFile("node_modules/dependency/index.test.js", "");
    await writeFile("src/index.spec.ts", "export {};\n");
    assert.deepEqual(await noTestFiles(), [warning]);

    for (const testFile of ["tests/index.test.ts", "test/greeting.mjs", "src/parse_test.cjs"]) {
      await mkdir(join(testFile, ".."), { recursive: true });
      await writeFile(testFile, "export {};\n");
      assert.deepEqual(await noTestFiles(), [], `${testFile} does not count as a test file`);
      await rm(testFile);
    }
  });
});

test("vp create library: recorded testFiles go into the config, and the warning checks them instead", async () => {
  await using fixture = await copyReleaseFixture("library");
  const testFiles = ["checks/*.check.mjs"];

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["stryker"], { testRunner: "node:test", testFiles });

    const withoutMatch = await callMcpTool("dry_run_apply", { recipe });
    assert.deepEqual(
      findingsOf(withoutMatch.result.projectInspection.findings, "no-node-test-files"),
      [
        {
          severity: "warning",
          message:
            'No file in this project matches integrationOptions.stryker.testFiles, "checks/*.check.mjs", so stryker has no tests to run, and its run stops with an error until the project has node:test tests that match them. Record the paths that the project\'s test script passes to node --test in integrationOptions.stryker.testFiles.',
        },
      ],
    );
    assert.ok(
      findingsOf(
        withoutMatch.result.projectInspection.findings,
        "test-runner",
      )[0]?.message.includes('tap.testFiles to "checks/*.check.mjs",'),
    );

    await mkdir("checks");
    await writeFile("checks/index.check.mjs", "");
    const withMatch = await callMcpTool("dry_run_apply", { recipe });
    assert.deepEqual(
      findingsOf(withMatch.result.projectInspection.findings, "no-node-test-files"),
      [],
    );

    await callMcpTool("apply_recipe", { recipe, noInstall: true });
    assert.deepEqual(
      JSON.parse(await readFile("stryker.config.json", "utf8")),
      tapConfig(testFiles),
    );
  });
});

test("vp create library: a testFiles glob that matches a folder warns, because the tap runner would run node on the folder", async () => {
  await using fixture = await copyReleaseFixture("library");

  await inDirectory(fixture.root, async () => {
    await mkdir("checks/unit", { recursive: true });
    await writeFile("checks/unit/index.check.mjs", "");
    const recipe = await composeRecipe(["stryker"], {
      testRunner: "node:test",
      testFiles: ["checks/**"],
    });

    const dryRun = await callMcpTool("dry_run_apply", { recipe });
    const { findings } = dryRun.result.projectInspection;
    assert.deepEqual(findingsOf(findings, "node-test-files-folder"), [
      {
        severity: "warning",
        message:
          'integrationOptions.stryker.testFiles matches the folder "checks", and Stryker\'s tap runner runs node on every match, so its run stops with an error. Change the globs so that they match only test files, such as "checks/**/*.test.*".',
      },
    ]);
    assert.deepEqual(findingsOf(findings, "no-node-test-files"), []);

    // A glob that names only files raises no warning.
    const filesOnly = await composeRecipe(["stryker"], {
      testRunner: "node:test",
      testFiles: ["checks/**/*.check.mjs"],
    });
    const clean = await callMcpTool("dry_run_apply", { recipe: filesOnly });
    assert.deepEqual(
      clean.result.projectInspection.findings.filter(({ severity }) => severity === "warning"),
      [],
    );
  });
});

test("vp create library: switching the runner back to Vitest rewrites the managed config and installs the Vitest runner", async () => {
  await using fixture = await copyReleaseFixture("library");
  await mkdir(join(fixture.root, "tests"));
  await writeFile(join(fixture.root, "tests/index.test.ts"), nodeTestIndex);

  await inDirectory(fixture.root, async () => {
    await callMcpTool("apply_recipe", {
      recipe: await composeRecipe(["stryker"]),
      noInstall: true,
    });

    const vitestRecipe = await composeRecipe(["stryker"], { testRunner: "vitest" });
    assert.equal(vitestRecipe.integrationOptions, undefined);
    const dryRun = await callMcpTool("dry_run_apply", { recipe: vitestRecipe });
    assert.deepEqual(dryRun.result.dependencies, [
      "@stryker-mutator/core",
      "@stryker-mutator/vitest-runner",
    ]);
    assert.deepEqual(findingsOf(dryRun.result.projectInspection.findings, "test-runner"), [
      {
        severity: "info",
        message:
          'stryker runs the project\'s Vitest tests through @stryker-mutator/vitest-runner, so stryker.config.json sets testRunner to "vitest". For a project that tests with node:test, set integrationOptions.stryker.testRunner to "node:test".',
      },
    ]);
    assert.ok(
      dryRun.result.changes.some(
        ({ type, path }) => type === "write" && path === "stryker.config.json",
      ),
      JSON.stringify(dryRun.result.changes),
    );

    await callMcpTool("apply_recipe", { recipe: vitestRecipe, noInstall: true });
    assert.equal(JSON.parse(await readFile("stryker.config.json", "utf8")).testRunner, "vitest");
  });
});

test("a project that Vite+ does not manage stops on stryker with node:test, says why, and writes nothing", async () => {
  await using fixture = await createTemporaryFixture("stryker-node-test-unmanaged", {
    "package.json": `${JSON.stringify(
      { name: "plain", private: true, type: "module", scripts: { test: "node --test" } },
      null,
      2,
    )}\n`,
    "src/index.test.js": "",
  });
  const before = await snapshotTree(fixture.root);

  await inDirectory(fixture.root, async () => {
    const recipe = await composeRecipe(["editorconfig", "stryker"]);
    const refusal =
      "stryker needs a project that Vite+ manages, because Calavera provides no JavaScript or TypeScript tooling to a project that has not adopted Vite+, and Vite+ does not manage this project. The dry run and apply stop before writing anything. Run vp create or vp migrate to adopt Vite+, then apply again, or remove stryker from this recipe.";

    assert.deepEqual(
      findingsOf((await callMcpTool("inspect_project", { recipe })).findings, "vite-plus-required"),
      [{ severity: "error", message: refusal }],
    );
    await assert.rejects(callMcpTool("dry_run_apply", { recipe }), { message: refusal });
    await assert.rejects(callMcpTool("apply_recipe", { recipe, noInstall: true }), {
      message: refusal,
    });
  });

  assert.deepEqual(await snapshotTree(fixture.root), before, "the refusal changed a file");
});

test("vp create monorepo: the root stops with node:test named, and a member installs the tap runner with vp add -D", async () => {
  await using fixture = await copyReleaseFixture("monorepo");
  await using logs = await createTemporaryFixture("stryker-node-test-install", {});
  const logPath = join(logs.root, "vp.log");
  const member = join(fixture.root, "packages/utils");
  await writeVitePlusStub(fixture.root, { logPath });

  await inDirectory(fixture.root, async () => {
    await assert.rejects(
      callMcpTool("dry_run_apply", { recipe: await composeRecipe(["stryker"]) }),
      {
        message:
          "stryker applies in each workspace member, not at the workspace root, because it runs the tests of the project it is applied to and a workspace root has none of its own. The dry run and apply stop before writing anything. Apply a recipe that selects stryker from each workspace member that has node:test tests (cd <member> && pnpm dlx create-project-calavera apply --dry-run), and remove stryker from this recipe.",
      },
    );
  });

  await inDirectory(member, async () => {
    await callMcpTool("apply_recipe", { recipe: await composeRecipe(["stryker"]) });
    assert.deepEqual(
      (await readStubInvocations(logPath)).map(({ argv, cwd }) => ({ argv, cwd })),
      [{ argv: ["add", "-D", ...tapDependencies], cwd: member }],
    );
    assert.equal(JSON.parse(await readFile("stryker.config.json", "utf8")).testRunner, "tap");
  });
});
