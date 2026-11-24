// @ts-check

/**
 * Issue #1130: the checks that ask "is this path in that folder or below it" use `isPathInside`
 * from `utils/fs.js` (#1026), which path-containment.test.mjs covers on POSIX and Windows. Each
 * test here goes through one caller and fails when that caller's check is removed. A path is
 * outside only when its relative path is `..`, starts with `..` and a separator, or is absolute
 * (owner decision on #1026), so a name that only starts with `..` is inside.
 *
 * The vp bin check is covered in dev-dependency-install.test.mjs, and `pathAtAncestor` in
 * manifest-decision.test.mjs.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import test from "node:test";

import { wiringFilesThatMention } from "../src/ai/artifact-wiring.js";
import { TemporaryFolderError, temporaryFolderLeftovers } from "../src/utils/cleanup.js";
import { CALAVERA_EDITORCONFIG, editorConfigFormattingChange } from "../src/utils/editorconfig.js";
import { assertSafeRelativePath, assertWorkspacePath } from "../src/utils/fs.js";
import { checkForNewerVersion } from "../src/version-notice.js";
import { createTemporaryFixture } from "./vite-plus-fixtures.mjs";

const outsideWorkspace = { message: "Path must stay inside the current project workspace." };

test("assertSafeRelativePath keeps a path in the folder and refuses the folder itself", () => {
  for (const path of ["a.json", "..recipe.json", "a/..b/c.json", "a/", "A.json"]) {
    assert.equal(assertSafeRelativePath(path), path, path);
  }
  // A `..` segment is refused even when the path stays inside, with either separator, and an
  // absolute path even when it names a file inside the folder.
  for (const path of ["a/../b.json", "a\\..\\b.json"]) {
    assert.throws(() => assertSafeRelativePath(path), outsideWorkspace, path);
  }
  const absoluteInside = join(process.cwd(), "a.json");
  for (const path of ["", ".", "./", "a/..", "..", "../a.json", "a/../../b.json", absoluteInside]) {
    assert.throws(() => assertSafeRelativePath(path), outsideWorkspace, path);
  }
});

// On Windows a drive-relative path such as `D:state.json` is not absolute, and has no `..`
// segment, so only the containment check sees that it resolves on another drive.
test("assertSafeRelativePath refuses, with Windows path rules, a path on another drive", () => {
  const root = "C:\\work\\project";
  for (const path of ["a.json", "..recipe.json", "a\\..b\\c.json", "a\\", "A.json"]) {
    assert.equal(assertSafeRelativePath(path, "Path", { pathRules: win32, root }), path, path);
  }
  for (const path of ["D:state.json", `${root}\\a.json`, "..\\a.json", "a\\..\\..\\b", "."]) {
    assert.throws(
      () => assertSafeRelativePath(path, "Path", { pathRules: win32, root }),
      outsideWorkspace,
      path,
    );
  }
});

test("assertWorkspacePath follows links, and keeps a name that only starts with ..", async (t) => {
  const parent = await realpath(await mkdtemp(join(tmpdir(), "calavera-1130-workspace-")));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "project");
  await mkdir(join(root, "..cache"), { recursive: true });
  await mkdir(join(parent, "project-two"));
  await symlink(join(parent, "project-two"), join(root, "linked-out"));
  await symlink(join(root, "..cache"), join(root, "linked-in"));

  for (const path of ["..cache/a.json", "..cache/", "linked-in/a.json", "new/a.json", "."]) {
    assert.equal(await assertWorkspacePath(path, root), resolve(root, path), path);
  }
  for (const path of ["linked-out/a.json", "linked-out", "../project-two/a.json", ".."]) {
    await assert.rejects(assertWorkspacePath(path, root), outsideWorkspace, path);
  }
});

test("temporaryFolderLeftovers notes a folder that only starts with .. as inside the project", () => {
  const cwd = process.cwd();
  const inside = "It is inside the project";
  /** @param {string} path */
  const reasonFor = (path) =>
    temporaryFolderLeftovers([new TemporaryFolderError(path, { code: "EBUSY" })])[0]?.reason ?? "";

  for (const path of [join(cwd, "..calavera-x"), join(cwd, ".calavera/.transactions/x/")]) {
    assert.match(reasonFor(path), new RegExp(inside), path);
  }
  // The comparison is lexical and case-sensitive on POSIX, so the working folder's name in
  // another letter case is a different folder.
  const otherCase = join(dirname(cwd), basename(cwd).toUpperCase(), "calavera-x");
  for (const path of [
    join(cwd, ".."),
    join(cwd, "../calavera-x"),
    "/calavera-elsewhere",
    otherCase,
  ]) {
    assert.doesNotMatch(reasonFor(path), new RegExp(inside), path);
  }
});

test("a copy in a folder inside node_modules whose name starts with .. is a project dependency", async (t) => {
  const project = await realpath(await mkdtemp(join(tmpdir(), "calavera-1130-dependency-")));
  t.after(() => rm(project, { recursive: true, force: true }));
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ devDependencies: { "create-project-calavera": "6.2.1" } }),
  );
  const update = "npm install --save-dev create-project-calavera@6.3.0";
  /** @param {string} packageRoot */
  const updateFor = async (packageRoot) => {
    await mkdir(packageRoot, { recursive: true });
    const result = await checkForNewerVersion({
      version: "6.2.1",
      options: { command: "init", json: false, checkUpdates: false },
      cwd: project,
      env: {},
      packageRoot,
      packageName: "create-project-calavera",
      resolveLatest: async () => "6.3.0",
      runCommand: (version) => `npx create-project-calavera@${version}`,
      updateCommand: async (version) => `npm install --save-dev create-project-calavera@${version}`,
    });
    return result.status === "newer" ? result.update : result.status;
  };

  assert.equal(await updateFor(join(project, "node_modules", "..store", "calavera")), update);
  // A link out of node_modules is followed, so its target is not the project's dependency.
  const elsewhere = await realpath(await mkdtemp(join(tmpdir(), "calavera-1130-elsewhere-")));
  t.after(() => rm(elsewhere, { recursive: true, force: true }));
  await symlink(elsewhere, join(project, "node_modules", "linked"));
  assert.equal(await updateFor(join(project, "node_modules", "linked")), undefined);
  assert.equal(await updateFor(join(project, "node_modules", "..", "calavera")), undefined);
});

// Oxfmt reads the .editorconfig files from the project root upward only, so a subfolder's file
// counts as missing, including in a subfolder whose name only starts with `..`.
test("editorConfigFormattingChange ignores a .editorconfig in a subfolder whose name starts with ..", async () => {
  await using project = await createTemporaryFixture("editorconfig-dotdot", {
    "..docs/.editorconfig": "root = true\n\n[*]\nindent_size = 8\n",
  });

  assert.equal(
    await editorConfigFormattingChange(project.root, "..docs/x.json", CALAVERA_EDITORCONFIG),
    undefined,
  );
});

test("wiringFilesThatMention counts a hook linked into the artifact's folder, and not one linked into a sibling whose name extends it", async () => {
  const skill = ".agents/skills/protected-branch-guard";
  await using project = await createTemporaryFixture("wiring-link-containment", {
    [`${skill}/..helper.mjs`]: "",
    [`${skill}-two/run.mjs`]: "",
  });
  await mkdir(join(project.root, ".vite-hooks"));
  await symlink(`../${skill}/..helper.mjs`, join(project.root, ".vite-hooks/pre-push"));
  await symlink(`../${skill}-two/run.mjs`, join(project.root, ".vite-hooks/pre-commit"));

  assert.deepEqual(await wiringFilesThatMention(skill, [], project.root), {
    mentions: [".vite-hooks/pre-push"],
    unresolved: [],
    unreadable: [],
  });
});
