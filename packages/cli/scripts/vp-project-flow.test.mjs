// Issue #433 and handoff H0: the agent-first MCP flow, inspect_project, then
// list_integrations and compose_recipe, then dry_run_apply, apply_recipe, and
// a second dry_run_apply, run against real `vp create` output from
// vite-plus 1.0.0. Each case applies to a temporary copy of the committed
// fixture, never to the fixture itself.
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { textHash } from "../src/utils/hash.js";
import { writeMcpServersJsonConfig } from "../src/utils/mcp-config.js";
import { loadProjectFormatter } from "../src/utils/project-formatter.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { isRemovedToolchainId } from "./removed-toolchain-ids.mjs";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  readStubInvocations,
  writeVitePlusStub,
} from "./vite-plus-fixtures.mjs";

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
// Commands of that toolchain, which a Calavera script must not call.
const toolchainCommand = /\b(eslint|prettier|oxlint|oxfmt|tsc|vitest|jest|mocha|biome)\b/;
// ADR-0013: no Calavera script duplicates a vp command. Only the quality
// aggregate calls vp, and only these steps: vp check, and the Vite+ test step.
const qualityVpSteps = new Set(["vp check", "vp test --passWithNoTests", "vp run -r test"]);
// A command that runs Vite+ or the Vite CLI it wraps: vp, the vpr alias for
// vp run (the vite-plus 1.0.0 manifest declares bin vp and vpr), and vite,
// whose build, dev, and preview commands vp also provides.
const vitePlusCommand = /(^|\s|[;|&(])(vp|vpr|vite)(\s|$)/;

/**
 * Asserts that a script Calavera wrote calls no JS or TS toolchain command and
 * duplicates no vp command: a script other than quality calls vp, vpr, or vite
 * nowhere, and quality calls vp only for its allowed steps.
 *
 * @param {string} name
 * @param {string} script
 */
function assertNoDuplicateVpCommand(name, script) {
  assert.doesNotMatch(script, toolchainCommand, name);

  for (const step of script.split("&&").map((segment) => segment.trim())) {
    if (vitePlusCommand.test(step)) {
      assert.ok(
        name === "quality" && qualityVpSteps.has(step),
        `${name} duplicates a vp command: ${step}`,
      );
    }
  }
}

test("assertNoDuplicateVpCommand rejects vp, vpr, and vite duplicates and accepts the quality steps", () => {
  for (const [name, script] of [
    ["check", "vp check"],
    ["lint", "vp lint"],
    ["test", "vpr test"],
    ["build", "vite build"],
    ["dev", "vite dev"],
    ["preview", "vite preview"],
    ["test", "vite test"],
    ["quality", "vp check && vp lint && npm run knip"],
    ["quality", "vite build && npm run knip"],
    ["quality", "vpr test && npm run knip"],
  ]) {
    assert.throws(() => assertNoDuplicateVpCommand(name, script), assert.AssertionError, script);
  }

  for (const [name, script] of [
    ["quality", "vp check && vp test --passWithNoTests && pnpm lint:styles && pnpm knip"],
    ["quality", "vp check && vp run -r test && pnpm lint:styles"],
    ["lint:styles", 'stylelint "**/*.{css,scss}" --allow-empty-input'],
    ["knip", "knip"],
  ]) {
    assertNoDuplicateVpCommand(name, script);
  }
});
// Dependencies of that toolchain, which a Calavera recipe must not install.
const toolchainDependency =
  /^(eslint|@eslint\/|typescript-eslint|prettier|oxlint|oxfmt|typescript$|@typescript\/|vitest|jest|mocha|@biomejs\/)/;

// The quality script each case gets (ADR-0013): a workspace root runs every
// member's test script, as the template's own ready script does. Only the
// root of the pnpm workspace installs with -w (#731).
//
// A workspace member does not take the protected branch guard: it writes Git
// hooks, and Git runs every hook from the repository root, so apply refuses
// the guard in a member (ADR-0015, Decision 5; protected-branch-guard-apply
// tests). The member case asserts that refusal instead of the wiring.
const cases = [
  {
    name: "library",
    fixture: "library",
    directory: ".",
    guard: true,
    integrations: rootIntegrations,
    quality: "vp check && vp test --passWithNoTests && pnpm lint:styles && pnpm knip",
    installFlags: [],
  },
  {
    name: "monorepo root",
    fixture: "monorepo",
    directory: ".",
    guard: true,
    integrations: rootIntegrations,
    quality: "vp check && vp run -r test && pnpm lint:styles && pnpm knip",
    installFlags: ["-w"],
  },
  {
    name: "monorepo member packages/utils",
    fixture: "monorepo",
    directory: "packages/utils",
    guard: false,
    integrations: memberIntegrations,
    quality: "vp check && vp test --passWithNoTests && pnpm lint:styles && pnpm knip",
    installFlags: [],
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

const guardId = "skill-protected-branch-guard";
const guardSkillDirectory = ".agents/skills/protected-branch-guard";
const guardHookScripts = [
  ".vite-hooks/pre-commit",
  ".vite-hooks/prepare-commit-msg",
  ".vite-hooks/pre-push",
];
const guardSettingsPath = ".claude/settings.json";
const guardCommand = (/** @type {string} */ mode) =>
  `node ${guardSkillDirectory}/scripts/guard.mjs ${mode} main`;
// Stands in for createMcpLaunchCommand("pnpm"), which index.js does not export;
// the flow does not depend on the command, only on the file staying as written.
const bootstrapLaunchCommand = {
  command: "pnpm",
  args: ["dlx", "--package", "create-project-calavera", "create-project-calavera-mcp"],
};
const guardRecipeItem = { id: guardId, inputs: { protectedBranch: "main" } };

// The registry stand-in serves the workspace payload of the guard, so the flow
// installs offline and from exactly what this repository ships.
const registry = () => stubRegistry(new Map([[guardId, "0.1.0"]]));

/**
 * Writes the pre-commit script `vp create` leaves in a project, which the
 * `--no-git` fixtures lack. The scripts live at the repository root, whatever
 * the project directory is.
 *
 * @param {string} root
 */
async function seedViteHooks(root) {
  await mkdir(join(root, ".vite-hooks"));
  await writeFile(join(root, ".vite-hooks/pre-commit"), "vp staged\n");
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
 * @param {{ fixture: "library" | "monorepo", directory: string, integrations: string[], quality: string, guard: boolean }} flowCase
 * @param {string} root
 */
async function runFlow({ directory, integrations, quality, guard }, root) {
  const project = join(root, directory);
  await seedViteHooks(root);
  // The bootstrap's registration step, with the writer `--init --mcp-harness
  // claude-code` calls and the project's own vp fmt it formats with, so the flow
  // starts from the file the bootstrap wrote. copyReleaseFixture installs that vp.
  await inDirectory(project, () =>
    writeMcpServersJsonConfig(".mcp.json", bootstrapLaunchCommand, false, [], () =>
      loadProjectFormatter(project, "managed"),
    ),
  );
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
      ...(guard ? { aiArtifacts: [guardRecipeItem] } : {}),
      ...(integrations.includes("github-repository-controls")
        ? {
            integrationOptions: {
              "github-repository-controls": { repository: "example/vp-project" },
            },
          }
        : {}),
    });
    assert.deepEqual(recipe.integrations.filter(isRemovedToolchainId), []);

    const dryRun = await callMcpTool("dry_run_apply", { recipe }, registry());
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

    const applied = await callMcpTool("apply_recipe", { recipe, noInstall: true }, registry());
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
      assertNoDuplicateVpCommand(name, manifestAfter.scripts[name]);
    }
    assert.equal(manifestAfter.scripts.quality, quality);
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
    // Apply changes package.json, and with the guard it inserts a block into the
    // seeded pre-commit script; every other file it did not plan stays as it was.
    const edited = new Set([manifestPath, ...(guard ? [".vite-hooks/pre-commit"] : [])]);
    for (const [path, contents] of before) {
      if (edited.has(path)) continue;
      assert.ok(after.get(path)?.equals(contents), `${path} is not byte-for-byte unchanged`);
    }

    return { recipe, changes, writes, applied, before };
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
      callMcpTool("dry_run_apply", { recipe }, registry()),
    );
    const findings = secondDryRun.result.projectInspection.findings;

    // No content drift: nothing conflicts with or re-owns a managed file, and
    // the plan is exactly the one the user approved, each change now unchanged.
    assert.deepEqual(
      findings.filter(
        ({ severity, kind }) =>
          severity === "error" || kind === "managed-file-conflict" || kind === "managed-file-reown",
      ),
      [],
    );
    // With the guard, three entries differ for reasons unrelated to drift: the
    // second dry run no longer reports the installed skill directory or the
    // .coderabbit.yaml that installing a skill writes, and the hook scripts and
    // settings file are now "update" instead of "write" because they exist. The
    // wiring entries are compared by path and type, and the rest exactly.
    const wiringPaths = new Set(flowCase.guard ? [...guardHookScripts, guardSettingsPath] : []);
    const notReported = new Set(flowCase.guard ? [guardSkillDirectory, ".coderabbit.yaml"] : []);
    const exact = (/** @type {Array<{ path?: string }>} */ list) =>
      list.filter(({ path }) => !wiringPaths.has(path) && !notReported.has(path));
    assert.deepEqual(
      exact(secondDryRun.result.changes),
      exact(changes).map((change) => ({ ...change, type: "unchanged" })),
    );
    assert.deepEqual(
      secondDryRun.result.changes
        .filter(({ path }) => wiringPaths.has(path))
        .map(({ path, type }) => [path, type]),
      [...wiringPaths].map((path) => [path, "unchanged"]),
    );
    // The two entries left out above may be absent, but never anything but unchanged.
    assert.deepEqual(
      secondDryRun.result.changes.filter(
        ({ path, type }) => notReported.has(path) && type !== "unchanged",
      ),
      [],
    );
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
      callMcpTool("dry_run_apply", { recipe }, registry()),
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

// #618 and ADR-0012: in a vp create project, apply_recipe installs the
// recipe's development dependencies with the project's own vp add -D, which
// runs the package manager the project pins. A stand-in vite-plus at the
// fixture root records the call, so the case stays offline; the monorepo
// member finds it at the workspace root, as Node.js resolution would. Like
// pnpm, the stand-in refuses a workspace-root install without -w (#731).
for (const flowCase of cases) {
  test(`vp create ${flowCase.name}: apply_recipe installs the dev dependencies with the project's vp add -D`, async () => {
    await using fixture = await copyRepositoryFixture(flowCase.fixture);
    await using logs = await createTemporaryFixture("vp-flow-install", {});
    const logPath = join(logs.root, "vp.log");
    const project = join(fixture.root, flowCase.directory);
    await writeVitePlusStub(fixture.root, { logPath });

    const dependencies = await inDirectory(project, async () => {
      const { recipe } = await callMcpTool("compose_recipe", {
        profile: "default",
        packageManager: "pnpm",
        tools: flowCase.integrations,
        ...(flowCase.integrations.includes("github-repository-controls")
          ? {
              integrationOptions: {
                "github-repository-controls": { repository: "example/vp-project" },
              },
            }
          : {}),
      });
      const dryRun = await callMcpTool("dry_run_apply", { recipe });
      const installCommand = [
        "vp add -D",
        ...flowCase.installFlags,
        ...dryRun.result.dependencies,
      ].join(" ");

      assert.ok(dryRun.result.dependencies.length > 0, "the recipe installs no dependency");
      assert.equal(dryRun.result.installCommand, installCommand);
      assert.deepEqual(await readStubInvocations(logPath), [], "the dry run ran vp");

      const applied = await callMcpTool("apply_recipe", { recipe });
      assert.equal(applied.result.installCommand, installCommand);

      return dryRun.result.dependencies;
    });

    assert.deepEqual(await readStubInvocations(logPath), [
      { argv: ["add", "-D", ...flowCase.installFlags, ...dependencies], cwd: project },
    ]);
  });
}

// #748: the protected branch guard and its wiring, the Knip ignore, the
// bootstrap's MCP registration, and the written .editorconfig, on the committed
// Vite+ fixtures. The registry stand-in serves the guard offline, so no case
// installs a package or runs a Git commit. The fixtures hold a `.git` directory
// that is not a real repository, so the hook scripts and .claude/settings.json
// are checked as text; whether Git runs them belongs to the guard's own tests
// and the readiness check.
const rootCases = cases.filter(({ guard }) => guard);
const memberCase = cases.find(({ guard }) => !guard);
const guardFragmentPath = fileURLToPath(
  new URL(
    "../../artifacts/skill-protected-branch-guard/payload/protected-branch-guard/hooks/claude-code.settings.json",
    import.meta.url,
  ),
);
const guardBlock = (/** @type {string} */ line) =>
  `# calavera:${guardId}:start\n${line}\n# calavera:${guardId}:end\n`;

/**
 * Applies the flow to a copy of the fixture, then hands the result to `check`.
 *
 * @param {(typeof cases)[number]} flowCase
 * @param {(flow: Awaited<ReturnType<typeof runFlow>> & { root: string, project: string }) => Promise<void>} check
 */
async function afterApply(flowCase, check) {
  await using fixture = await copyRepositoryFixture(flowCase.fixture);
  const flow = await runFlow(flowCase, fixture.root);
  await check({ ...flow, root: fixture.root, project: join(fixture.root, flowCase.directory) });
}

for (const flowCase of rootCases) {
  test(`vp create ${flowCase.name}: Given .vite-hooks/pre-commit holding vp staged, when the flow runs with the guard and the Knip integration, then the apply result lists the skill directory, the three .vite-hooks scripts, and .claude/settings.json, and .calavera/state.json records all of them`, async () => {
    await afterApply(flowCase, async ({ applied, project }) => {
      const listed = applied.result.changes.map(({ path }) => path);
      for (const path of [guardSkillDirectory, ...guardHookScripts, guardSettingsPath]) {
        assert.ok(listed.includes(path), `the apply result does not list ${path}`);
      }
      assert.ok(listed.includes("knip.json"), "the apply result does not list knip.json");

      const state = JSON.parse(await readFile(join(project, ".calavera/state.json"), "utf8"));
      assert.ok(
        state.aiArtifacts.some(({ path }) => path === guardSkillDirectory),
        "the state does not record the skill directory",
      );
      const wiring = state.aiWiring.find(({ artifact }) => artifact === guardId);
      assert.deepEqual(wiring.viteHooks, {
        "pre-commit": guardCommand("commit"),
        "prepare-commit-msg": guardCommand("commit"),
        "pre-push": guardCommand("pre-push"),
      });
      assert.deepEqual(Object.keys(wiring.claudeCode), ["SessionStart", "PreToolUse"]);
      await stat(join(project, guardSkillDirectory, "scripts/guard.mjs"));
    });
  });

  test(`vp create ${flowCase.name}: Given the case after apply, when .vite-hooks/pre-commit is read, then the guard block comes first, vp staged follows it unchanged, and the guard command ends with main`, async () => {
    await afterApply(flowCase, async ({ project }) => {
      const hook = (/** @type {string} */ name) =>
        readFile(join(project, ".vite-hooks", name), "utf8");
      const commit = guardCommand("commit");

      assert.equal(await hook("pre-commit"), `${guardBlock(commit)}vp staged\n`);
      // The other two scripts did not exist, so they hold the block alone.
      assert.equal(await hook("prepare-commit-msg"), guardBlock(commit));
      assert.equal(await hook("pre-push"), guardBlock(guardCommand("pre-push")));
      for (const name of ["pre-commit", "prepare-commit-msg", "pre-push"]) {
        const [, line] = (await hook(name)).split("\n");
        assert.ok(line.endsWith(" main"), `${name}: ${line}`);
      }
    });
  });

  test(`vp create ${flowCase.name}: Given the case after apply, when .claude/settings.json is read, then it holds exactly the fragment's SessionStart and PreToolUse groups, each command ending with main`, async () => {
    await afterApply(flowCase, async ({ project }) => {
      const fragment = JSON.parse(
        (await readFile(guardFragmentPath, "utf8")).replaceAll("{{protectedBranch}}", "main"),
      );
      // Parsed, not byte for byte: apply formats the file through the project's own vp fmt.
      const settings = JSON.parse(await readFile(join(project, guardSettingsPath), "utf8"));

      assert.deepEqual(settings, fragment);
      assert.deepEqual(Object.keys(settings.hooks), ["SessionStart", "PreToolUse"]);
      for (const group of Object.values(settings.hooks).flat()) {
        for (const { command } of group.hooks) {
          assert.ok(command.endsWith(" main"), command);
        }
      }
    });
  });

  test(`vp create ${flowCase.name}: Given the case after apply, when calavera.config.json is read, then it records protectedBranch main`, async () => {
    await afterApply(flowCase, async ({ project }) => {
      const config = JSON.parse(await readFile(join(project, "calavera.config.json"), "utf8"));
      assert.deepEqual(
        config.ai.filter(({ id }) => id === guardId),
        [guardRecipeItem],
      );
    });
  });

  test(`vp create ${flowCase.name}: Given the case after apply, when a second dry_run_apply runs, then it plans no write and no update for any Calavera file, including the three hook scripts and .claude/settings.json`, async () => {
    await afterApply(flowCase, async ({ recipe, project }) => {
      const { result } = await inDirectory(project, () =>
        callMcpTool("dry_run_apply", { recipe }, registry()),
      );

      assert.deepEqual(
        result.changes.filter(({ type }) => type === "write" || type === "update"),
        [],
      );
      const planned = result.changes.map(({ path }) => path);
      for (const path of [...guardHookScripts, guardSettingsPath]) {
        assert.ok(planned.includes(path), `the second dry run does not mention ${path}`);
      }
      assert.deepEqual(
        result.wiringChanges.map(({ path, type }) => [path, type]),
        [...guardHookScripts, guardSettingsPath].map((path) => [path, "unchanged"]),
      );
    });
  });
}

for (const flowCase of cases) {
  test(`vp create ${flowCase.name}: Given the case after apply, when knip.json is read, then its ignore equals [".agents/**"]`, async () => {
    await afterApply(flowCase, async ({ project }) => {
      const knip = JSON.parse(await readFile(join(project, "knip.json"), "utf8"));
      assert.deepEqual(knip.ignore, [".agents/**"]);
    });
  });

  test(`vp create ${flowCase.name}: Given a project where the bootstrap registration step has run with --mcp-harness claude-code, when the flow applies the recipe, then .mcp.json holds mcpServers.calavera, apply does not list .mcp.json as a change, and the file is byte-for-byte what the bootstrap wrote`, async () => {
    await afterApply(flowCase, async ({ applied, project, before }) => {
      const written = await readFile(join(project, ".mcp.json"));
      const bootstrapBytes = before.get(join(flowCase.directory, ".mcp.json"));

      assert.deepEqual(JSON.parse(written.toString("utf8")), {
        mcpServers: { calavera: bootstrapLaunchCommand },
      });
      assert.deepEqual(
        applied.result.changes.filter(({ path }) => path?.endsWith(".mcp.json")),
        [],
      );
      assert.ok(bootstrapBytes?.equals(written), ".mcp.json differs from what the bootstrap wrote");
    });
  });

  test(`vp create ${flowCase.name}: Given the written .editorconfig, when its content is read, then it equals the expected text, line for line`, async () => {
    await afterApply(flowCase, async ({ project }) => {
      const expected = [
        "root = true",
        "",
        "[*]",
        "charset = utf-8",
        "end_of_line = lf",
        "insert_final_newline = true",
        "indent_style = space",
        "indent_size = 2",
        "trim_trailing_whitespace = true",
        "",
      ];
      const written = (await readFile(join(project, ".editorconfig"), "utf8")).split("\n");

      assert.equal(written.length, expected.length);
      for (const [index, line] of expected.entries()) {
        assert.equal(written[index], line, `.editorconfig line ${index + 1}`);
      }
    });
  });
}

test(`vp create ${memberCase?.name}: Given the guard in a workspace member, when dry_run_apply and apply_recipe run, then both refuse because Git runs hooks from the repository root, and nothing is written`, async () => {
  assert.ok(memberCase);
  await using fixture = await copyRepositoryFixture(memberCase.fixture);
  await seedViteHooks(fixture.root);
  const before = await snapshotTree(fixture.root);

  await inDirectory(join(fixture.root, memberCase.directory), async () => {
    const { recipe } = await callMcpTool("compose_recipe", {
      profile: "default",
      packageManager: "pnpm",
      tools: memberCase.integrations,
      aiArtifacts: [guardRecipeItem],
    });
    const refusal =
      /skill-protected-branch-guard applies at the repository root, not in a workspace member/;

    await assert.rejects(callMcpTool("dry_run_apply", { recipe }, registry()), refusal);
    await assert.rejects(
      callMcpTool("apply_recipe", { recipe, noInstall: true }, registry()),
      refusal,
    );
  });

  assert.deepEqual(await snapshotTree(fixture.root), before, "the refusal changed a file");
});

test("vp create library: Given a registry stand-in that serves a payload whose hash differs from the lock, when apply runs, then it refuses and writes nothing", async () => {
  const [flowCase] = cases;
  await afterApply(flowCase, async ({ recipe, root, project }) => {
    // Without the stored package, apply restores the locked payload from the registry.
    await rm(join(project, ".calavera/packages"), { recursive: true });
    const served = registry();
    const tampered = {
      resolve: served.resolve,
      extract: async (/** @type {any} */ resolution, /** @type {string} */ destination) => ({
        ...(await served.extract(resolution, destination)),
        payloadHash: "f".repeat(64),
      }),
    };
    // The refused restore leaves its staging directory, which holds no project file.
    const snapshot = async () =>
      new Map(
        [...(await snapshotTree(root))].filter(([path]) => !path.includes(".calavera/.staging")),
      );
    const before = await snapshot();

    await inDirectory(project, () =>
      assert.rejects(
        callMcpTool("apply_recipe", { recipe, noInstall: true }, tampered),
        /Locked payload hash mismatch for skill-protected-branch-guard/,
      ),
    );

    assert.deepEqual(await snapshot(), before, "the refused apply changed a file");
  });
});
