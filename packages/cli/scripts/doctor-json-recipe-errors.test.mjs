// Issue #1141: when doctor cannot resolve the recipe, `doctor --json` still prints a JSON result,
// with the failure as an error issue, and exits 1, so a CI step that parses the output has a
// result to parse. Before, the error escaped doctor, and the CLI printed it as plain text on
// standard error with nothing on standard output. The text output reports the same error.
import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
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
    label: "a recipe whose legacy AI entry has a source outside src/ai/",
    files: {
      [RECIPE]: json({
        version: 1,
        profile: "default",
        integrations: [],
        ai: [{ type: "skill", src: "skills/outside-src-ai" }],
      }),
    },
    expected: /AI item at index 0 source must stay within src\/ai\//,
  },
  {
    label: "a recipe whose package manager Calavera does not support",
    // From a workspace member, a root-only integration makes doctor resolve the package manager
    // apply would name; with no packageManager in package.json and no lockfile, that is the
    // recipe's, which recipeFromJSON accepts as any non-empty string.
    cwd: "member",
    files: {
      [`member/${RECIPE}`]: json({
        version: 1,
        profile: "default",
        packageManager: "deno",
        integrations: ["github-repository-controls"],
      }),
    },
    setup: async (root) => {
      execFileSync("git", ["init", "--quiet"], { cwd: root });
    },
    packageJSON: "member/package.json",
    expected: /Invalid package manager: deno\. Allowed values: npm, pnpm, yarn, bun\./,
  },
];

for (const { label, files, setup, expected, cwd = ".", packageJSON = "package.json" } of cases) {
  test(`doctor --json prints a JSON result with the error as an issue for ${label}`, async () => {
    await using fixture = await createTemporaryFixture("doctor-json-recipe-error", {
      [packageJSON]: json({ name: "doctor-json-recipe-error", private: true }),
      ...files,
    });
    await setup?.(fixture.root);

    const { code, stdout, stderr } = await runDoctor(join(fixture.root, cwd), ["--json"]);

    assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
    let report;
    assert.doesNotThrow(() => {
      report = JSON.parse(stdout);
    }, `doctor --json printed no JSON result:\n${stdout}\n${stderr}`);
    assert.equal(report.command, "doctor");
    assert.equal(report.ok, false);
    // The error that stopped doctor is its last issue, whatever doctor reported before it.
    const last = report.issues.at(-1);
    assert.equal(last?.level, "error", stdout);
    assert.match(last.message, expected);
    assert.ok(!`${stdout}${stderr}`.includes(SECRET), `The output quotes the recipe:\n${stdout}`);
  });

  test(`doctor reports the error for ${label} in its text output and exits 1`, async () => {
    await using fixture = await createTemporaryFixture("doctor-text-recipe-error", {
      [packageJSON]: json({ name: "doctor-text-recipe-error", private: true }),
      ...files,
    });
    await setup?.(fixture.root);

    const { code, stdout, stderr } = await runDoctor(join(fixture.root, cwd), []);

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

test("doctor prints the warnings it found before the recipe failed to resolve, then the error", async () => {
  // No package.json: doctor warns about it before it reads the recipe. Warnings and errors both
  // go to standard error, so their order there is the order doctor reported them.
  await using fixture = await createTemporaryFixture("doctor-text-recipe-error-warning", {
    [RECIPE]: json([]),
  });

  const { code, stdout, stderr } = await runDoctor(fixture.root, []);

  assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
  const warning = stderr.indexOf("Missing package.json");
  const error = stderr.indexOf("calavera.config.json must contain a JSON object.");
  assert.ok(warning !== -1, `doctor printed no warning:\n${stderr}`);
  assert.ok(error !== -1, `doctor printed no error:\n${stderr}`);
  assert.ok(warning < error, `doctor printed the error before the warning:\n${stderr}`);
});
