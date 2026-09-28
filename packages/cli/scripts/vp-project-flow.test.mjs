// Issue #433 and handoff H0: the agent-first MCP flow, inspect_project, then
// list_integrations and compose_recipe, then dry_run_apply, apply_recipe, and
// a second dry_run_apply, run against real `vp create` output from
// vite-plus 1.0.0. Each case applies to a temporary copy of the committed
// fixture, never to the fixture itself.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";

import { callMcpTool } from "../src/mcp.js";
import { textHash } from "../src/utils/hash.js";
import { isRemovedToolchainId } from "./removed-toolchain-ids.mjs";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

const managedLines = [
  "Vite+ detection: managed. This project is vp-managed (vite-plus-dependency signal at package.json).",
  "JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera.",
];

const rootIntegrations = ["editorconfig", "knip", "github-repository-controls"];
// github-repository-controls is root-only (#550); a workspace member applies
// the per-package integrations, and the refusal is asserted separately.
const memberIntegrations = ["editorconfig", "knip"];
const plannedPathFor = {
  editorconfig: ".editorconfig",
  knip: "knip.json",
  "github-repository-controls": ".github/repository-controls.json",
};
const integrationLabels = {
  editorconfig: "EditorConfig",
  knip: "Knip",
  "github-repository-controls": "repository controls",
};

// Configuration files of the JavaScript and TypeScript toolchain Vite+ owns.
const toolchainFile =
  /(^|\/)(\.?eslint|\.?prettier|\.?oxlint|\.?oxfmt|tsconfig|jsconfig|vitest\.|jest\.|\.mocharc|biome\.)/i;
// Commands of that toolchain, and vp itself, which a Calavera script must not call.
const toolchainCommand = /\b(eslint|prettier|oxlint|oxfmt|tsc|vitest|jest|mocha|biome|vp)\b/;
// Dependencies of that toolchain, which a Calavera recipe must not install.
const toolchainDependency =
  /^(eslint|@eslint\/|typescript-eslint|prettier|oxlint|oxfmt|typescript$|@typescript\/|vitest|jest|mocha|@biomejs\/)/;

const cases = [
  { name: "library", fixture: "library", directory: ".", integrations: rootIntegrations },
  { name: "monorepo root", fixture: "monorepo", directory: ".", integrations: rootIntegrations },
  {
    name: "monorepo member packages/utils",
    fixture: "monorepo",
    directory: "packages/utils",
    integrations: memberIntegrations,
  },
];

/**
 * Copies a release fixture and marks its root as the git repository root, as
 * the fixtures were generated with `--no-git`.
 *
 * @param {"library" | "monorepo"} name
 */
async function copyRepositoryFixture(name) {
  const fixture = await copyReleaseFixture(name);
  await mkdir(join(fixture.root, ".git"));
  return fixture;
}

/**
 * Runs `callback` with the process working directory set to `directory`, as
 * the MCP tools read the project from `process.cwd()`.
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

/** @param {Array<{ type: string, path?: string, ownership?: string }>} changes */
function calaveraWrites(changes) {
  return changes
    .filter(({ type, ownership }) => type === "write" && ownership === "calavera")
    .map(({ path }) => path);
}

/** @param {Array<{ type: string, path?: string, scripts?: string[] }>} changes */
function plannedScripts(changes) {
  return changes.find(({ type, path }) => type === "update" && path === "package.json")?.scripts;
}

/**
 * Drives the flow up to and including apply_recipe, asserting each step, and
 * returns what the second dry run needs.
 *
 * @param {{ fixture: "library" | "monorepo", directory: string, integrations: string[] }} flowCase
 * @param {string} root
 */
async function runFlow({ directory, integrations }, root) {
  const project = join(root, directory);
  const before = await snapshotTree(root);
  const manifestPath = join(directory, "package.json");
  const manifestBefore = JSON.parse(before.get(manifestPath).toString("utf8"));
  const fixtureScripts = manifestBefore.scripts;

  return inDirectory(project, async () => {
    const inspection = await callMcpTool("inspect_project");
    assert.equal(inspection.vitePlus.status, "managed");
    assert.ok(
      inspection.findings.some(({ kind }) => kind === "vite-plus-managed"),
      JSON.stringify(inspection.findings),
    );

    const listed = await callMcpTool("list_integrations", { profile: "default" });
    const offered = listed.integrations.map(({ id }) => id);
    assert.deepEqual(offered.filter(isRemovedToolchainId), []);
    for (const id of integrations) {
      assert.ok(offered.includes(id), `${id} is not offered to the default profile`);
    }

    const composed = await callMcpTool("compose_recipe", {
      profile: "default",
      packageManager: "pnpm",
    });
    assert.equal(composed.vitePlus.status, "managed");
    assert.deepEqual(composed.recipe.integrations.filter(isRemovedToolchainId), []);

    const { recipe } = await callMcpTool("compose_recipe", {
      profile: "default",
      packageManager: "pnpm",
      tools: [...new Set([...composed.recipe.integrations, ...integrations])],
      ...(integrations.includes("github-repository-controls")
        ? {
            integrationOptions: {
              "github-repository-controls": { repository: "example/vp-project" },
            },
          }
        : {}),
    });
    assert.deepEqual(recipe.integrations.filter(isRemovedToolchainId), []);

    const dryRun = await callMcpTool("dry_run_apply", { recipe });
    const { changes } = dryRun.result;
    const writes = calaveraWrites(changes);
    const scripts = plannedScripts(changes);

    assert.equal(dryRun.result.dryRun, true);
    assert.deepEqual(dryRun.result.vitePlus.lines, managedLines);
    assert.ok(writes.length > 0, "the dry run plans no managed file");
    for (const path of integrations.map((id) => plannedPathFor[id])) {
      assert.ok(writes.includes(path), `the dry run does not plan ${path}`);
    }
    assert.deepEqual(
      changes.filter(({ path }) => path && toolchainFile.test(path)).map(({ path }) => path),
      [],
    );
    assert.deepEqual(
      dryRun.result.dependencies.filter((name) => toolchainDependency.test(name)),
      [],
    );
    assert.ok(scripts && scripts.length > 0, "the dry run plans no package.json scripts");
    for (const name of ["format", "typecheck", "test"]) {
      assert.equal(scripts.includes(name), false, `the dry run adds a ${name} script`);
    }
    // No planned script may replace one the fixture already runs through vp.
    const vpScripts = Object.keys(fixtureScripts).filter((name) =>
      /\bvp\b/.test(fixtureScripts[name]),
    );
    assert.ok(vpScripts.length > 0, "the fixture defines no vp script");
    assert.deepEqual(
      scripts.filter((name) => vpScripts.includes(name)),
      [],
    );
    assert.deepEqual(await snapshotTree(root), before, "the dry run changed a file");

    const applied = await callMcpTool("apply_recipe", { recipe, noInstall: true });
    assert.equal(applied.result.dryRun, false);
    assert.deepEqual(applied.result.changes, changes);

    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
    assert.deepEqual(state.managedFiles.map(({ path }) => path).sort(), [...writes].sort());
    for (const { path, hash } of state.managedFiles) {
      assert.equal(textHash(await readFile(path, "utf8")), hash, path);
    }

    const manifestAfter = JSON.parse(await readFile("package.json", "utf8"));
    for (const name of scripts) {
      assert.equal(typeof manifestAfter.scripts[name], "string", `${name} was not written`);
      assert.doesNotMatch(manifestAfter.scripts[name], toolchainCommand, name);
    }
    assert.deepEqual(
      Object.fromEntries(
        Object.keys(fixtureScripts).map((name) => [name, manifestAfter.scripts[name]]),
      ),
      fixtureScripts,
      "a fixture script changed",
    );
    assert.deepEqual(
      { ...manifestAfter, scripts: undefined },
      { ...manifestBefore, scripts: undefined },
      "package.json changed outside scripts",
    );

    const after = await snapshotTree(root);
    for (const [path, contents] of before) {
      if (path === manifestPath) continue;
      assert.ok(after.get(path)?.equals(contents), `${path} is not byte-for-byte unchanged`);
    }

    return { recipe, changes, writes };
  });
}

for (const flowCase of cases) {
  const installed = new Intl.ListFormat("en", { type: "conjunction" }).format(
    flowCase.integrations.map((id) => integrationLabels[id]),
  );
  test(`vp create ${flowCase.name}: the agent-first flow installs ${installed}, and offers no JS or TS toolchain`, async () => {
    await using fixture = await copyRepositoryFixture(flowCase.fixture);
    const { recipe, changes } = await runFlow(flowCase, fixture.root);

    const secondDryRun = await inDirectory(join(fixture.root, flowCase.directory), () =>
      callMcpTool("dry_run_apply", { recipe }),
    );
    const findings = secondDryRun.result.projectInspection.findings;

    // No content drift: nothing conflicts with or re-owns a managed file, and
    // the plan is exactly the one the user approved.
    assert.deepEqual(
      findings.filter(
        ({ severity, kind }) =>
          severity === "error" || kind === "managed-file-conflict" || kind === "managed-file-reown",
      ),
      [],
    );
    assert.deepEqual(secondDryRun.result.changes, changes);
    assert.deepEqual(secondDryRun.result.vitePlus.lines, managedLines);
  });
}

test("vp create monorepo member packages/utils: dry_run_apply and apply_recipe refuse github-repository-controls, name the repository root, and write nothing", async () => {
  await using fixture = await copyRepositoryFixture("monorepo");
  const member = join(fixture.root, "packages/utils");
  const before = await snapshotTree(fixture.root);

  await inDirectory(member, async () => {
    const { recipe } = await callMcpTool("compose_recipe", {
      profile: "default",
      packageManager: "pnpm",
      tools: rootIntegrations,
      integrationOptions: { "github-repository-controls": { repository: "example/vp-project" } },
    });
    const refusal = `github-repository-controls applies at the repository root, not in a workspace member. This project is ${member}; the repository root is ${fixture.root}.`;
    const refuses = (/** @type {unknown} */ error) =>
      error instanceof Error && error.message.startsWith(refusal);

    await assert.rejects(callMcpTool("dry_run_apply", { recipe }), refuses);
    await assert.rejects(callMcpTool("apply_recipe", { recipe, noInstall: true }), refuses);
  });

  assert.deepEqual(await snapshotTree(fixture.root), before, "the refusal changed a file");
});

// H0 and #548: once the recipe is applied, a second dry run reports every
// planned write and script update as unchanged, and warns about none of the
// files or scripts Calavera itself recorded.
for (const flowCase of cases) {
  test(`vp create ${flowCase.name}: a second dry run after apply reports no changes and no drift`, async () => {
    await using fixture = await copyRepositoryFixture(flowCase.fixture);
    const { recipe } = await runFlow(flowCase, fixture.root);

    const secondDryRun = await inDirectory(join(fixture.root, flowCase.directory), () =>
      callMcpTool("dry_run_apply", { recipe }),
    );

    assert.deepEqual(
      secondDryRun.result.changes.filter(({ type }) => type === "write" || type === "update"),
      [],
    );
    assert.deepEqual(
      secondDryRun.result.projectInspection.findings.filter(({ severity }) => severity !== "info"),
      [],
    );
  });
}
