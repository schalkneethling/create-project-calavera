// Issue #1227: when `--json` is on the command line, a command that throws while it runs prints a
// JSON result, `{ command, ok: false, issues }` (ADR-0020 Amendment 1), on standard output and
// exits 1, as a run whose arguments are invalid already does (#1218). Before, runCli printed the
// error as plain text on standard error. Without `--json`, the output is unchanged: each plain-text
// case below pins the exact text the CLI printed before this change.
//
// doctor has no case here, because it catches its own runtime errors and returns them as issues
// (#1141, #1206); doctor-json-recipe-errors.test.mjs and doctor-json-state-wiring-errors.test.mjs
// cover it.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
// A secret by its variable's name only, so redactSecrets hides it only because the environment
// holds it (redact.js), as it does for the plain-text error.
const ENV_SECRET = "fake-secret-value-1227";
// Text inside a file that a runtime error must name by position only (#1157). Each case pins the
// whole message, so the text cannot appear in it.
const FILE_SECRET = "FAKE_FILE_SECRET_1227";

/**
 * Runs the CLI in `cwd` and resolves with its exit code and output, with any path to `cwd`
 * replaced by `<directory>`. stdin is not a terminal and `CI` is set, so no command prompts. A
 * run killed by a signal resolves with a null code, so it cannot pass as an exit 1.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
async function runCli(cwd, args) {
  const directory = await realpath(cwd);
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, CI: "1", CALAVERA_TEST_TOKEN: ENV_SECRET } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout: stdout.replaceAll(directory, "<directory>"),
          stderr: stderr.replaceAll(directory, "<directory>"),
        });
      },
    );
    child.stdin?.end();
  });
}

/**
 * Runs `callback` in a new directory that `setup` prepares.
 *
 * @param {(directory: string) => Promise<void>} setup
 * @param {(directory: string) => Promise<void>} callback
 */
async function inDirectory(setup, callback) {
  const directory = await mkdtemp(join(tmpdir(), "calavera-1227-"));
  try {
    await setup(directory);
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

const empty = async () => {};
/** @param {string} directory */
const invalidPackageJSON = (directory) =>
  writeFile(join(directory, "package.json"), `{ "token": "${FILE_SECRET}", bad`);
/** @param {string} directory */
const invalidState = async (directory) => {
  await writeFile(join(directory, "package.json"), "{}\n");
  await mkdir(join(directory, ".calavera"));
  await writeFile(join(directory, ".calavera", "state.json"), `{ "token": "${FILE_SECRET}", bad`);
};

const packageJSONParseError =
  "SyntaxError: <directory>/package.json cannot be parsed as JSON: InvalidSymbol at line 1, column 37. Correct the JSON there, then run the command again.";

const cases = [
  {
    command: "init",
    setup: empty,
    args: ["init"],
    // The plain run prints the composer's intro before it refuses; the JSON run prints no intro.
    plainStdout: "┌  Compose your Calavera tooling recipe\n",
    plainMessage:
      'init refused: Calavera cannot ask "Choose a tooling profile" because stdin is not a terminal, and CI is set. Pass --yes to use the defaults, or answer it with --profile.',
    message:
      'init refused: Calavera cannot ask "Choose a tooling profile" because --json was given, so the prompt would corrupt the JSON output, and stdin is not a terminal, and CI is set. Pass --yes to use the defaults, or answer it with --profile.',
  },
  {
    command: "agent-init",
    setup: invalidPackageJSON,
    args: ["agent-init"],
    message: packageJSONParseError,
  },
  {
    command: "bootstrap",
    // The name of its success result (#1227), as cli-result-command-names.test.mjs checks.
    result: "agent-init",
    setup: invalidPackageJSON,
    args: ["bootstrap"],
    message: packageJSONParseError,
  },
  {
    command: "apply",
    setup: empty,
    args: ["apply", "--config", "missing.json"],
    message: "ENOENT: no such file or directory, open '<directory>/missing.json'",
  },
  {
    command: "update",
    result: "apply",
    setup: empty,
    args: ["update", "--config", "missing.json"],
    message: "ENOENT: no such file or directory, open '<directory>/missing.json'",
  },
  {
    command: "clean",
    setup: invalidState,
    args: ["clean"],
    message:
      "SyntaxError: .calavera/state.json cannot be parsed as JSON: InvalidSymbol at line 1, column 37. Correct the JSON there, then run the command again.",
  },
  {
    command: "eject",
    setup: empty,
    args: ["eject", "--config", "package.json"],
    message:
      "eject stopped before removing anything, because the recipe path package.json names a package.json, which eject never changes. Pass the path of the Calavera recipe, or leave --config out to use calavera.config.json.",
  },
  {
    command: "artifacts",
    // No success result names an action Calavera does not have.
    result: null,
    setup: empty,
    args: ["artifacts", "bogus"],
    message: "Artifacts command must be install, status, doctor, migrate, or update.",
  },
  {
    // `--json` before `--new` is Calavera's own, and new refuses it while it runs.
    command: "new",
    setup: empty,
    args: ["--new"],
    jsonArgs: ["--json", "--new"],
    plainMessage:
      "--new refused: Calavera cannot ask for confirmation because stdin is not a terminal, CI is set. Preview the command with --dry-run, then confirm it by passing --yes before --new.",
    message:
      "--new cannot be combined with --json: Vite+ writes its prompts and progress to the same output, which would corrupt the JSON result. Remove --json.",
  },
];

for (const {
  command,
  result: resultCommand = command,
  setup,
  args,
  jsonArgs = [...args, "--json"],
  plainStdout = "",
  plainMessage,
  message,
} of cases) {
  test(`${command} prints a runtime error as plain text without --json`, async () => {
    await inDirectory(setup, async (directory) => {
      const result = await runCli(directory, args);

      assert.equal(result.code, 1);
      assert.equal(result.stdout, plainStdout);
      assert.equal(result.stderr, `${plainMessage ?? message}\n`);
    });
  });

  test(`${command} prints a runtime error as a JSON result with --json`, async () => {
    await inDirectory(setup, async (directory) => {
      const result = await runCli(directory, jsonArgs);

      assert.equal(result.code, 1);
      assert.equal(result.stderr, "");
      assert.deepEqual(JSON.parse(result.stdout), {
        command: resultCommand,
        ok: false,
        issues: [{ level: "error", message }],
      });
    });
  });
}

test("a runtime error's issue is redacted as the plain-text error is", async () => {
  // The recipe path holds the value of a secret environment variable, and the ENOENT error quotes
  // the path, so only redaction keeps the value out of either output.
  await inDirectory(empty, async (directory) => {
    const config = `${ENV_SECRET}.json`;
    const plain = await runCli(directory, ["apply", "--config", config]);
    const json = await runCli(directory, ["apply", "--json", "--config", config]);
    const message = "ENOENT: no such file or directory, open '<directory>/[redacted].json'";

    assert.equal(plain.stderr, `${message}\n`);
    assert.deepEqual(JSON.parse(json.stdout).issues, [{ level: "error", message }]);
    assert.doesNotMatch(json.stdout, new RegExp(ENV_SECRET));
  });
});
