// Issue #429: inspect_project reports a package.json that does not parse, or that
// parses to something other than an object, as an error finding instead of
// rejecting, and still reports what does not need the manifest.
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
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-invalid-manifest-"));

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
  const finding = findings.find(({ kind }) => kind === "package-json-invalid");

  assert.ok(finding, `Expected a package-json-invalid finding: ${JSON.stringify(findings)}`);
  assert.equal(finding.severity, "error");
  assert.equal(finding.path, "package.json");
  assert.ok(finding.message.includes(cause), `Expected "${cause}" in: ${finding.message}`);
  assert.ok(findings.some(({ kind }) => kind === "multiple-lockfiles"));

  return finding;
}

test("inspectProject degrades an unparseable package.json to an error finding and writes nothing", async () => {
  await inBrokenProject(async () => {
    const before = await snapshotDirectory();
    const inspection = await inspectProject();

    assertDegraded(inspection.findings, `could not be parsed: ${parseError}`);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("inspect_project over MCP returns the invalid-manifest finding instead of an error", async () => {
  await inBrokenProject(async () => {
    const before = await snapshotDirectory();
    const response = await callMcpTool("inspect_project");

    assertDegraded(response.findings, `could not be parsed: ${parseError}`);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

// Each of these parses, so the finding must not claim a parse failure. Arrays and
// primitives other than null do not crash inspection, but must not be inspected
// as if they were an empty manifest.
for (const manifest of ["null", "[]", '"text"', "42", "true"]) {
  test(`a manifest that parses to ${manifest} is reported as not containing a JSON object`, async () => {
    await inBrokenProject(async () => {
      const before = await snapshotDirectory();
      const inspection = await inspectProject();
      const finding = assertDegraded(inspection.findings, "does not contain a JSON object");

      assert.equal(finding.message.includes("could not be parsed"), false, finding.message);
      assert.equal(inspection.packageManager, undefined);
      assert.deepEqual(await snapshotDirectory(), before);
    }, manifest);
  });
}

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
