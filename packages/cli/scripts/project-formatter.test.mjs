import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { loadProjectFormatter } from "../src/utils/project-formatter.js";
import {
  createTemporaryFixture,
  vitePlusFixtureRelease,
  writeVitePlusFormatter,
} from "./vite-plus-fixtures.mjs";

const loose =
  '{\n  "extends": [\n    "html-validate:recommended",\n    "html-validate:document"\n  ]\n}\n';

test("Given a Vite+ project, when Calavera formats a file, then it uses the project's own vp fmt and writes nothing", async () => {
  await using project = await createTemporaryFixture("formatter", {});
  await writeVitePlusFormatter(project.root);
  const formatter = await loadProjectFormatter(project.root, "managed");
  assert.equal(formatter.description, `vp fmt from vite-plus ${vitePlusFixtureRelease}`);
  assert.equal(
    await formatter.format(".htmlvalidate.json", loose),
    '{\n  "extends": ["html-validate:recommended", "html-validate:document"]\n}\n',
  );
  // The file name picks the language, so Markdown is formatted too.
  assert.equal(
    await formatter.format("AGENTS.md", "<!-- calavera-agent-bootstrap:start -->\n# Guidance\n"),
    "<!-- calavera-agent-bootstrap:start -->\n\n# Guidance\n",
  );
  assert.deepEqual(await readdir(project.root), ["node_modules"]);
});

test("Given a workspace member, when vite-plus is installed at the workspace root, then the member uses it", async () => {
  await using workspace = await createTemporaryFixture("formatter-workspace", {
    "packages/app/package.json": "{}\n",
  });
  await writeVitePlusFormatter(workspace.root);
  const formatter = await loadProjectFormatter(join(workspace.root, "packages/app"), "managed");
  assert.match(formatter.description, /^vp fmt from vite-plus /);
  assert.match(await formatter.format(".htmlvalidate.json", loose), /"extends": \["html/);
});

test("Given a project that does not use Vite+, when Calavera formats a file, then the text is kept as it is", async () => {
  await using project = await createTemporaryFixture("formatter-plain", {});
  // An installed vite-plus does not make a project a Vite+ project; detection decides that.
  await writeVitePlusFormatter(project.root);
  for (const status of /** @type {const} */ (["unmanaged", "unknown"])) {
    const formatter = await loadProjectFormatter(project.root, status);
    assert.equal(await formatter.format(".htmlvalidate.json", loose), loose, status);
    assert.match(formatter.description, /does not use Vite\+/, status);
  }
});

test("Given a Vite+ project without vite-plus installed, when the formatter loads, then it stops with the remedy and keeps the cause", async () => {
  await using project = await createTemporaryFixture("formatter-missing", {});
  await assert.rejects(loadProjectFormatter(project.root, "managed"), (error) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /uses Vite\+, but Calavera cannot find its vite-plus package/);
    assert.match(error.message, /Run vp install, then run Calavera again\./);
    assert.equal(/** @type {NodeJS.ErrnoException} */ (error.cause).code, "MODULE_NOT_FOUND");
    return true;
  });
});

test("Given a vite-plus without a vp command, when the formatter loads, then it names the version and the remedy", async () => {
  await using project = await createTemporaryFixture("formatter-no-bin", {});
  await writeVitePlusFormatter(project.root, { bin: {} });
  await assert.rejects(
    loadProjectFormatter(project.root, "managed"),
    new RegExp(`vite-plus ${vitePlusFixtureRelease} in .* has no vp command.*Run vp install`),
  );
});

test("Given formatter settings in the project, when Calavera formats a file, then they apply as they do for vp check", async () => {
  await using project = await createTemporaryFixture("formatter-settings", {
    ".oxfmtrc.json": '{ "useTabs": true, "ignorePatterns": ["vendor/**"] }\n',
  });
  await writeVitePlusFormatter(project.root);
  const formatter = await loadProjectFormatter(project.root, "managed");
  assert.equal(
    await formatter.format(".htmlvalidate.json", loose),
    '{\n\t"extends": ["html-validate:recommended", "html-validate:document"]\n}\n',
  );
  // vp check skips an ignored file, so Calavera keeps the text as it is.
  assert.equal(await formatter.format("vendor/x.json", loose), loose);
});

test("Given text the project's Oxfmt cannot parse, when it is formatted, then the error names the file and shows where", async () => {
  await using project = await createTemporaryFixture("formatter-error", {});
  await writeVitePlusFormatter(project.root);
  const formatter = await loadProjectFormatter(project.root, "managed");
  await assert.rejects(
    formatter.format(".claude/settings.json", '{"a": [1,'),
    /vp fmt from vite-plus .* could not format \.claude\/settings\.json \(exit code 2\):\n.*Unexpected token/s,
  );
});
