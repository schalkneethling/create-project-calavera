// Issue #458: every command that plans, writes, checks, or cleans managed files reads them from one
// declaration. The first tests pin which files each command included before the refactor, so the
// refactor cannot change them. Inspection lists them in apply's write order (#926). Since #925,
// doctor also checks the github-repository-controls files, which it skipped before.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtempDisposable, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { integrationCatalog } from "../src/catalog.js";
import { githubRepositoryControlManagedFiles } from "../src/github-repository-controls.js";
import { inspectProject, planCleanManagedFiles } from "../src/index.js";
import * as projectInspection from "../src/project-inspection.js";
import { buildRecipe } from "../src/recipe.js";

const { integrationConfigFiles, projectInspectionFiles } = projectInspection;

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

const integrationOptions = {
  "github-repository-controls": { repository: "octocat/example", defaultBranch: "main" },
};

/**
 * Runs `doctor --json` in `cwd` and returns its report. Doctor exits 1 exactly when an issue is an
 * error (#1030), and a crash writes to standard error, so a run that crashed after it printed JSON,
 * or that exited with the wrong code, fails here instead of passing (#1092).
 *
 * @param {string} cwd
 * @param {0 | 1} expectedCode The exit code doctor must give, pinned rather than read from the report.
 */
async function runDoctorJson(cwd, expectedCode) {
  const { stdout, stderr, code } = await execFileAsync(
    process.execPath,
    [cliPath, "doctor", "--json"],
    { cwd, env: { ...process.env, NO_COLOR: "1" } },
  ).then(
    (result) => ({ ...result, code: 0 }),
    (error) => error,
  );
  assert.equal(stderr, "", "doctor wrote to standard error");
  const report = JSON.parse(stdout);
  assert.equal(code, expectedCode, "doctor exit code");
  assert.equal(code, report.issues.some(({ level }) => level === "error") ? 1 : 0);
  return report;
}

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

test("inspection reports the existing config files of each integration in apply's write order", () => {
  assert.deepEqual(Object.entries(integrationConfigFiles), [
    ["editorconfig", [".editorconfig"]],
    ["stylelint", [".stylelintrc.json"]],
    ["html-validate", [".htmlvalidate.json", ".htmlvalidateignore", "scripts/lint-html.mjs"]],
    ["react-doctor", ["react-doctor.config.json"]],
    ["knip", ["knip.json"]],
    ["stryker", strykerConfigFileNames],
    ["github-repository-controls", repositoryControlFiles],
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
    ".stylelintrc.json",
    ".htmlvalidate.json",
    ".htmlvalidateignore",
    "scripts/lint-html.mjs",
    "react-doctor.config.json",
    "knip.json",
    ...strykerConfigFileNames,
    ...repositoryControlFiles,
    "vite.config.js",
    "vite.config.ts",
    "next.config.js",
    "next.config.mjs",
    "astro.config.mjs",
    "svelte.config.js",
  ]);
});

test("inspection reports existing-config findings in apply's write order (#926)", async () => {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-926-"));
  // One foreign config per integration, written in reverse of the expected order so the finding
  // order cannot come from the order the files were created in.
  const foreignConfigs = [
    ".editorconfig",
    ".stylelintrc.json",
    ".htmlvalidate.json",
    "react-doctor.config.json",
    "knip.json",
    "stryker.config.json",
    "docs/repository-controls.md",
  ];
  await writeFile(join(project.path, "package.json"), `${JSON.stringify({ scripts: {} })}\n`);
  await mkdir(join(project.path, "docs"));

  for (const path of foreignConfigs.toReversed()) {
    await writeFile(join(project.path, path), "foreign\n");
  }

  const recipe = buildRecipe(
    "default",
    integrationCatalog.map(({ id }) => id),
    "npm",
    [],
    integrationOptions,
  );
  const originalDirectory = process.cwd();
  process.chdir(project.path);

  try {
    const { files, findings } = await inspectProject(recipe);

    assert.deepEqual(
      files.filter((path) => foreignConfigs.includes(path)),
      foreignConfigs,
    );
    assert.deepEqual(
      findings.filter(({ kind }) => kind === "existing-config").map(({ path }) => path),
      foreignConfigs,
    );
  } finally {
    process.chdir(originalDirectory);
  }
});

test("doctor checks every planned file", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "calavera-458-"));
  // The project is its own repository root, even when the temporary folder is inside a checkout.
  await mkdir(join(directory.path, ".git"));
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

  const prefix = "Missing managed file: ";
  // Missing managed files are warnings and nothing else is an error, so doctor exits 0.
  const messages = (await runDoctorJson(directory.path, 0)).issues
    .map(({ message }) => message)
    .filter((message) => message.startsWith(prefix));

  // #925: the github-repository-controls files are checked like every other managed file, and at
  // the repository root the remedy is the plain one.
  assert.deepEqual(
    messages,
    plannedPaths.map(
      (path) => `${prefix}${path}. Run create-project-calavera apply to regenerate managed files.`,
    ),
  );
});

test("doctor run from a workspace member checks the repository-controls files at the repository root", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "calavera-925-"));
  const root = directory.path;
  const member = join(root, "packages", "app");
  await mkdir(join(root, ".git"));
  await mkdir(member, { recursive: true });
  await writeFile(
    join(member, "calavera.config.json"),
    `${JSON.stringify({
      version: 1,
      profile: "web",
      packageManager: "npm",
      integrations: ["knip", "github-repository-controls"],
      integrationOptions,
    })}\n`,
  );
  // knip applies in the member, so its file is checked there, not at the repository root.
  await writeFile(join(member, "knip.json"), "{}\n");
  // Every repository-controls file but the last exists at the repository root, none in the member.
  const [missingFile, ...presentFiles] = repositoryControlFiles.toReversed();
  for (const path of presentFiles) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), "");
  }

  const { issues } = await runDoctorJson(member, 1);
  // github-repository-controls selected in a member is the one error, so doctor exits 1.
  const errors = issues.filter(({ level }) => level === "error").map(({ message }) => message);
  assert.equal(errors.length, 1, errors.join("\n"));
  assert.ok(
    errors[0].startsWith(
      "github-repository-controls applies at the repository root, not in a workspace member.",
    ),
    errors[0],
  );
  const messages = issues
    .map(({ message }) => message)
    .filter((message) => message.startsWith("Missing managed file: "));

  assert.equal(messages.length, 1, messages.join("\n"));
  // process.cwd() is the real path, so on macOS the root is /private/var/..., not /var/....
  assert.equal(
    messages[0],
    `Missing managed file: ../../${missingFile}. Run create-project-calavera apply from the repository root, ${await realpath(root)}, to regenerate managed files, adding --config <path> when the recipe is saved elsewhere.`,
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

  // The planner reads paths from the declaration, so compare the declaration with the module that
  // builds the repository-controls files, which lists its paths itself.
  assert.deepEqual(
    githubRepositoryControlManagedFiles(
      integrationOptions["github-repository-controls"],
      integrationCatalog,
    ).map(({ path }) => path),
    declarations
      .find(({ integration }) => integration === "github-repository-controls")
      .files.map(({ path }) => path),
  );

  const paths = declarations.flatMap(({ files }) => files.map(({ path }) => path));
  assert.deepEqual(paths, [...new Set(paths)], "no file is declared by two integrations");
});

test("doctor's list is the declared files of the selected integrations", () => {
  assert.equal(typeof projectInspection.declaredManagedFiles, "function");
  const files = projectInspection.declaredManagedFiles(["knip", "github-repository-controls"]);
  assert.deepEqual(files, [
    { integration: "knip", path: "knip.json" },
    ...repositoryControlFiles.map((path) => ({ integration: "github-repository-controls", path })),
  ]);
  assert.deepEqual(projectInspection.declaredManagedFiles(["varlock"]), []);
});
