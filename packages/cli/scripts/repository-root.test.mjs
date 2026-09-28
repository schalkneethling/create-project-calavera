// Issue #550: github-repository-controls is root-only. GitHub reads `.github/`
// only at the repository root, so applying the integration from a workspace
// member is refused with a hard stop, before any file is planned or written.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtempDisposable, readFile, readdir, realpath, writeFile } from "node:fs/promises";
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
const repositoryControlsOptions = { repository: "octocat/example" };
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
      `github-repository-controls applies at the repository root, not in a workspace member. This project is ${member}; the repository root is ${root}. Run Calavera there (cd ${root} && npm create project-calavera apply -- --dry-run), or remove github-repository-controls from this recipe.`,
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
      /Run Calavera there \(cd .+ && pnpm dlx create-project-calavera apply --dry-run\)/,
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
      (/** @type {{ code: number, stderr: string }} */ error) => {
        assert.equal(error.code, 1, args.join(" "));
        assert.match(error.stderr, /github-repository-controls applies at the repository root/);
        assert.ok(error.stderr.includes(`the repository root is ${repository.root}.`));
        return true;
      },
    );
  }

  assert.deepEqual(await snapshotTree(repository.root), before, "the refusal changed a file");
});

test("dry_run_apply at the repository root still plans the repository-controls files", async () => {
  await using repository = await createRepository();

  const dryRun = await inDirectory(repository.root, () =>
    callMcpTool("dry_run_apply", { recipe: repositoryControlsRecipe() }),
  );
  const writes = dryRun.result.changes
    .filter(({ type }) => type === "write")
    .map(({ path }) => path);

  for (const { path } of githubRepositoryControlManagedFiles(repositoryControlsOptions)) {
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
