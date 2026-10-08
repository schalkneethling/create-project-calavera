// Issue #429: inspect_project reports an unparseable package.json as an error
// finding instead of rejecting, and still reports what does not need the manifest.
import assert from "node:assert/strict";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { inspectProject } from "../src/index.js";
import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const parseError = (() => {
  try {
    JSON.parse("{");
  } catch (error) {
    return error.message;
  }
})();

/**
 * Runs `callback` in a temporary project with the given package.json and two lockfiles.
 *
 * @param {() => Promise<void>} callback
 * @param {string} [manifest]
 */
async function inBrokenProject(callback, manifest = "{") {
  const originalDirectory = process.cwd();
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-unparseable-manifest-"));

  try {
    process.chdir(project.path);
    await writeFile("package.json", manifest);
    await writeFile("package-lock.json", "{}\n");
    await writeFile("pnpm-lock.yaml", "lockfileVersion: 9\n");
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * @param {{ kind: string, severity: string, path?: string, message: string }[]} findings
 * @param {string} cause
 */
function assertDegraded(findings, cause) {
  const finding = findings.find(({ kind }) => kind === "package-json-unparseable");

  assert.ok(finding, `Expected a package-json-unparseable finding: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "error");
  assert.equal(finding.path, "package.json");
  assert.ok(finding.message.includes(cause), "The parse error message must be preserved.");
  assert.ok(findings.some(({ kind }) => kind === "multiple-lockfiles"));
}

test("inspectProject degrades an unparseable package.json to an error finding and writes nothing", async () => {
  await inBrokenProject(async () => {
    const before = await snapshotDirectory();
    const inspection = await inspectProject();

    assertDegraded(inspection.findings, parseError);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("inspect_project over MCP returns the unparseable-manifest finding instead of an error", async () => {
  await inBrokenProject(async () => {
    const before = await snapshotDirectory();
    const response = await callMcpTool("inspect_project");

    assertDegraded(response.findings, parseError);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("a manifest that parses to a non-object is reported the same way", async () => {
  await inBrokenProject(async () => {
    const inspection = await inspectProject();

    assertDegraded(inspection.findings, "package.json must contain a JSON object");
  }, "null");
});

test("manifest-dependent findings are omitted when package.json is unparseable", async () => {
  await inBrokenProject(async () => {
    const inspection = await inspectProject(buildRecipe("default", ["stylelint"], "npm"));
    const kinds = inspection.findings.map(({ kind }) => kind);

    assert.equal(inspection.packageManager, undefined);
    for (const kind of [
      "package-manager",
      "package-manager-mismatch",
      "existing-package-script",
      "legacy-package-script",
      "legacy-package-script-conflict",
    ]) {
      assert.equal(kinds.includes(kind), false, `${kind} must not appear: ${kinds.join(", ")}`);
    }
  }, '{"packageManager":"npm@10.9.0",}');
});
