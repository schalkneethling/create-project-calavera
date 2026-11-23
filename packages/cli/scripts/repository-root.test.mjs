// Issue #550: github-repository-controls is root-only. GitHub reads `.github/`
// only at the repository root, so applying the integration from a workspace
// member is refused with a hard stop, before any file is planned or written.
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { githubRepositoryControlManagedFiles } from "../src/github-repository-controls.js";
import { applyRecipeObject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe, describeIntegrationResponse } from "../src/recipe.js";
import { findRepositoryRoot } from "../src/repository-root.js";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
// #844: apply refuses a recipe that does not record defaultBranch.
const repositoryControlsOptions = { repository: "octocat/example", defaultBranch: "main" };
const rootSentence = "Applies at the repository root.";

/**
 * A disposable repository with a `.git` directory at its root and a
 * workspace member at `packages/member`, each with its own package.json.
 */
async function createRepository() {
  const directory = await mkdtempDisposable(join(tmpdir(), "calavera-repository-root-"));
  const root = await realpath(directory.path);
  const member = join(root, "packages", "member");
  await mkdir(join(root, ".git"));
  await mkdir(member, { recursive: true });
  await writeFile(join(root, "package.json"), `${JSON.stringify({ scripts: {} }, null, 2)}\n`);
  await writeFile(join(member, "package.json"), `${JSON.stringify({ scripts: {} }, null, 2)}\n`);

  return {
    root,
    member,
    [Symbol.asyncDispose]: () => directory[Symbol.asyncDispose](),
  };
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

function repositoryControlsRecipe() {
  return buildRecipe("minimal", ["editorconfig", "github-repository-controls"], "npm", [], {
    "github-repository-controls": repositoryControlsOptions,
  });
}

/**
 * @param {string} member
 * @param {string} root
 */
function refusal(member, root) {
  const escape = (/** @type {string} */ value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    escape(
      `github-repository-controls applies at the repository root, not in a workspace member. This project is ${member}; the repository root is ${root}. Apply a recipe that selects github-repository-controls from the repository root (cd ${root} && npm create project-calavera apply -- --dry-run, adding --config <path> when the recipe is saved elsewhere), or remove github-repository-controls from this recipe.`,
    ),
  );
}

test("findRepositoryRoot returns the nearest ancestor with a .git directory", async () => {
  await using repository = await createRepository();

  assert.equal(findRepositoryRoot(repository.member), repository.root);
  assert.equal(findRepositoryRoot(repository.root), repository.root);
});

test("findRepositoryRoot accepts a .git file, as git worktrees use", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "calavera-repository-root-"));
  const root = await realpath(directory.path);
  const member = join(root, "packages", "member");
  await mkdir(member, { recursive: true });
  await writeFile(join(root, ".git"), "gitdir: /elsewhere/.git/worktrees/example\n");

  assert.equal(findRepositoryRoot(member), root);
});

test("findRepositoryRoot returns undefined when no ancestor has a .git entry", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "calavera-repository-root-"));
  const root = await realpath(directory.path);
  const member = join(root, "packages", "member");
  await mkdir(member, { recursive: true });

  assert.equal(findRepositoryRoot(member), undefined);
});

test("findRepositoryRoot treats a file on the path as no .git entry", async () => {
  await using repository = await createRepository();
  const file = join(repository.root, "not-a-directory");
  await writeFile(file, "");

  assert.equal(findRepositoryRoot(join(file, "nested")), repository.root);
});

test(
  "findRepositoryRoot propagates file system errors other than a missing entry",
  { skip: process.platform === "win32" || process.getuid?.() === 0 },
  async () => {
    await using repository = await createRepository();
    const sealed = join(repository.root, "sealed");
    await mkdir(sealed);
    await chmod(sealed, 0o000);

    try {
      assert.throws(
        () => findRepositoryRoot(sealed),
        (/** @type {NodeJS.ErrnoException} */ error) => error.code === "EACCES",
      );
    } finally {
      await chmod(sealed, 0o755);
    }
  },
);

test("dry_run_apply and apply_recipe from a workspace member refuse github-repository-controls and write nothing", async () => {
  await using repository = await createRepository();
  const before = await snapshotTree(repository.root);
  const recipe = repositoryControlsRecipe();

  await inDirectory(repository.member, async () => {
    await assert.rejects(
      callMcpTool("dry_run_apply", { recipe }),
      refusal(repository.member, repository.root),
    );
    await assert.rejects(
      callMcpTool("apply_recipe", { recipe, noInstall: true }),
      refusal(repository.member, repository.root),
    );
    await assert.rejects(
      applyRecipeObject(recipe, { json: true, noInstall: true, assumeYes: true }),
      refusal(repository.member, repository.root),
    );
  });

  assert.deepEqual(await snapshotTree(repository.root), before, "the refusal changed a file");
});

test("the refusal names the recipe package manager's command", async () => {
  await using repository = await createRepository();
  const recipe = buildRecipe("minimal", ["github-repository-controls"], "pnpm", [], {
    "github-repository-controls": repositoryControlsOptions,
  });

  await inDirectory(repository.member, async () => {
    await assert.rejects(
      callMcpTool("dry_run_apply", { recipe }),
      /from the repository root \(cd .+ && pnpm dlx create-project-calavera apply --dry-run, adding --config <path>/,
    );
  });
});

test("CLI apply and apply --dry-run from a workspace member refuse github-repository-controls and write nothing", async () => {
  await using repository = await createRepository();
  await writeFile(
    join(repository.member, "calavera.config.json"),
    `${JSON.stringify(repositoryControlsRecipe(), null, 2)}\n`,
  );
  const before = await snapshotTree(repository.root);

  for (const args of [
    ["apply", "--dry-run", "--json"],
    ["apply", "--yes", "--no-install", "--json"],
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [cliPath, ...args], { cwd: repository.member }),
      (/** @type {{ code: number, stdout: string }} */ error) => {
        assert.equal(error.code, 1, args.join(" "));
        // With --json, the refusal is a JSON result (#1227).
        const { message } = JSON.parse(error.stdout).issues[0];
        assert.match(message, /github-repository-controls applies at the repository root/);
        assert.ok(message.includes(`the repository root is ${repository.root}.`));
        return true;
      },
    );
  }

  assert.deepEqual(await snapshotTree(repository.root), before, "the refusal changed a file");
});

/**
 * The issues `doctor --json` reports in `cwd`. doctor exits 1 when it reports an error (#1030), so
 * the exit code is checked against `ok` instead of being treated as a failure.
 *
 * @param {string} cwd
 * @returns {Promise<{ ok: boolean, issues: { level: string, message: string }[] }>}
 */
async function doctorReport(cwd) {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cliPath, "doctor", "--json"], {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NO_COLOR: "1" },
  });
  assert.ok(status === 0 || status === 1, `doctor exited ${status}\n${stderr}`);
  const report = JSON.parse(stdout);
  assert.equal(status, report.ok ? 0 : 1, `doctor exited ${status}\n${stderr}`);
  return report;
}

// #997: doctor names apply's refusal instead of only the root-only integration's missing files.
// The pnpm recipe shows that doctor names the same package manager's command as apply.
for (const packageManager of ["npm", "pnpm"]) {
  test(`doctor from a workspace member reports apply's refusal of a root-only integration as an error (${packageManager})`, async () => {
    await using repository = await createRepository();
    const recipe = buildRecipe(
      "minimal",
      ["editorconfig", "github-repository-controls"],
      packageManager,
      [],
      { "github-repository-controls": repositoryControlsOptions },
    );
    await writeFile(
      join(repository.member, "calavera.config.json"),
      `${JSON.stringify(recipe, null, 2)}\n`,
    );
    const applyRefusal = await inDirectory(repository.member, () =>
      applyRecipeObject(recipe, { json: true, dryRun: true, assumeYes: true }).then(
        () => assert.fail("apply did not refuse the recipe"),
        (/** @type {Error} */ error) => error.message,
      ),
    );
    assert.match(applyRefusal, /github-repository-controls applies at the repository root/);
    assert.ok(
      applyRefusal.includes(
        packageManager === "pnpm"
          ? "pnpm dlx create-project-calavera apply --dry-run"
          : "npm create project-calavera apply -- --dry-run",
      ),
      applyRefusal,
    );

    const report = await doctorReport(repository.member);

    assert.equal(report.ok, false);
    assert.deepEqual(
      report.issues.filter(({ level }) => level === "error"),
      [{ level: "error", message: applyRefusal }],
    );
  });
}

test("doctor at the repository root does not report the root-only refusal", async () => {
  await using repository = await createRepository();
  await writeFile(
    join(repository.root, "calavera.config.json"),
    `${JSON.stringify(repositoryControlsRecipe(), null, 2)}\n`,
  );

  const report = await doctorReport(repository.root);

  assert.equal(report.ok, true);
  assert.ok(
    report.issues.every(({ message }) => !message.includes("applies at the repository root")),
    JSON.stringify(report.issues),
  );
});

test("doctor reads package.json only for a root-only integration outside the repository root", async () => {
  await using repository = await createRepository();
  // An unreadable package.json and an unsupported package manager do not stop doctor when the
  // recipe selects no root-only integration, as before #997.
  await writeFile(join(repository.member, "package.json"), "{bad");
  await writeFile(
    join(repository.member, "calavera.config.json"),
    `${JSON.stringify({ ...buildRecipe("minimal", ["editorconfig"], "npm"), packageManager: "deno" })}\n`,
  );

  const report = await doctorReport(repository.member);

  assert.equal(report.ok, true, JSON.stringify(report.issues));
});

// #1031: apply's second member refusal, for an artifact that writes Git hooks. doctor reports it
// with apply's own message, naming the same package manager's command as apply.
const gitHookArtifactId = "skill-protected-branch-guard";

/**
 * The message apply stops with for `recipe` in `cwd`.
 *
 * @param {string} cwd
 * @param {Record<string, unknown>} recipe
 * @returns {Promise<string>}
 */
function applyRefusalIn(cwd, recipe) {
  return inDirectory(cwd, () =>
    applyRecipeObject(recipe, { json: true, dryRun: true, assumeYes: true }).then(
      () => assert.fail("apply did not refuse the recipe"),
      (/** @type {Error} */ error) => error.message,
    ),
  );
}

/** @param {string} packageManager */
function gitHookRecipe(packageManager) {
  return {
    ...buildRecipe("minimal", ["editorconfig"], packageManager),
    ai: [{ id: gitHookArtifactId }],
  };
}

for (const packageManager of ["npm", "pnpm"]) {
  test(`doctor from a workspace member reports apply's refusal of a Git-hook artifact as an error (${packageManager})`, async () => {
    await using repository = await createRepository();
    const recipe = gitHookRecipe(packageManager);
    await writeFile(
      join(repository.member, "calavera.config.json"),
      `${JSON.stringify(recipe, null, 2)}\n`,
    );
    const applyRefusal = await applyRefusalIn(repository.member, recipe);
    assert.ok(
      applyRefusal.startsWith(
        `${gitHookArtifactId} applies at the repository root, not in a workspace member. It writes Git hooks`,
      ),
      applyRefusal,
    );
    assert.ok(
      applyRefusal.includes(
        packageManager === "pnpm"
          ? "pnpm dlx create-project-calavera apply --dry-run"
          : "npm create project-calavera apply -- --dry-run",
      ),
      applyRefusal,
    );

    const report = await doctorReport(repository.member);

    assert.equal(report.ok, false);
    assert.deepEqual(
      report.issues.filter(({ level }) => level === "error"),
      [{ level: "error", message: applyRefusal }],
    );
  });
}

test("doctor at the repository root does not report the Git-hook refusal", async () => {
  await using repository = await createRepository();
  await writeFile(
    join(repository.root, "calavera.config.json"),
    `${JSON.stringify(gitHookRecipe("npm"), null, 2)}\n`,
  );

  const report = await doctorReport(repository.root);

  assert.equal(report.ok, true, JSON.stringify(report.issues));
  assert.ok(
    report.issues.every(({ message }) => !message.includes("applies at the repository root")),
    JSON.stringify(report.issues),
  );
});

test("doctor from a workspace member reports both refusals when the recipe selects a root-only integration and a Git-hook artifact", async () => {
  await using repository = await createRepository();
  const recipe = { ...repositoryControlsRecipe(), ai: [{ id: gitHookArtifactId }] };
  await writeFile(
    join(repository.member, "calavera.config.json"),
    `${JSON.stringify(recipe, null, 2)}\n`,
  );
  // apply stops at the first refusal, so each message comes from a recipe that selects only one.
  const rootOnlyRefusal = await applyRefusalIn(repository.member, repositoryControlsRecipe());
  const gitHookRefusal = await applyRefusalIn(repository.member, gitHookRecipe("npm"));
  assert.equal(await applyRefusalIn(repository.member, recipe), rootOnlyRefusal);

  const report = await doctorReport(repository.member);

  assert.equal(report.ok, false);
  assert.deepEqual(
    report.issues.filter(({ level }) => level === "error"),
    [
      { level: "error", message: rootOnlyRefusal },
      { level: "error", message: gitHookRefusal },
    ],
  );
});

test("dry_run_apply at the repository root still plans the repository-controls files", async () => {
  await using repository = await createRepository();

  const dryRun = await inDirectory(repository.root, () =>
    callMcpTool("dry_run_apply", { recipe: repositoryControlsRecipe() }),
  );
  const writes = dryRun.result.changes
    .filter(({ type }) => type === "write")
    .map(({ path }) => path);

  for (const { path } of githubRepositoryControlManagedFiles(repositoryControlsOptions, [])) {
    assert.ok(writes.includes(path), `the dry run does not plan ${path}`);
  }
});

test("a workspace member may apply other integrations when the recipe leaves out github-repository-controls", async () => {
  await using repository = await createRepository();

  const dryRun = await inDirectory(repository.member, () =>
    callMcpTool("dry_run_apply", {
      recipe: buildRecipe("minimal", ["editorconfig"], "npm"),
    }),
  );

  assert.ok(dryRun.result.changes.some(({ path }) => path === ".editorconfig"));
});

test("explain_recipe and the catalog description say github-repository-controls applies at the repository root", async () => {
  await using repository = await createRepository();

  const explanation = await inDirectory(repository.root, () =>
    callMcpTool("explain_recipe", { recipe: repositoryControlsRecipe() }),
  );
  const reasons = Object.fromEntries(
    explanation.integrations.map(({ id, reason }) => [id, reason]),
  );

  assert.ok(reasons["github-repository-controls"].includes(rootSentence));
  assert.equal(reasons.editorconfig.includes(rootSentence), false);
  assert.ok(
    describeIntegrationResponse("github-repository-controls").description.includes(rootSentence),
  );
  assert.equal(
    describeIntegrationResponse("editorconfig").description.includes(rootSentence),
    false,
  );
});
