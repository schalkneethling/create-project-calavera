// Issue #1157: when the recipe, the state, or the artifact lock cannot be parsed, every output
// names the file and the line and column of the error, and none of them holds text from the file.
// JSON.parse's own message quotes the text around the error, so a secret written next to a syntax
// error would reach the terminal, CI logs, and an agent. A missing file, an unreadable file, and
// invalid JSON stay distinguishable.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { formatErrorChain } from "../src/utils/error-chain.js";
import { readJSON } from "../src/utils/fs.js";
import { jsonSyntaxProblem } from "../src/utils/parse-position.js";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

// Not shaped like any token redactSecrets knows, so only the parse-error handling can keep it out.
const SECRET = "FAKE_SECRET_9f3a7c";
// The value starts on line 3, column 14: the error is there, and so is the secret.
const BROKEN = `{\n  "integrations": [],\n  "profile": ${SECRET}\n}\n`;
const POSITION = "line 3, column 14";
const RECIPE = "calavera.config.json";
const STATE = ".calavera/state.json";
const LOCK = ".calavera/artifacts.lock.json";
const VALID_RECIPE = `${JSON.stringify({ profile: "default", integrations: [] })}\n`;

/**
 * A temporary project holding `files`, removed when the returned handle is disposed.
 *
 * @param {Record<string, string>} files
 */
async function project(files) {
  const directory = await mkdtempDisposable(join(tmpdir(), "calavera-json-parse-errors-"));
  for (const [path, contents] of Object.entries(files)) {
    await mkdir(join(directory.path, path, ".."), { recursive: true });
    await writeFile(join(directory.path, path), contents);
  }
  return directory;
}

/**
 * Runs the CLI in `cwd` with the debug switch on, so the output holds every cause and stack
 * frame the CLI can print, and resolves with everything it wrote.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, output: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1", CALAVERA_DEBUG: "1" } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          output: `${stdout}\n${stderr}`,
        });
      },
    );
  });
}

/**
 * @param {string} output
 * @param {string} file
 */
function assertNamesPositionWithoutText(output, file) {
  assert.ok(!output.includes(SECRET), `The output quotes the file:\n${output}`);
  assert.ok(!output.includes("FAKE_SECRE"), `The output quotes part of the file:\n${output}`);
  assert.ok(output.includes(file), `The output does not name ${file}:\n${output}`);
  assert.ok(output.includes(POSITION), `The output does not name ${POSITION}:\n${output}`);
}

const cases = [
  { command: ["doctor"], file: RECIPE, files: { [RECIPE]: BROKEN } },
  { command: ["doctor"], file: STATE, files: { [RECIPE]: VALID_RECIPE, [STATE]: BROKEN } },
  { command: ["artifacts", "doctor"], file: RECIPE, files: { [RECIPE]: BROKEN } },
  {
    command: ["artifacts", "doctor"],
    file: LOCK,
    files: { [RECIPE]: VALID_RECIPE, [LOCK]: BROKEN },
  },
  {
    command: ["artifacts", "doctor"],
    file: STATE,
    files: { [RECIPE]: VALID_RECIPE, [STATE]: BROKEN },
  },
];

for (const { command, file, files } of cases) {
  for (const flags of [[], ["--json"]]) {
    test(`${[...command, ...flags].join(" ")} names ${file}'s parse error position without quoting the file`, async () => {
      await using fixture = await project({ "package.json": "{}\n", ...files });
      const { code, output } = await runCli(fixture.path, [...command, ...flags]);

      assert.equal(code, 1, output);
      assertNamesPositionWithoutText(output, file);
    });
  }
}

test("inspect_project over MCP names a broken state's position without quoting the file", async () => {
  await using fixture = await project({ "package.json": "{}\n", [STATE]: BROKEN });
  const originalDirectory = process.cwd();
  process.chdir(fixture.path);
  try {
    await assert.rejects(callMcpTool("inspect_project"), (error) => {
      assertNamesPositionWithoutText(formatErrorChain(error, { CALAVERA_DEBUG: "1" }), STATE);
      return true;
    });
  } finally {
    process.chdir(originalDirectory);
  }
});

test("inspect_project's invalid-manifest finding names the position without quoting package.json", async () => {
  await using fixture = await project({ "package.json": BROKEN });
  const originalDirectory = process.cwd();
  process.chdir(fixture.path);
  try {
    const response = await callMcpTool("inspect_project");
    const finding = response.findings.find(({ kind }) => kind === "package-json-invalid");

    assert.ok(finding, JSON.stringify(response.findings));
    assertNamesPositionWithoutText(JSON.stringify(response), "package.json");
  } finally {
    process.chdir(originalDirectory);
  }
});

test("inspect_project rejects an unreadable package.json rather than reporting it as unparseable", async () => {
  await using fixture = await project({ "package.json/keep": "" });
  const originalDirectory = process.cwd();
  process.chdir(fixture.path);
  try {
    await assert.rejects(callMcpTool("inspect_project"), { code: "EISDIR" });
  } finally {
    process.chdir(originalDirectory);
  }
});

test("readJSON keeps no cause, so no chain can reach JSON.parse's message", async () => {
  await using fixture = await project({ [STATE]: BROKEN });
  const path = join(fixture.path, STATE);

  await assert.rejects(readJSON(path), (error) => {
    assert.ok(error instanceof SyntaxError);
    assert.equal(error.cause, undefined);
    assert.ok(!String(error.stack).includes(SECRET), String(error.stack));
    assertNamesPositionWithoutText(error.message, path);
    return true;
  });
});

test("readJSON names a position for a file that ends too early", async () => {
  await using fixture = await project({ [STATE]: '{\n  "a": [1,\n' });
  await assert.rejects(readJSON(join(fixture.path, STATE)), /at line 3, column 1\b/);
});

test("a missing file, an unreadable file, and invalid JSON fail differently", async () => {
  await using fixture = await project({ [STATE]: BROKEN, ".calavera/folder.json/keep": "" });

  /** @param {string} path */
  const failure = async (path) => {
    try {
      await readJSON(join(fixture.path, path));
    } catch (error) {
      return /** @type {Error & { code?: string }} */ (error);
    }
    assert.fail(`${path} was read`);
  };
  const missing = await failure(".calavera/missing.json");
  const unreadable = await failure(".calavera/folder.json");
  const invalid = await failure(STATE);

  assert.equal(missing.code, "ENOENT");
  assert.equal(unreadable.code, "EISDIR");
  assert.equal(invalid.code, undefined);
  assert.ok(invalid instanceof SyntaxError);
  assert.match(invalid.message, /cannot be parsed as JSON/);
  assert.equal(new Set([missing.message, unreadable.message, invalid.message]).size, 3);
});

// Strict JSON, as JSON.parse reads it: comments, trailing commas, and empty content are errors.
for (const [text, problem] of [
  ['{"a": 1,}', "PropertyNameExpected at line 1, column 9"],
  ['{"a": 1} // note', "InvalidCommentToken at line 1, column 10"],
  ["", "ValueExpected at line 1, column 1"],
  ['{\n  "a": 1\n  "b": 2\n}', "CommaExpected at line 3, column 3"],
]) {
  test(`jsonSyntaxProblem reports ${JSON.stringify(text)} as ${problem}`, () => {
    assert.throws(() => JSON.parse(text));
    assert.equal(jsonSyntaxProblem(text), problem);
  });
}

test("jsonSyntaxProblem names no position when the strict reading finds no error", () => {
  assert.equal(jsonSyntaxProblem("{}"), "a syntax error at an unknown position");
});
