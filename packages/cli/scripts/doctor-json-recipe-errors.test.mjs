// Issue #1141: when doctor cannot resolve the recipe, `doctor --json` still prints a JSON result,
// with the failure as an error issue, and exits 1, so a CI step that parses the output has a
// result to parse. Before, the error escaped doctor, and the CLI printed it as plain text on
// standard error with nothing on standard output. The text output reports the same error.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTemporaryFixture, json } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const RECIPE = "calavera.config.json";
// Not shaped like any token redactSecrets knows, so only the parse-error handling keeps it out.
const SECRET = "FAKE_SECRET_1141";

/**
 * Runs doctor in `cwd` and resolves with its exit code and output. A run killed by a signal
 * resolves with a null code, so it cannot pass as an exit 1.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runDoctor(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, "doctor", ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

const cases = [
  {
    label: "an unreadable recipe",
    // A directory at the recipe path exists, so doctor reads it, and the read fails with EISDIR.
    files: {},
    setup: (root) => mkdir(join(root, RECIPE)),
    expected: /EISDIR/,
  },
  {
    label: "a recipe that is not valid JSON",
    files: { [RECIPE]: `{\n  "integrations": [],\n  "profile": ${SECRET}\n}\n` },
    expected: /calavera\.config\.json.*line 3, column 14/s,
  },
  {
    label: "a recipe that is not a JSON object",
    files: { [RECIPE]: json([]) },
    expected: /calavera\.config\.json must contain a JSON object\./,
  },
  {
    label: "a recipe whose AI entry no catalog artifact provides",
    files: {
      [RECIPE]: json({
        version: 1,
        profile: "default",
        integrations: [],
        ai: [{ type: "skill", src: "skills/not-a-catalog-skill" }],
      }),
    },
    expected: /not-a-catalog-skill/,
  },
];

for (const { label, files, setup, expected } of cases) {
  test(`doctor --json prints a JSON result with the error as an issue for ${label}`, async () => {
    await using fixture = await createTemporaryFixture("doctor-json-recipe-error", {
      "package.json": json({ name: "doctor-json-recipe-error", private: true }),
      ...files,
    });
    await setup?.(fixture.root);

    const { code, stdout, stderr } = await runDoctor(fixture.root, ["--json"]);

    assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
    let report;
    assert.doesNotThrow(() => {
      report = JSON.parse(stdout);
    }, `doctor --json printed no JSON result:\n${stdout}\n${stderr}`);
    assert.equal(report.command, "doctor");
    assert.equal(report.ok, false);
    const errors = report.issues.filter(({ level }) => level === "error");
    assert.equal(errors.length, 1, stdout);
    assert.match(errors[0].message, expected);
    assert.ok(!`${stdout}${stderr}`.includes(SECRET), `The output quotes the recipe:\n${stdout}`);
  });

  test(`doctor reports the error for ${label} in its text output and exits 1`, async () => {
    await using fixture = await createTemporaryFixture("doctor-text-recipe-error", {
      "package.json": json({ name: "doctor-text-recipe-error", private: true }),
      ...files,
    });
    await setup?.(fixture.root);

    const { code, stdout, stderr } = await runDoctor(fixture.root, []);

    assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
    assert.match(`${stdout}${stderr}`, expected);
    assert.ok(!`${stdout}${stderr}`.includes(SECRET), `The output quotes the recipe:\n${stdout}`);
  });
}

test("doctor --json keeps the issues it found before the recipe failed to resolve", async () => {
  // No package.json: doctor reports that warning before it reads the recipe.
  await using fixture = await createTemporaryFixture("doctor-json-recipe-error-warning", {
    [RECIPE]: json([]),
  });

  const { code, stdout, stderr } = await runDoctor(fixture.root, ["--json"]);

  assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
  const report = JSON.parse(stdout);
  assert.deepEqual(
    report.issues.map(({ level }) => level),
    ["warning", "error"],
  );
  assert.match(report.issues[0].message, /Missing package\.json/);
});
