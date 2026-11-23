// Issue #1218: when `--json` is on the command line, a run whose own arguments are invalid still
// prints a JSON result, `{ command, ok: false, issues }` (ADR-0020 Amendment 1), and exits 1, so a
// CI step or an agent that parses standard output has a result to parse. Before, the argument
// parser threw before the command ran, and the CLI printed plain text on standard error. Without
// `--json`, the output is unchanged: each plain-text case below pins the exact text the CLI printed
// before this change.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
// Not shaped like any token redactSecrets knows, so only the argument handling keeps it out.
const SECRET = "FAKE_SECRET_1218";

/**
 * Runs the CLI in `cwd` and resolves with its exit code and output. A run killed by a signal
 * resolves with a null code, so it cannot pass as an exit 1.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
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

/**
 * Runs `callback` in a new, empty directory, so no command finds a project to act on.
 *
 * @param {(directory: string) => Promise<void>} callback
 */
async function inEmptyDirectory(callback) {
  const directory = await mkdtemp(join(tmpdir(), "calavera-1218-"));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const unknownOption = (option) =>
  `TypeError: Unknown option '${option}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- "${option}"`;

const cases = [
  {
    label: "an unknown flag",
    plain: ["doctor", "--bogus"],
    json: ["doctor", "--json", "--bogus"],
    command: "doctor",
    message: unknownOption("--bogus"),
  },
  {
    label: "a flag missing its value",
    plain: ["doctor", "--config"],
    json: ["doctor", "--json", "--config"],
    command: "doctor",
    message: "TypeError: Option '--config <value>' argument missing",
  },
  {
    label: "an unknown command",
    plain: ["bogus"],
    json: ["bogus", "--json"],
    // `bogus` is not a command, so the result names none; the message names it, as the text does.
    command: null,
    message: "Unknown command: bogus",
  },
  {
    label: "a flag value outside its allowed values",
    plain: ["clean", "--tag", "nope"],
    json: ["--json", "clean", "--tag", "nope"],
    command: "clean",
    message: "Invalid tag: nope. Allowed values: latest, next.",
  },
];

for (const { label, plain, json, command, message } of cases) {
  test(`${label} prints the same error as plain text without --json`, async () => {
    await inEmptyDirectory(async (directory) => {
      const result = await runCli(directory, plain);

      assert.equal(result.code, 1);
      assert.equal(result.stdout, "");
      assert.equal(result.stderr, `${message}\n`);
    });
  });

  test(`${label} prints a JSON result with --json`, async () => {
    await inEmptyDirectory(async (directory) => {
      const result = await runCli(directory, json);

      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        command,
        ok: false,
        issues: [{ level: "error", message }],
      });
    });
  });
}

test("a parse failure names no command that the arguments only appear to name", async () => {
  // A lenient reading takes the value of `--bogus` for a positional, but it may be a secret the
  // plain-text error never prints, so the result names only a command Calavera has.
  await inEmptyDirectory(async (directory) => {
    const result = await runCli(directory, ["--json", "--bogus", SECRET]);

    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stdout, new RegExp(SECRET));
    assert.deepEqual(JSON.parse(result.stdout), {
      command: null,
      ok: false,
      issues: [{ level: "error", message: unknownOption("--bogus") }],
    });
  });
});

test("a parse failure names the command the flags select, as a valid run would", async () => {
  // `--init` selects agent-init and wins over a positional, as parseArgs reads it; with no
  // command at all, the run would have run init.
  await inEmptyDirectory(async (directory) => {
    const withInit = await runCli(directory, ["--json", "--bogus", "--init", "doctor"]);
    const withNone = await runCli(directory, ["--json", "--bogus"]);

    assert.equal(JSON.parse(withInit.stdout).command, "agent-init");
    assert.equal(JSON.parse(withNone.stdout).command, "init");
  });
});

test("an unknown flag's inline value stays out of the JSON result, as it does from the text", async () => {
  await inEmptyDirectory(async (directory) => {
    const plain = await runCli(directory, ["doctor", `--token=${SECRET}`]);
    const json = await runCli(directory, ["doctor", "--json", `--token=${SECRET}`]);

    assert.doesNotMatch(plain.stderr, new RegExp(SECRET));
    assert.doesNotMatch(json.stdout, new RegExp(SECRET));
    assert.equal(JSON.parse(json.stdout).issues[0].message, unknownOption("--token"));
  });
});

test("--json after --new belongs to vp create, so a parse failure stays plain text", async () => {
  await inEmptyDirectory(async (directory) => {
    const result = await runCli(directory, ["--bogus", "--new", "--json"]);

    assert.equal(result.code, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, `${unknownOption("--bogus")}\n`);
  });
});
