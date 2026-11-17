// Issue #603: `apply --config <path>` with a recipe saved outside the project copies it, byte for
// byte, into the project root as calavera.config.json, so `update`, `doctor`, `clean`, and a later
// `apply` with no flags find it. The dry run lists the copy and writes nothing. An existing,
// different calavera.config.json is a hard stop. The owner decision of 2026-11-14 sets the project
// root: the current directory, which must contain a package.json; otherwise apply refuses and
// names the directory, and it does not offer to create package.json.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtempDisposable, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { applyRecipe } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { snapshotDirectory } from "./project-snapshot.mjs";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const CLI_TIMEOUT_MS = 30_000;
// Indented with four spaces and without a final newline, unlike anything Calavera writes, so a
// copy that re-serializes the recipe is not byte-identical.
const recipeText = JSON.stringify(buildRecipe("minimal", ["editorconfig"], "npm", [], {}), null, 4);

/**
 * A downloads folder that holds the recipe and, next to it, a project folder. The project holds a
 * package.json unless `withPackageJSON` is false.
 *
 * @param {{ withPackageJSON?: boolean }} [options]
 */
async function downloadedRecipe({ withPackageJSON = true } = {}) {
  const root = await mkdtempDisposable(join(tmpdir(), "calavera-outside-config-"));
  // On macOS the temporary folder is reached through a symbolic link, and process.cwd() reports
  // the resolved path, so the paths apply prints are compared with the resolved paths.
  const resolvedRoot = await realpath(root.path);
  const downloads = join(resolvedRoot, "Downloads");
  const project = join(resolvedRoot, "project");
  await mkdir(downloads);
  await mkdir(project);
  await writeFile(join(downloads, "calavera.config.json"), recipeText);
  if (withPackageJSON) {
    await writeFile(join(project, "package.json"), `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
  }

  return {
    source: join(downloads, "calavera.config.json"),
    project,
    // The project as the temporary folder names it, before any symbolic link is resolved.
    unresolvedProject: join(root.path, "project"),
    [Symbol.asyncDispose]: () => root[Symbol.asyncDispose](),
  };
}

/**
 * Runs `callback` with `directory` as the working directory.
 *
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

/** @param {string} config @param {{ dryRun?: boolean }} [options] */
function applyOptions(config, { dryRun = false } = {}) {
  return {
    command: "apply",
    config,
    dryRun,
    json: true,
    noInstall: true,
    assumeYes: true,
    reownManagedFiles: [],
  };
}

/**
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, timeout: CLI_TIMEOUT_MS, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

test("a dry run with an outside --config lists the copy and writes nothing", async () => {
  await using fixture = await downloadedRecipe();
  const before = await snapshotDirectory(fixture.project);

  const result = await inDirectory(fixture.project, () =>
    applyRecipe(applyOptions(fixture.source, { dryRun: true })),
  );

  assert.deepEqual(
    result.changes.filter(({ path }) => path === "calavera.config.json"),
    [
      {
        type: "write",
        path: "calavera.config.json",
        action: "write",
        ownership: "project",
        from: fixture.source,
      },
    ],
  );
  assert.deepEqual(await snapshotDirectory(fixture.project), before);
});

test("the dry run's text output names the copy and its source", async () => {
  await using fixture = await downloadedRecipe();

  const { code, stdout, stderr } = await runCli(fixture.project, [
    "apply",
    "--config",
    fixture.source,
    "--dry-run",
    "--no-install",
    "--yes",
  ]);

  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes(`Would copy ${fixture.source} to calavera.config.json`), stdout);
  assert.deepEqual(await readdir(fixture.project), ["package.json"]);
});

test("apply with an outside --config copies the recipe byte for byte and applies it", async () => {
  await using fixture = await downloadedRecipe();

  const result = await inDirectory(fixture.project, () =>
    applyRecipe(applyOptions(fixture.source)),
  );

  assert.equal(await readFile(join(fixture.project, "calavera.config.json"), "utf8"), recipeText);
  assert.ok(
    result.changes.some(({ path, type }) => path === ".editorconfig" && type === "write"),
    "the recipe is applied",
  );
  assert.equal(await readFile(fixture.source, "utf8"), recipeText, "the source is not changed");

  // A later apply with no --config reads the copy, and finds nothing to change.
  const again = await inDirectory(fixture.project, () =>
    applyRecipe(applyOptions("calavera.config.json")),
  );
  assert.ok(again.changes.length > 0);
  assert.deepEqual(
    again.changes.filter(({ type }) => type !== "unchanged"),
    [],
  );
});

test("apply's text output names the copy and its source", async () => {
  await using fixture = await downloadedRecipe();

  const { code, stdout, stderr } = await runCli(fixture.project, [
    "apply",
    "--config",
    fixture.source,
    "--no-install",
    "--yes",
  ]);

  assert.equal(code, 0, stderr);
  assert.ok(stdout.includes(`Copied ${fixture.source} to calavera.config.json`), stdout);
  assert.equal(await readFile(join(fixture.project, "calavera.config.json"), "utf8"), recipeText);
});

test("apply with the same outside --config again reports the copy unchanged", async () => {
  await using fixture = await downloadedRecipe();
  await inDirectory(fixture.project, () => applyRecipe(applyOptions(fixture.source)));

  const again = await inDirectory(fixture.project, () =>
    applyRecipe(applyOptions(fixture.source, { dryRun: true })),
  );

  assert.deepEqual(
    again.changes.filter(({ path }) => path === "calavera.config.json"),
    [
      {
        type: "unchanged",
        path: "calavera.config.json",
        action: "write",
        ownership: "project",
        from: fixture.source,
      },
    ],
  );
});

for (const dryRun of [true, false]) {
  test(`an existing, different calavera.config.json is a hard stop (dryRun: ${dryRun})`, async () => {
    await using fixture = await downloadedRecipe();
    const localRecipe = `${JSON.stringify(buildRecipe("minimal", ["knip"], "npm", [], {}), null, 2)}\n`;
    await writeFile(join(fixture.project, "calavera.config.json"), localRecipe);
    const before = await snapshotDirectory(fixture.project);

    await assert.rejects(
      inDirectory(fixture.project, () => applyRecipe(applyOptions(fixture.source, { dryRun }))),
      (error) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.includes(fixture.source), error.message);
        assert.ok(
          error.message.includes(join(fixture.project, "calavera.config.json")),
          error.message,
        );
        assert.match(error.message, /stopped before writing anything/);
        return true;
      },
    );
    assert.deepEqual(await snapshotDirectory(fixture.project), before);
  });
}

for (const dryRun of [true, false]) {
  test(`a directory without package.json is refused, naming the directory and the check (dryRun: ${dryRun})`, async () => {
    await using fixture = await downloadedRecipe({ withPackageJSON: false });

    const { code, stdout, stderr } = await runCli(fixture.project, [
      "apply",
      "--config",
      fixture.source,
      ...(dryRun ? ["--dry-run"] : []),
      "--no-install",
    ]);

    assert.notEqual(code, 0);
    const output = `${stdout}${stderr}`;
    assert.ok(output.includes(fixture.project), output);
    assert.match(output, /no package\.json/);
    assert.doesNotMatch(output, /Create a default package\.json/);
    assert.deepEqual(await readdir(fixture.project), []);
  });
}

for (const [name, config] of [
  ["the default relative path", () => "calavera.config.json"],
  ["an absolute path", (fixture) => join(fixture.project, "calavera.config.json")],
  [
    "a path through a symbolic link",
    (fixture) => join(fixture.unresolvedProject, "calavera.config.json"),
  ],
]) {
  test(`--config naming the project's own calavera.config.json by ${name} copies nothing`, async () => {
    await using fixture = await downloadedRecipe();
    await writeFile(join(fixture.project, "calavera.config.json"), recipeText);
    const before = await snapshotDirectory(fixture.project);

    const result = await inDirectory(fixture.project, () =>
      applyRecipe(applyOptions(config(fixture), { dryRun: true })),
    );

    assert.deepEqual(
      result.changes.filter(({ path }) => path === "calavera.config.json"),
      [],
    );
    assert.deepEqual(await snapshotDirectory(fixture.project), before);
  });
}

test("an answer typed during apply is recorded in the project's copy, not in the outside recipe", async () => {
  await using fixture = await copyReleaseFixture("library");
  await using downloads = await mkdtempDisposable(join(tmpdir(), "calavera-outside-config-"));
  const source = join(await realpath(downloads.path), "calavera.config.json");
  const strykerRecipeText = JSON.stringify(buildRecipe("minimal", ["stryker"], "pnpm"), null, 4);
  await writeFile(source, strykerRecipeText);
  const project = await realpath(fixture.root);
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

  let result;
  try {
    result = await inDirectory(project, () =>
      applyRecipe({
        ...applyOptions(source),
        json: false,
        assumeYes: false,
        askForTestRunner: {
          testRunner: async () => "node:test",
          testFiles: async () => [],
        },
      }),
    );
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete (/** @type {any} */ (process.stdin).isTTY);
  }

  assert.deepEqual(
    result.changes.filter(({ path }) => path === "calavera.config.json"),
    [
      {
        type: "write",
        path: "calavera.config.json",
        action: "write",
        ownership: "project",
        from: source,
      },
    ],
  );
  const copied = JSON.parse(await readFile(join(project, "calavera.config.json"), "utf8"));
  assert.equal(copied.integrationOptions?.stryker?.testRunner, "node:test");
  assert.equal(await readFile(source, "utf8"), strykerRecipeText, "the source is not changed");
});
