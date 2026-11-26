// Issue #1030: doctor's exit code follows its result, so a CI step that runs
// doctor fails when doctor reports an error. `ok` is false only when an issue
// has the level "error"; warnings stay advisory and doctor still exits 0.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTemporaryFixture, json } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

const emptyRecipe = json({
  version: 1,
  profile: "default",
  packageManager: "pnpm",
  integrations: [],
  scripts: {},
});

/**
 * Runs doctor in `cwd` and resolves with its exit code, whatever it is. A run killed by a signal
 * resolves with a null code, so it cannot pass as an exit 0.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runDoctor(cwd, args) {
  return new Promise((resolve) => {
    execFile(process.execPath, [cliPath, "doctor", ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout,
        stderr,
      });
    });
  });
}

const outputModes = [
  { label: "text", args: [] },
  { label: "--json", args: ["--json"] },
];

for (const { label, args } of outputModes) {
  test(`doctor exits 1 when it reports an error (${label} output)`, async () => {
    // No recipe, state, or lock: the project is unmanaged, an error (ADR-0020, owner decision 2).
    await using fixture = await createTemporaryFixture("doctor-exit-error", {
      "package.json": json({ name: "doctor-exit-error", private: true }),
    });

    const { code, stdout, stderr } = await runDoctor(fixture.root, args);

    assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
    if (label === "--json") {
      const report = JSON.parse(stdout);
      assert.equal(report.ok, false);
      assert.ok(report.issues.some(({ level }) => level === "error"));
    } else {
      assert.match(stderr + stdout, /Calavera does not manage this project/);
    }
  });

  test(`doctor exits 0 when it reports only warnings (${label} output)`, async () => {
    // No package.json, and a recipe apply has not applied yet: doctor reports both as warnings,
    // which stay advisory.
    await using fixture = await createTemporaryFixture("doctor-exit-warning", {
      "calavera.config.json": emptyRecipe,
    });

    const { code, stdout, stderr } = await runDoctor(fixture.root, args);

    assert.equal(code, 0, `doctor exited ${code}\n${stdout}\n${stderr}`);
    if (label === "--json") {
      const report = JSON.parse(stdout);
      assert.equal(report.ok, true);
      assert.deepEqual(
        report.issues.map(({ level, check }) => [level, check]),
        [
          ["warning", "phase"],
          ["warning", "project"],
        ],
      );
    } else {
      assert.match(stderr + stdout, /Missing package\.json/);
    }
  });

  test(`doctor exits 0 when the project is healthy (${label} output)`, async () => {
    // An applied project: the state records the profile, and nothing apply recorded changed.
    await using fixture = await createTemporaryFixture("doctor-exit-healthy", {
      "calavera.config.json": emptyRecipe,
      "package.json": json({ name: "doctor-exit-healthy", private: true }),
      ".calavera/state.json": json({ version: 1, profile: "default" }),
    });

    const { code, stdout, stderr } = await runDoctor(fixture.root, args);

    assert.equal(code, 0, `doctor exited ${code}\n${stdout}\n${stderr}`);
    if (label === "--json") {
      assert.deepEqual(JSON.parse(stdout), {
        command: "doctor",
        ok: true,
        phase: "applied",
        phaseLine: { level: "info", message: "The phase is applied." },
        issues: [{ level: "info", message: "The phase is applied.", check: "phase" }],
        artifacts: [],
        managedFiles: [],
      });
    } else {
      assert.equal(stdout, "The phase is applied.\nCalavera doctor found no issues.\n");
      assert.equal(stderr, "");
    }
  });
}
