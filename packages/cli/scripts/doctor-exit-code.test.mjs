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
 * Runs doctor in `cwd` and resolves with its exit code, whatever it is.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runDoctor(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, "doctor", ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolve({ code: error ? Number(error.code) : 0, stdout, stderr });
      },
    );
  });
}

const outputModes = [
  { label: "text", args: [] },
  { label: "--json", args: ["--json"] },
];

for (const { label, args } of outputModes) {
  test(`doctor exits 1 when it reports an error (${label} output)`, async () => {
    // No calavera.config.json: doctor reports "Missing calavera.config.json" as an error.
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
      assert.match(stderr + stdout, /Missing calavera\.config\.json/);
    }
  });

  test(`doctor exits 0 when it reports only warnings (${label} output)`, async () => {
    // No package.json: doctor reports it as a warning, which stays advisory.
    await using fixture = await createTemporaryFixture("doctor-exit-warning", {
      "calavera.config.json": emptyRecipe,
    });

    const { code, stdout, stderr } = await runDoctor(fixture.root, args);

    assert.equal(code, 0, `doctor exited ${code}\n${stdout}\n${stderr}`);
    if (label === "--json") {
      const report = JSON.parse(stdout);
      assert.equal(report.ok, true);
      assert.deepEqual(
        report.issues.map(({ level }) => level),
        ["warning"],
      );
    }
  });

  test(`doctor exits 0 when the project is healthy (${label} output)`, async () => {
    await using fixture = await createTemporaryFixture("doctor-exit-healthy", {
      "calavera.config.json": emptyRecipe,
      "package.json": json({ name: "doctor-exit-healthy", private: true }),
    });

    const { code, stdout, stderr } = await runDoctor(fixture.root, args);

    assert.equal(code, 0, `doctor exited ${code}\n${stdout}\n${stderr}`);
    if (label === "--json") {
      assert.deepEqual(JSON.parse(stdout), { command: "doctor", ok: true, issues: [] });
    } else {
      assert.match(stdout + stderr, /Calavera doctor found no issues\./);
    }
  });
}
