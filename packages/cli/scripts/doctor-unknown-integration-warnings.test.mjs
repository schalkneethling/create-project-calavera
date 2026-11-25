// Issue #1082: apply refuses a recipe that names an integration the catalog
// does not hold, whatever the Vite+ status, so doctor warns about each such
// id in any project. The #431 warning still covers a removed toolchain id in
// a project Vite+ manages, so that id gets that warning and not this one.
// These warnings stay advisory: doctor writes nothing and exits 0.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { removedProfileWarnings, unknownIntegrationWarnings } from "../src/index.js";
import { detectVitePlus } from "../src/vite-plus-detection.js";
import { snapshotDirectory } from "./project-snapshot.mjs";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  json,
  plainViteConfig,
  plainViteManifest,
} from "./vite-plus-fixtures.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

/**
 * @param {string[]} integrations
 * @param {string} [profile]
 */
function recipe(integrations, profile = "default") {
  return json({
    version: 1,
    profile,
    packageManager: "pnpm",
    integrations,
    scripts: {},
  });
}

/**
 * Runs doctor in `cwd`. execFile rejects on a non-zero exit, so a resolved
 * result also shows that doctor exited 0.
 *
 * @param {string} cwd
 * @param {string[]} [args]
 */
async function runDoctor(cwd, args = []) {
  return execFileAsync(process.execPath, [cliPath, "doctor", ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
  });
}

/**
 * The doctor issues from the recipe check, without the check field, so a test pins the
 * warnings it is about. The phase line and the managed files have their own checks (ADR-0020).
 *
 * @param {string} cwd
 */
async function recipeIssues(cwd) {
  const report = JSON.parse((await runDoctor(cwd, ["--json"])).stdout);
  assert.equal(report.ok, true, "an unknown integration warning must not make doctor fail");
  return report.issues
    .filter((/** @type {{ check: string }} */ { check }) => check === "recipe")
    .map((/** @type {{ level: string, message: string }} */ { level, message }) => ({
      level,
      message,
    }));
}

const unmanaged = { status: "unmanaged", corroborating: [] };
const managed = {
  status: "managed",
  signal: "vite-plus-dependency",
  manifestPath: "/work/repo/package.json",
  corroborating: [],
};

const removedOxlint =
  "c.json selects oxlint, a JavaScript and TypeScript linting integration that Calavera removed (ADR-0002). Vite+ provides linting, and a project without Vite+ runs vp create or vp migrate first (ADR-0009). Remove oxlint from c.json; apply refuses the recipe until you do.";

test("unknownIntegrationWarnings warns once per unknown id and names unrecognized ids by position", () => {
  assert.deepEqual(
    unknownIntegrationWarnings(
      { integrations: ["knip", "oxlint", "not-a-tool", "oxlint", "not-a-tool", "another"] },
      unmanaged,
      "c.json",
    ),
    [
      { level: "warning", message: removedOxlint },
      {
        level: "warning",
        message:
          "c.json integrations[2] is not an integration Calavera knows, so remove it from c.json; apply refuses the recipe until you do.",
      },
      {
        level: "warning",
        message:
          "c.json integrations[5] is not an integration Calavera knows, so remove it from c.json; apply refuses the recipe until you do.",
      },
    ],
  );
});

test("unknownIntegrationWarnings leaves a removed toolchain id to the #431 warning in a project Vite+ manages", () => {
  assert.deepEqual(
    unknownIntegrationWarnings({ integrations: ["oxlint", "not-a-tool"] }, managed, "c.json"),
    [
      {
        level: "warning",
        message:
          "c.json integrations[1] is not an integration Calavera knows, so remove it from c.json; apply refuses the recipe until you do.",
      },
    ],
  );
});

for (const detection of [unmanaged, { status: "unknown", corroborating: [] }]) {
  test(`unknownIntegrationWarnings warns about a removed toolchain id when detection is ${detection.status}`, () => {
    assert.deepEqual(
      unknownIntegrationWarnings({ integrations: ["oxlint"] }, detection, "c.json"),
      [{ level: "warning", message: removedOxlint }],
    );
  });
}

test("unknownIntegrationWarnings returns nothing for a recipe of catalog ids or no integrations", () => {
  assert.deepEqual(
    unknownIntegrationWarnings({ integrations: ["knip", "editorconfig"] }, unmanaged, "c.json"),
    [],
  );
  assert.deepEqual(unknownIntegrationWarnings({}, unmanaged, "c.json"), []);
});

test("doctor warns about each unknown integration in a plain Vite project and writes nothing", async () => {
  await using fixture = await createTemporaryFixture("doctor-unknown-plain-vite", {
    "package.json": json(plainViteManifest),
    "vite.config.ts": plainViteConfig,
    "calavera.config.json": recipe(["editorconfig", "eslint", "made-up", "eslint"]),
  });
  assert.equal((await detectVitePlus(fixture.root)).status, "unmanaged");
  const before = await snapshotDirectory(fixture.root);

  assert.deepEqual(await recipeIssues(fixture.root), [
    {
      level: "warning",
      message:
        "calavera.config.json selects eslint, a JavaScript and TypeScript linting integration that Calavera removed (ADR-0005). Vite+ provides linting, and a project without Vite+ runs vp create or vp migrate first (ADR-0009). Remove eslint from calavera.config.json; apply refuses the recipe until you do.",
    },
    {
      level: "warning",
      message:
        "calavera.config.json integrations[2] is not an integration Calavera knows, so remove it from calavera.config.json; apply refuses the recipe until you do.",
    },
  ]);
  assert.deepEqual(await snapshotDirectory(fixture.root), before, "doctor changed a file");
});

test("doctor prints the unknown integration warning in its human output and exits 0", async () => {
  await using fixture = await createTemporaryFixture("doctor-unknown-human", {
    "package.json": json(plainViteManifest),
    "calavera.config.json": recipe(["prettier"]),
  });

  const { stdout, stderr } = await runDoctor(fixture.root);

  assert.match(
    `${stdout}${stderr}`,
    /calavera\.config\.json selects prettier, a JavaScript and TypeScript formatting integration that Calavera removed \(ADR-0006\)\. Vite\+ provides formatting, and a project without Vite\+ runs vp create or vp migrate first \(ADR-0009\)\./,
  );
});

test("doctor gives a removed id in a vp create project the #431 warning only, and still warns about an unrecognized id", async () => {
  await using fixture = await copyReleaseFixture("library");
  await writeFile(join(fixture.root, "calavera.config.json"), recipe(["oxlint", "made-up"]));

  assert.deepEqual(await recipeIssues(fixture.root), [
    {
      level: "warning",
      message:
        "calavera.config.json selects oxlint, a JavaScript and TypeScript linting integration that Calavera removed. Vite+ manages this project (vite-plus-dependency signal at package.json) and provides linting, so remove oxlint from calavera.config.json; apply refuses the recipe until you do.",
    },
    {
      level: "warning",
      message:
        "calavera.config.json integrations[1] is not an integration Calavera knows, so remove it from calavera.config.json; apply refuses the recipe until you do.",
    },
  ]);
});

for (const profile of ["modern", "classic"]) {
  test(`removedProfileWarnings names the removed ${profile} profile and its replacement`, () => {
    assert.deepEqual(removedProfileWarnings({ profile }, "c.json"), [
      {
        level: "warning",
        message: `c.json names the ${profile} profile, which Calavera removed (ADR-0011), so change profile to default in c.json; apply refuses the recipe until you do.`,
      },
    ]);
  });
}

test("removedProfileWarnings returns nothing for a current profile or none", () => {
  assert.deepEqual(removedProfileWarnings({ profile: "default" }, "c.json"), []);
  assert.deepEqual(removedProfileWarnings({ profile: "minimal" }, "c.json"), []);
  assert.deepEqual(removedProfileWarnings({}, "c.json"), []);
});

test("doctor warns about a removed profile before the integration warnings, as apply checks it first, and exits 0", async () => {
  await using fixture = await copyReleaseFixture("library");
  await writeFile(
    join(fixture.root, "calavera.config.json"),
    recipe(["editorconfig", "oxfmt"], "modern"),
  );
  const before = await snapshotDirectory(fixture.root);

  assert.deepEqual(await recipeIssues(fixture.root), [
    {
      level: "warning",
      message:
        "calavera.config.json names the modern profile, which Calavera removed (ADR-0011), so change profile to default in calavera.config.json; apply refuses the recipe until you do.",
    },
    {
      level: "warning",
      message:
        "calavera.config.json selects oxfmt, a JavaScript and TypeScript formatting integration that Calavera removed. Vite+ manages this project (vite-plus-dependency signal at package.json) and provides formatting, so remove oxfmt from calavera.config.json; apply refuses the recipe until you do.",
    },
  ]);
  assert.deepEqual(await snapshotDirectory(fixture.root), before, "doctor changed a file");
});
