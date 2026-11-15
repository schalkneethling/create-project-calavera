// Issue #458: every command that plans, writes, checks, or cleans managed files reads them from one
// declaration. The first tests pin what each command did before the refactor, so the refactor
// cannot change which files any command includes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { integrationCatalog } from "../src/catalog.js";
import { planCleanManagedFiles } from "../src/index.js";
import * as projectInspection from "../src/project-inspection.js";

const { integrationConfigFiles, projectInspectionFiles } = projectInspection;

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

const integrationOptions = {
  "github-repository-controls": { repository: "octocat/example", defaultBranch: "main" },
};

const repositoryControlFiles = [
  ".github/repository-controls.json",
  ".github/dependabot.yml",
  "scripts/repository-controls.mjs",
  "docs/repository-controls.md",
];

// The files apply writes, in the order it writes them, when the recipe selects every integration.
const plannedPaths = [
  ".editorconfig",
  ".stylelintrc.json",
  ".htmlvalidate.json",
  ".htmlvalidateignore",
  "scripts/lint-html.mjs",
  "react-doctor.config.json",
  "knip.json",
  "stryker.config.json",
  ...repositoryControlFiles,
];

const strykerConfigFileNames = ["", "."].flatMap((prefix) =>
  [".conf", ".config"].flatMap((suffix) =>
    ["json", "js", "mjs", "cjs"].map((extension) => `${prefix}stryker${suffix}.${extension}`),
  ),
);

function planFor(integrations) {
  return planCleanManagedFiles(integrations, integrationOptions, "calavera.config.json");
}

test("apply, inspection, and clean plan every managed file once, in apply's write order", () => {
  assert.deepEqual(
    planFor(integrationCatalog).map(({ path }) => path),
    plannedPaths,
  );
});

test("inspection reports the existing config files of each integration, in the same order", () => {
  assert.deepEqual(Object.entries(integrationConfigFiles), [
    ["editorconfig", [".editorconfig"]],
    ["github-repository-controls", repositoryControlFiles],
    ["html-validate", [".htmlvalidate.json", ".htmlvalidateignore", "scripts/lint-html.mjs"]],
    ["knip", ["knip.json"]],
    ["react-doctor", ["react-doctor.config.json"]],
    ["stylelint", [".stylelintrc.json"]],
    ["stryker", strykerConfigFileNames],
  ]);
  assert.deepEqual(projectInspectionFiles, [
    "package.json",
    "calavera.config.json",
    "package-lock.json",
    "npm-shrinkwrap.json",
    "pnpm-lock.yaml",
    "shrinkwrap.yaml",
    "yarn.lock",
    "bun.lock",
    "bun.lockb",
    ".editorconfig",
    ...repositoryControlFiles,
    ".htmlvalidate.json",
    ".htmlvalidateignore",
    "scripts/lint-html.mjs",
    "knip.json",
    "react-doctor.config.json",
    ".stylelintrc.json",
    ...strykerConfigFileNames,
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "astro.config.mjs",
    "svelte.config.js",
  ]);
});

test("doctor checks every planned file except the github-repository-controls files", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "calavera-458-"));
  await writeFile(
    join(directory.path, "calavera.config.json"),
    `${JSON.stringify({
      version: 1,
      profile: "web",
      packageManager: "npm",
      integrations: integrationCatalog.map(({ id }) => id),
      integrationOptions,
    })}\n`,
  );

  const { stdout } = await execFileAsync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd: directory.path,
    env: { ...process.env, NO_COLOR: "1" },
  }).catch((error) => error);
  const prefix = "Missing managed file: ";
  const missing = JSON.parse(stdout)
    .issues.map(({ message }) => message)
    .filter((message) => message.startsWith(prefix))
    .map((message) => message.slice(prefix.length).split(". Run ")[0]);

  // #458 follow-up: doctor has never checked the github-repository-controls files.
  assert.deepEqual(
    missing,
    plannedPaths.filter((path) => !repositoryControlFiles.includes(path)),
  );
});

test("every integration that writes a managed file appears exactly once in the one declaration", () => {
  const declarations = projectInspection.managedFileDeclarations;
  assert.ok(Array.isArray(declarations), "project-inspection.js declares the managed files");

  const writers = integrationCatalog.filter((integration) => planFor([integration]).length > 0);
  assert.deepEqual(
    writers.map(({ id }) => declarations.filter(({ integration }) => integration === id).length),
    writers.map(() => 1),
  );
  // An entry for an integration that writes nothing would be a file no command plans.
  assert.deepEqual(
    declarations.map(({ integration }) => integration).toSorted(),
    writers.map(({ id }) => id).toSorted(),
  );

  for (const integration of writers) {
    const { files } = declarations.find((entry) => entry.integration === integration.id);
    assert.deepEqual(
      files.map(({ path }) => path),
      planFor([integration]).map(({ path }) => path),
      `${integration.id} writes exactly the files it declares`,
    );
  }

  const paths = declarations.flatMap(({ files }) => files.map(({ path }) => path));
  assert.deepEqual(paths, [...new Set(paths)], "no file is declared by two integrations");
});

test("doctor's list is the declared files of the selected integrations, minus those it skips", () => {
  const files = projectInspection.declaredManagedFiles(["knip", "github-repository-controls"]);
  assert.deepEqual(files, [
    { path: "knip.json" },
    ...repositoryControlFiles.map((path) => ({ path, checkedByDoctor: false })),
  ]);
  assert.deepEqual(projectInspection.declaredManagedFiles(["varlock"]), []);
});
