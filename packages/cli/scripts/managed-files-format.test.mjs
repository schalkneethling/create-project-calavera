// Issue #669: in a Vite+ project, `vp check` runs `vp fmt --check`, so every file Calavera writes
// must already be in the shape the project's formatter produces. Calavera formats in memory,
// before the dry run, with the project's own `vp fmt --stdin-filepath`, and never formats a file
// after writing it, because the managed-file comparison relies on the bytes it wrote.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { agentBootstrap, applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import {
  CALAVERA_EDITORCONFIG,
  editorConfigFormattingChange,
  renderEditorConfig,
} from "../src/utils/editorconfig.js";
import { formatGeneratedText } from "../src/utils/generated-text.js";
import { loadProjectFormatter } from "../src/utils/project-formatter.js";
import {
  copyReleaseFixture,
  createTemporaryFixture,
  json,
  releaseFixturePath,
  writeVitePlusFormatter,
} from "./vite-plus-fixtures.mjs";

const recipe = buildRecipe(
  "default",
  ["editorconfig", "stylelint", "html-validate", "knip", "github-repository-controls"],
  "pnpm",
  [],
  { "github-repository-controls": { repository: "example/library", defaultBranch: "main" } },
);
const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};
const bootstrapOptions = {
  json: true,
  assumeYes: true,
  mcpHarness: /** @type {const} */ ("claude-code"),
};

/**
 * Runs `callback` with `directory` as the working directory, as the CLI runs.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

/**
 * Runs the project's own `vp fmt` with `args`, as `vp check` does.
 *
 * @param {string} root
 * @param {string[]} args
 */
function vpFmt(root, args) {
  return spawnSync(
    process.execPath,
    [join(root, "node_modules/vite-plus/bin/vp"), "fmt", ...args],
    {
      cwd: root,
      encoding: "utf8",
    },
  );
}

/**
 * The paths of the files Calavera wrote, from the changes it reported.
 *
 * @param {{ type: string, path?: string }[]} changes
 */
function writtenPaths(changes) {
  return changes
    .filter(({ type, path }) => (type === "write" || type === "update") && path !== undefined)
    .map(({ path }) => /** @type {string} */ (path));
}

/**
 * Applies the recipe and sets up agent guidance in a copy of the `vp create` library fixture.
 *
 * @param {string} root
 */
async function applyAndBootstrap(root) {
  return inDirectory(root, async () => {
    const applied = await applyRecipeObject(recipe, applyOptions);
    const bootstrapped = await agentBootstrap(bootstrapOptions);
    return [...writtenPaths(applied.changes), ...writtenPaths(bootstrapped.changes)];
  });
}

test("Given a new Vite+ project, when Calavera applies a recipe and sets up agent guidance, then vp fmt --check reports nothing", async () => {
  await using project = await copyReleaseFixture("library");
  const written = await applyAndBootstrap(project.root);

  // The seven files #669 found failing, so the check below is known to cover them.
  for (const path of [
    ".github/repository-controls.json",
    ".htmlvalidate.json",
    ".mcp.json",
    ".stylelintrc.json",
    "AGENTS.md",
    "calavera.config.json",
    "docs/repository-controls.md",
  ]) {
    assert.ok(written.includes(path), `Calavera did not write ${path}`);
  }

  const check = vpFmt(project.root, ["--check"]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
});

test("Given guidance appended to an existing AGENTS.md in a Vite+ project, then vp fmt --check reports nothing", async () => {
  await using project = await copyReleaseFixture("library");
  await writeFile(join(project.root, "AGENTS.md"), "# Project guidance\n\nKeep it small.\n");

  await inDirectory(project.root, () =>
    agentBootstrap({ ...bootstrapOptions, agentsMd: "append" }),
  );

  assert.match(await readFile(join(project.root, "AGENTS.md"), "utf8"), /^# Project guidance\n/);
  const check = vpFmt(project.root, ["--check", "AGENTS.md"]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
});

test("Given a Vite+ project, when vp fmt formats it after apply, then nothing changes and a re-apply reports no drift", async () => {
  await using project = await copyReleaseFixture("library");
  // A skill is reported as its directory; its files are compared through the check above.
  const written = [];
  for (const path of await applyAndBootstrap(project.root)) {
    if ((await stat(join(project.root, path))).isFile()) written.push(path);
  }
  const before = await Promise.all(
    written.map((path) => readFile(join(project.root, path), "utf8")),
  );

  const format = vpFmt(project.root, ["--write", "."]);
  assert.equal(format.status, 0, `${format.stdout}${format.stderr}`);
  const after = await Promise.all(
    written.map((path) => readFile(join(project.root, path), "utf8")),
  );
  assert.deepEqual(
    written.filter((_path, index) => before[index] !== after[index]),
    [],
    "vp fmt changed files Calavera wrote",
  );

  await inDirectory(project.root, async () => {
    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true });
    assert.deepEqual(
      dryRun.changes.filter(({ type }) => type !== "unchanged").map(({ path }) => path),
      [],
    );
    assert.deepEqual(
      dryRun.projectInspection.findings.filter(({ severity }) => severity !== "info"),
      [],
    );

    const bootstrap = await agentBootstrap({ ...bootstrapOptions, dryRun: true });
    for (const path of ["AGENTS.md", ".mcp.json"]) {
      assert.deepEqual(
        bootstrap.changes.find((change) => change.path === path),
        { type: "skip", path, reason: "Already up to date." },
        path,
      );
    }
  });
});

test("Given a project Vite+ does not manage, when Calavera applies, then it writes its JSON unformatted", async () => {
  await using project = await createTemporaryFixture("unformatted", {
    "package.json": json({ name: "plain", scripts: {} }),
  });

  await inDirectory(project.root, () => applyRecipeObject(recipe, applyOptions));

  const htmlValidate = await readFile(join(project.root, ".htmlvalidate.json"), "utf8");
  assert.equal(htmlValidate, json(JSON.parse(htmlValidate)));
  assert.match(htmlValidate, /"extends": \[\n/);
});

test("Given a repository-controls doc that vp fmt reshaped under an earlier release, when apply runs, then it stops, and --reown-managed-files replaces the doc", async () => {
  await using project = await copyReleaseFixture("library");
  await applyAndBootstrap(project.root);
  const docs = join(project.root, "docs/repository-controls.md");
  // What Oxfmt made of the old template: the closing paragraph indented into the last list item.
  const reshaped = (await readFile(docs, "utf8")).replace(
    "\n\nThe generated script verifies",
    "\n  The generated script verifies",
  );
  await writeFile(docs, reshaped);

  await inDirectory(project.root, async () => {
    await assert.rejects(
      applyRecipeObject(recipe, applyOptions),
      /Refusing to overwrite existing managed file: docs\/repository-controls\.md/,
    );
    await applyRecipeObject(recipe, {
      ...applyOptions,
      reownManagedFiles: ["docs/repository-controls.md"],
    });
  });

  assert.match(await readFile(docs, "utf8"), /\n\nThe generated script verifies/);
  const check = vpFmt(project.root, ["--check", "docs/repository-controls.md"]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
});

test("formatGeneratedText formats JSON and Markdown only, and refuses Markdown that vite.config.ts printed into", async () => {
  await using project = await createTemporaryFixture("generated-text", {});
  const refuse = () => Promise.reject(new Error("the formatter was loaded"));
  assert.equal(
    await formatGeneratedText(".editorconfig", "root = true\n", refuse),
    "root = true\n",
  );

  await writeVitePlusFormatter(project.root, { banner: "dotenv: injected 2 variables" });
  const noisy = await loadProjectFormatter(project.root, "managed");
  await assert.rejects(
    formatGeneratedText("docs/notes.md", "# Notes\n", async () => noisy),
    /returned text for docs\/notes\.md that does not start with the line Calavera sent, "# Notes"\. It begins: "dotenv: injected 2 variables"\. Make sure vite\.config\.ts prints nothing/,
  );
});

test("Given a Vite+ project whose .editorconfig asks for CRLF line endings, when Calavera formats Markdown, then it keeps the formatter's CRLF text", async () => {
  await using project = await createTemporaryFixture("generated-text-crlf", {
    ".editorconfig": "root = true\n\n[*]\nend_of_line = crlf\n",
  });
  await writeVitePlusFormatter(project.root);
  const formatter = await loadProjectFormatter(project.root, "managed");

  assert.equal(
    await formatGeneratedText("docs/notes.md", "# Notes\n\nText.\n", async () => formatter),
    "# Notes\r\n\r\nText.\r\n",
  );
});

test("Given a Vite+ project inside a folder whose .editorconfig sets four-space indentation, when Calavera applies its .editorconfig, then the dry run and apply stop, and apply succeeds once the project has Calavera's .editorconfig", async () => {
  await using parent = await createTemporaryFixture("parent-editorconfig", {
    ".editorconfig": "root = true\n\n[*]\nindent_style = space\nindent_size = 4\n",
  });
  const root = join(parent.root, "library");
  await cp(releaseFixturePath("library"), root, { recursive: true });
  await writeVitePlusFormatter(root);
  const before = await readdir(root);
  const stop = new RegExp(
    `Calavera's \\.editorconfig would change how vp fmt formats \\S+: indent_size is 4 now \\(from ${RegExp.escape(join(parent.root, ".editorconfig"))}\\) and 2 after apply\\.`,
  );

  await inDirectory(root, async () => {
    await assert.rejects(applyRecipeObject(recipe, { ...applyOptions, dryRun: true }), stop);
    await assert.rejects(applyRecipeObject(recipe, applyOptions), stop);
  });
  assert.deepEqual(await readdir(root), before, "apply wrote files before it stopped");

  // The remedy the error names: the project's own .editorconfig, which apply then adopts.
  await writeFile(join(root, ".editorconfig"), renderEditorConfig(CALAVERA_EDITORCONFIG));
  await inDirectory(root, () => applyRecipeObject(recipe, applyOptions));
  const check = vpFmt(root, ["--check"]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
});

test("editorConfigFormattingChange reads the .editorconfig files Oxfmt reads and compares the settings Oxfmt uses", async () => {
  await using parent = await createTemporaryFixture("editorconfig-change", {
    ".editorconfig": "[*.md]\nmax_line_length = 80\n",
    "project/docs/.editorconfig": "root = true\n\n[*]\nindent_size = 8\n",
    "project/.editorconfig": "[*]\ntab_width = 4\nindent_size = unset\n",
  });
  const project = join(parent.root, "project");

  // tab_width stands in for the unset indent_size, as Oxfmt falls back to it.
  assert.deepEqual(
    await editorConfigFormattingChange(project, "knip.json", CALAVERA_EDITORCONFIG),
    {
      property: "indent_size",
      current: 4,
      planned: 2,
      sources: [join(project, ".editorconfig")],
    },
  );

  await writeFile(join(project, ".editorconfig"), "[*]\nend_of_line = lf\n");
  // docs/.editorconfig is ignored, because Oxfmt reads only from the project root upward, and the
  // parent's [*.md] section reaches the Markdown file only.
  assert.equal(
    await editorConfigFormattingChange(project, "docs/x.json", CALAVERA_EDITORCONFIG),
    undefined,
  );
  assert.equal(
    (await editorConfigFormattingChange(project, "docs/x.md", CALAVERA_EDITORCONFIG))?.property,
    "max_line_length",
  );

  // Calavera's own file at the project root is marked root = true, so nothing above it counts.
  await writeFile(join(project, ".editorconfig"), renderEditorConfig(CALAVERA_EDITORCONFIG));
  assert.equal(
    await editorConfigFormattingChange(project, "docs/x.md", CALAVERA_EDITORCONFIG),
    undefined,
  );
});

test("renderEditorConfig writes the .editorconfig Calavera has always written", () => {
  assert.equal(
    renderEditorConfig(CALAVERA_EDITORCONFIG),
    "root = true\n\n[*]\ncharset = utf-8\nend_of_line = lf\ninsert_final_newline = true\nindent_style = space\nindent_size = 2\ntrim_trailing_whitespace = true\n",
  );
});
