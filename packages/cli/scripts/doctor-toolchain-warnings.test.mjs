// Issue #431: doctor reads the ADR-0001 detection result and, in a project
// Vite+ manages, warns about each JavaScript or TypeScript toolchain
// integration a recipe written before the removals (ADR-0002 to ADR-0006)
// still selects. These warnings stay advisory: doctor writes nothing, and a
// warning alone leaves its exit status at 0 (#1030 covers errors). In a
// project Vite+ does not manage, #1082's unknown integration warning names
// each removed id instead; doctor-unknown-integration-warnings.test.mjs
// covers that warning.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { integrationCatalog, removedToolchainIntegrations } from "../src/catalog.js";
import { removedToolchainWarnings } from "../src/index.js";
import { detectVitePlus } from "../src/vite-plus-detection.js";
import { snapshotDirectory } from "./project-snapshot.mjs";
import {
  isOxfmtId,
  isOxlintId,
  isRemovedToolchainId,
  removedEslintIds,
  removedOxlintIds,
  removedPrettierIds,
  removedTypeScriptConfigId,
} from "./removed-toolchain-ids.mjs";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  json,
  monorepoRootManifest,
  plainViteConfig,
  plainViteManifest,
} from "./vite-plus-fixtures.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

const keptIntegrations = ["editorconfig", "knip", "github-repository-controls"];

/** @param {string[]} integrations */
function recipe(integrations) {
  return json({
    version: 1,
    profile: "default",
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
 * @param {string} cwd
 * @returns {Promise<{ ok: boolean, issues: { level: string, message: string }[] }>}
 */
async function doctorReport(cwd) {
  return JSON.parse((await runDoctor(cwd, ["--json"])).stdout);
}

/**
 * The doctor issues that name a removed toolchain integration, which in a project Vite+ manages is
 * the #431 warning and elsewhere the #1082 unknown integration warning.
 *
 * @param {{ issues: { level: string, message: string }[] }} report
 */
function toolchainIssues(report) {
  return report.issues.filter(({ message }) =>
    removedToolchainIntegrations.some(({ id }) =>
      message.startsWith(`calavera.config.json selects ${id},`),
    ),
  );
}

/**
 * The #431 warnings only: those that say Vite+ manages the project.
 *
 * @param {{ issues: { level: string, message: string }[] }} report
 */
function vitePlusToolchainIssues(report) {
  return toolchainIssues(report).filter(({ message }) =>
    message.includes(". Vite+ manages this project ("),
  );
}

test("the removed toolchain metadata lists exactly the ids ADR-0002 to ADR-0006 removed", () => {
  const ids = removedToolchainIntegrations.map(({ id }) => id);
  const expected = [
    ...removedOxlintIds,
    "oxfmt",
    removedTypeScriptConfigId,
    ...removedEslintIds,
    ...removedPrettierIds,
  ];

  assert.deepEqual([...ids].sort(), [...expected].sort());
  assert.equal(new Set(ids).size, ids.length, "an id is listed twice");
  for (const id of ids) {
    assert.ok(isRemovedToolchainId(id), `${id} is not a removed toolchain id`);
    assert.equal(
      integrationCatalog.some((integration) => integration.id === id),
      false,
      `${id} is still in the catalog`,
    );
  }
});

test("each removed toolchain integration names the ADR that removed it", () => {
  const adr = Object.fromEntries(removedToolchainIntegrations.map(({ id, adr }) => [id, adr]));
  const expected = [
    ...removedOxlintIds.map((id) => [id, "ADR-0002"]),
    ["oxfmt", "ADR-0003"],
    [removedTypeScriptConfigId, "ADR-0004"],
    ...removedEslintIds.map((id) => [id, "ADR-0005"]),
    ...removedPrettierIds.map((id) => [id, "ADR-0006"]),
  ];
  for (const [id, expectedAdr] of expected) assert.equal(adr[id], expectedAdr, id);
});

test("each removed toolchain integration names what Vite+ provides in its place", () => {
  const provides = Object.fromEntries(
    removedToolchainIntegrations.map(({ id, provides }) => [id, provides]),
  );

  for (const id of Object.keys(provides).filter(
    (id) => isOxlintId(id) || removedEslintIds.includes(id),
  )) {
    assert.equal(provides[id], "linting", id);
  }
  for (const id of Object.keys(provides).filter(
    (id) => isOxfmtId(id) || removedPrettierIds.includes(id),
  )) {
    assert.equal(provides[id], "formatting", id);
  }
  assert.equal(provides[removedTypeScriptConfigId], "type-checking");
});

const managedInMember = {
  status: "managed",
  signal: "vite-plus-dependency",
  manifestPath: "/work/repo/package.json",
  corroborating: [],
};

test("removedToolchainWarnings names the integration, the signal, and the recipe path once per id", () => {
  const recipeObject = { integrations: ["eslint", "knip", "oxfmt", "eslint"] };

  assert.deepEqual(removedToolchainWarnings(recipeObject, managedInMember, "config/recipe.json"), [
    {
      level: "warning",
      message:
        "config/recipe.json selects oxfmt, a JavaScript and TypeScript formatting integration that Calavera removed. Vite+ manages this project (vite-plus-dependency signal at /work/repo/package.json) and provides formatting, so remove oxfmt from config/recipe.json; apply refuses the recipe until you do.",
    },
    {
      level: "warning",
      message:
        "config/recipe.json selects eslint, a JavaScript and TypeScript linting integration that Calavera removed. Vite+ manages this project (vite-plus-dependency signal at /work/repo/package.json) and provides linting, so remove eslint from config/recipe.json; apply refuses the recipe until you do.",
    },
  ]);
});

test("removedToolchainWarnings returns nothing for a recipe without integrations", () => {
  assert.deepEqual(removedToolchainWarnings({}, managedInMember, "c.json"), []);
});

for (const detection of [
  { status: "unmanaged", corroborating: [] },
  { status: "unmanaged", corroborating: ["vp-scripts"] },
  { status: "unknown", corroborating: [] },
]) {
  test(`removedToolchainWarnings returns nothing when detection is ${detection.status} (${detection.corroborating.length} corroborating)`, () => {
    assert.deepEqual(
      removedToolchainWarnings(
        { integrations: ["oxlint", "typescript"] },
        detection,
        "calavera.config.json",
      ),
      [],
    );
  });
}

test("doctor warns about each removed toolchain integration in a vp create project", async () => {
  await using fixture = await copyReleaseFixture("library", { vitePlus: false });
  await writeFile(
    join(fixture.root, "calavera.config.json"),
    recipe(["editorconfig", "oxlint", "typescript", "oxlint"]),
  );
  const before = await snapshotDirectory(fixture.root);

  const report = await doctorReport(fixture.root);

  assert.deepEqual(toolchainIssues(report), [
    {
      level: "warning",
      message:
        "calavera.config.json selects oxlint, a JavaScript and TypeScript linting integration that Calavera removed. Vite+ manages this project (vite-plus-dependency signal at package.json) and provides linting, so remove oxlint from calavera.config.json; apply refuses the recipe until you do.",
    },
    {
      level: "warning",
      message:
        "calavera.config.json selects typescript, a JavaScript and TypeScript type-checking integration that Calavera removed. Vite+ manages this project (vite-plus-dependency signal at package.json) and provides type-checking, so remove typescript from calavera.config.json; apply refuses the recipe until you do.",
    },
  ]);
  assert.equal(report.ok, true, "a toolchain warning must not make doctor fail");
  assert.deepEqual(await snapshotDirectory(fixture.root), before, "doctor changed a file");
});

test("doctor prints the toolchain warning in its human output and exits 0", async () => {
  await using fixture = await copyReleaseFixture("library", { vitePlus: false });
  await writeFile(join(fixture.root, "calavera.config.json"), recipe(["prettier"]));
  const before = await snapshotDirectory(fixture.root);

  const { stdout, stderr } = await runDoctor(fixture.root);

  assert.match(
    `${stdout}${stderr}`,
    /calavera\.config\.json selects prettier, a JavaScript and TypeScript formatting integration that Calavera removed\. Vite\+ manages this project \(vite-plus-dependency signal at package\.json\)/,
  );
  assert.deepEqual(await snapshotDirectory(fixture.root), before, "doctor changed a file");
});

test("doctor reports no toolchain warning for a recipe of kept integrations in a vp create project", async () => {
  await using fixture = await copyReleaseFixture("library", { vitePlus: false });
  await writeFile(join(fixture.root, "calavera.config.json"), recipe(keptIntegrations));
  assert.equal((await detectVitePlus(fixture.root)).status, "managed");

  const report = await doctorReport(fixture.root);

  // doctor read the recipe: it names the kept integrations' missing files, and nothing else.
  assert.ok(report.issues.length > 0, "doctor reported no missing managed file");
  for (const { message } of report.issues) {
    assert.match(message, /^Missing managed file: /);
  }
});

test("doctor run from a workspace member names the ancestor manifest that matched", async () => {
  await using fixture = await createTemporaryFixture("doctor-member", {
    "package.json": json(monorepoRootManifest),
    "packages/member/package.json": json({ name: "member", version: "0.0.0" }),
    "packages/member/calavera.config.json": recipe(["eslint"]),
  });
  const member = join(fixture.root, "packages", "member");

  assert.deepEqual(toolchainIssues(await doctorReport(member)), [
    {
      level: "warning",
      message: `calavera.config.json selects eslint, a JavaScript and TypeScript linting integration that Calavera removed. Vite+ manages this project (vite-plus-dependency signal at ${join(fixture.root, "package.json")}) and provides linting, so remove eslint from calavera.config.json; apply refuses the recipe until you do.`,
    },
  ]);
});

for (const integrations of [
  ["oxlint", "oxfmt", "typescript", "eslint", "prettier"],
  keptIntegrations,
]) {
  test(`doctor gives no #431 Vite+ warning in a plain Vite project (${integrations.join(", ")})`, async () => {
    await using fixture = await createTemporaryFixture("doctor-plain-vite", {
      "package.json": json(plainViteManifest),
      "vite.config.ts": plainViteConfig,
      "calavera.config.json": recipe(integrations),
    });
    assert.equal((await detectVitePlus(fixture.root)).status, "unmanaged");

    const report = await doctorReport(fixture.root);

    // #431 stays silent here; #1082's advisory warning names each removed id instead.
    assert.deepEqual(vitePlusToolchainIssues(report), []);
    assert.deepEqual(
      toolchainIssues(report).map(({ message }) => message.split(",")[0]),
      integrations
        .filter((id) => isRemovedToolchainId(id))
        .map((id) => `calavera.config.json selects ${id}`),
    );
    assert.equal(report.ok, true);
    for (const { message } of report.issues.filter(
      (issue) => !toolchainIssues(report).includes(issue),
    )) {
      assert.match(message, /^Missing managed file: /);
    }
  });
}
