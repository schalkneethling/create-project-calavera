// Issue #1206: `doctor --json` prints a JSON result on every failure path, not only when the
// recipe cannot be resolved (#1141). An unreadable or invalid `.calavera/state.json` stops doctor
// before it can classify, so it prints `{ command, ok: false, issues }` with the error as the last
// issue (ADR-0020 Amendment 1). A wiring file Calavera recorded that cannot be read is an error
// finding, and doctor goes on to check the rest. Either way doctor exits 1, keeps the issues it
// found before, and quotes no file text (#1157). Before, both failures escaped doctor, and the CLI
// printed them as plain text on standard error with nothing on standard output.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTemporaryFixture, json } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const RECIPE = "calavera.config.json";
const STATE = ".calavera/state.json";
// Not shaped like any token redactSecrets knows, so only the parse-error handling keeps it out.
const SECRET = "FAKE_SECRET_1206";
const id = "skill-protected-branch-guard";
const hookLine = `node .agents/skills/protected-branch-guard/scripts/guard.mjs pre-commit main`;
const recipe = json({ version: 1, profile: "default", integrations: [] });

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
    execFile(process.execPath, [cliPath, "doctor", ...args], { cwd }, (error, stdout, stderr) => {
      resolve({
        code: error ? (typeof error.code === "number" ? error.code : null) : 0,
        stdout,
        stderr,
      });
    });
  });
}

const cases = [
  {
    label: "a state file that is not valid JSON",
    stops: true,
    files: { [STATE]: `{\n  "version": 1,\n  "profile": ${SECRET}\n}\n` },
    expected: /doctor cannot use \.calavera\/state\.json\.[\s\S]*state\.json.*line 3, column 14/,
  },
  {
    label: "a state file that is not a JSON object",
    stops: true,
    files: { [STATE]: json([SECRET]) },
    expected:
      /doctor cannot use \.calavera\/state\.json\.[\s\S]*Calavera state file must contain a JSON object\./,
  },
  {
    label: "a state file whose wiring records are invalid",
    stops: true,
    files: { [STATE]: json({ version: 1, aiWiring: [{ artifact: SECRET, viteHooks: [] }] }) },
    expected:
      /doctor cannot use \.calavera\/state\.json\.[\s\S]*Calavera state contains invalid aiWiring entries\./,
  },
  {
    label: "a state file that is a directory",
    stops: true,
    files: {},
    setup: (root) => mkdir(join(root, STATE), { recursive: true }),
    expected: /doctor cannot use \.calavera\/state\.json\.[\s\S]*EISDIR/,
  },
  {
    label: "a recorded Vite+ hook file that is a directory",
    files: {
      [STATE]: json({
        version: 1,
        aiWiring: [{ artifact: id, viteHooks: { "pre-commit": hookLine } }],
      }),
    },
    setup: (root) => mkdir(join(root, ".vite-hooks/pre-commit"), { recursive: true }),
    expected:
      /^\.vite-hooks\/pre-commit cannot be read \(EISDIR\), so doctor cannot check the skill-protected-branch-guard block Calavera recorded there, and the next apply stops\./,
  },
  {
    label: "a recorded Claude Code settings file that is a directory",
    files: {
      [STATE]: json({
        version: 1,
        aiWiring: [{ artifact: id, claudeCode: { SessionStart: [{ hooks: [] }] } }],
      }),
    },
    setup: (root) => mkdir(join(root, ".claude/settings.json"), { recursive: true }),
    expected:
      /^\.claude\/settings\.json cannot be read \(EISDIR\), so doctor cannot check the skill-protected-branch-guard groups Calavera recorded there, and the next apply stops\./,
  },
];

for (const { label, files, setup, expected, stops = false } of cases) {
  test(`doctor --json prints a JSON result with the error as an issue for ${label}`, async () => {
    await using fixture = await createTemporaryFixture("doctor-json-state-error", {
      "package.json": json({ name: "doctor-json-state-error", private: true }),
      [RECIPE]: recipe,
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
    // ADR-0020 Amendment 1: a run that stops before it classifies derives no phase. An unreadable
    // wiring file does not stop doctor, so that run classifies.
    if (stops) {
      assert.ok(!("phase" in report), stdout);
    }
    const last = report.issues.at(-1);
    assert.equal(last?.level, "error", stdout);
    assert.match(last.message, expected);
    assert.ok(!`${stdout}${stderr}`.includes(SECRET), `The output quotes the file:\n${stdout}`);
  });

  test(`doctor reports the error for ${label} in its text output and exits 1`, async () => {
    await using fixture = await createTemporaryFixture("doctor-text-state-error", {
      "package.json": json({ name: "doctor-text-state-error", private: true }),
      [RECIPE]: recipe,
      ...files,
    });
    await setup?.(fixture.root);

    const { code, stdout, stderr } = await runDoctor(fixture.root, []);

    assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
    // The text output prints the finding under the artifact's line, without the artifact's ID.
    assert.match(
      stderr,
      new RegExp(
        expected.source.replace(/^\^/, "").replace("the skill-protected-branch-guard ", "the "),
        expected.flags,
      ),
    );
    if (!stops)
      assert.match(
        stdout,
        /^Artifacts:\n {2}skill-protected-branch-guard: Calavera found a problem with the wiring apply recorded for it\.$/m,
      );
    assert.ok(!`${stdout}${stderr}`.includes(SECRET), `The output quotes the file:\n${stdout}`);
  });
}

test("doctor --json keeps the issues it found before the state file failed to read", async () => {
  // No package.json: doctor reports that warning before it reads the state file.
  await using fixture = await createTemporaryFixture("doctor-json-state-error-warning", {
    [RECIPE]: recipe,
    [STATE]: json([]),
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

test("doctor prints the warnings it found before the state file failed to read, then the error", async () => {
  await using fixture = await createTemporaryFixture("doctor-text-state-error-warning", {
    [RECIPE]: recipe,
    [STATE]: json([]),
  });

  const { code, stdout, stderr } = await runDoctor(fixture.root, []);

  assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
  const warning = stderr.indexOf("Missing package.json");
  const error = stderr.indexOf("doctor cannot use .calavera/state.json.");
  assert.ok(warning !== -1, `doctor printed no warning:\n${stderr}`);
  assert.ok(error !== -1, `doctor printed no error:\n${stderr}`);
  assert.ok(warning < error, `doctor printed the error before the warning:\n${stderr}`);
});

test("doctor --json keeps checking the wiring after a recorded file it cannot read", async () => {
  // The pre-commit file is a directory; the pre-push file lacks the recorded block, which doctor
  // still reports after the error.
  await using fixture = await createTemporaryFixture("doctor-json-wiring-error-continues", {
    "package.json": json({ name: "doctor-json-wiring-error-continues", private: true }),
    [RECIPE]: recipe,
    [STATE]: json({
      version: 1,
      aiWiring: [
        {
          artifact: id,
          viteHooks: {
            "pre-commit": hookLine,
            "pre-push": hookLine.replace("pre-commit", "pre-push"),
          },
        },
      ],
    }),
    ".vite-hooks/pre-push": "vp test\n",
  });
  await mkdir(join(fixture.root, ".vite-hooks/pre-commit"));

  const { code, stdout, stderr } = await runDoctor(fixture.root, ["--json"]);

  assert.equal(code, 1, `doctor exited ${code}\n${stdout}\n${stderr}`);
  const report = JSON.parse(stdout);
  assert.deepEqual(
    // The wiring findings, after the phase line doctor reports first (ADR-0020, Decision 4).
    report.issues
      .filter((/** @type {{ check: string }} */ { check }) => check === "wiring")
      .map(({ level, message }) => [level, message.split(/[ :]/)[0]]),
    [
      ["error", ".vite-hooks/pre-commit"],
      ["warning", ".vite-hooks/pre-push"],
    ],
  );
});
