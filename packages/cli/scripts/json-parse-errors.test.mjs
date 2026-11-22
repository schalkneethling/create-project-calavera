// Issue #1157: when the recipe, the state, the artifact lock, an MCP config, Claude Code's
// settings, or the repository-controls config cannot be parsed, every output
// names the file and the line and column of the error, and none of them holds text from the file.
// JSON.parse's own message quotes the text around the error, so a secret written next to a syntax
// error would reach the terminal, CI logs, and an agent. A missing file, an unreadable file, and
// invalid JSON stay distinguishable.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { jsonErrorPosition, readBoundedJson } from "../src/templates/repository-controls.mjs";
import { formatErrorChain } from "../src/utils/error-chain.js";
import { readJSON } from "../src/utils/fs.js";
import { writeMcpServersJsonConfig, writeOpenCodeMcpConfig } from "../src/utils/mcp-config.js";
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

// A recipe outside the project is read once, and the bytes validated are the bytes copied, so
// these two paths parse the recipe themselves instead of through readJSON.
// `--new` starts a project, so it runs in a directory that holds none yet.
for (const [args, files] of [
  [["apply", "--config", "../outside/calavera.config.json"], { "project/package.json": "{}\n" }],
  [
    ["apply", "--json", "--config", "../outside/calavera.config.json"],
    { "project/package.json": "{}\n" },
  ],
  [
    ["--dry-run", "--config", "../outside/calavera.config.json", "--new", "vite"],
    { "project/.keep": "" },
  ],
]) {
  test(`${args.join(" ")} names the recipe's parse error position without quoting it`, async () => {
    await using fixture = await project({ ...files, [`outside/${RECIPE}`]: BROKEN });
    const { code, output } = await runCli(join(fixture.path, "project"), args);

    assert.equal(code, 1, output);
    assertNamesPositionWithoutText(output, RECIPE);
    assert.match(output, /cannot be parsed as JSON/);
  });
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

const launchCommand = { command: "npx", args: ["create-project-calavera", "mcp"] };

for (const [write, path] of [
  [writeMcpServersJsonConfig, ".mcp.json"],
  [writeOpenCodeMcpConfig, "opencode.json"],
]) {
  test(`writing the MCP entry into a broken ${path} names the position without quoting it`, async () => {
    await using fixture = await project({ [path]: BROKEN });
    const originalDirectory = process.cwd();
    process.chdir(fixture.path);
    try {
      await assert.rejects(
        write(path, launchCommand, true, [], () => assert.fail("nothing is formatted")),
        (error) => {
          assert.equal(error.cause, undefined);
          assertNamesPositionWithoutText(formatErrorChain(error, { CALAVERA_DEBUG: "1" }), path);
          return true;
        },
      );
    } finally {
      process.chdir(originalDirectory);
    }
  });
}

const TEMPLATE = fileURLToPath(
  new URL("../src/templates/repository-controls.mjs", import.meta.url),
);
const CONTROLS = ".github/repository-controls.json";

test("the repository-controls script names a broken config's position without quoting it", async () => {
  await using fixture = await project({ [CONTROLS]: BROKEN, "scripts/.keep": "" });
  await copyFile(TEMPLATE, join(fixture.path, "scripts/repository-controls.mjs"));
  const output = await new Promise((resolve) => {
    execFile(
      process.execPath,
      ["scripts/repository-controls.mjs"],
      { cwd: fixture.path, env: { ...process.env, CALAVERA_DEBUG: "1" } },
      (error, stdout, stderr) => resolve(`${error?.code}\n${stdout}\n${stderr}`),
    );
  });

  assert.match(output, /^1\n/);
  assertNamesPositionWithoutText(output, CONTROLS);
});

// The script runs in the person's project without Calavera's dependencies, so it finds the
// position with its own scan of the text, not with jsonc-parser.
for (const [text, position] of [
  [BROKEN, POSITION],
  ['{"a": 1,}', "line 1, column 9"],
  ['{\n  "a": [1,\n', "line 3, column 1"],
  ['{"a": 1} x', "line 1, column 10"],
  ["", "line 1, column 1"],
]) {
  test(`readBoundedJson reports ${JSON.stringify(text)} at ${position}, with no cause`, async () => {
    await using fixture = await project({ [CONTROLS]: text });
    const path = join(fixture.path, CONTROLS);

    assert.throws(
      () => readBoundedJson(path),
      (error) => {
        assert.equal(error.cause, undefined);
        assert.ok(!error.message.includes("FAKE_SECRE"), error.message);
        assert.ok(
          error.message.includes(`${path} cannot be parsed as JSON at ${position}.`),
          error.message,
        );
        return true;
      },
    );
  });
}

test("readBoundedJson still tells a missing file and a folder from invalid JSON", async () => {
  await using fixture = await project({ ".github/folder.json/keep": "" });

  assert.throws(() => readBoundedJson(join(fixture.path, ".github/missing.json")), {
    code: "ENOENT",
  });
  assert.throws(
    () => readBoundedJson(join(fixture.path, ".github/folder.json")),
    /must be a regular file/,
  );
});

// Each case is text JSON.parse rejects; the position is where strict JSON stops being valid.
for (const [text, position] of [
  ['{"a": "x\ty"}', "line 1, column 9"], // a raw control character in a string
  ['["a b", x]', "line 1, column 9"], // a space in a string is allowed
  ['{"a": "\\q"}', "line 1, column 9"], // an unknown escape
  ['{"a": "\\u12G4"}', "line 1, column 9"], // a bad Unicode escape
  ['["\\u0041", x]', "line 1, column 12"],
  ['["\\"\\\\\\/\\b\\f\\n\\r\\t", x]', "line 1, column 22"], // every valid escape
  ['["abc', "line 1, column 6"], // an unterminated string
  ['["\\', "line 1, column 4"], // a backslash at the end of the text
  ['{ "a" : [ 1 , 2 ] , }', "line 1, column 21"], // whitespace everywhere it is allowed
  ['{"a": "b" x}', "line 1, column 11"],
  ['{"a": [ ], "b": x}', "line 1, column 17"], // an empty array with a space inside
  ["{a: 1}", "line 1, column 2"], // a key that is not a string
  ["[1.]", "line 1, column 3"],
  ["[1.25x]", "line 1, column 6"],
  ["[1e10x]", "line 1, column 6"],
  ["[1e+10x]", "line 1, column 7"],
  ["[-]", "line 1, column 2"],
  ["[1] [2]", "line 1, column 5"],
  ["[\n  1,\n  x\n]", "line 3, column 3"],
]) {
  test(`jsonErrorPosition finds ${JSON.stringify(text)} at ${position}`, () => {
    assert.throws(() => JSON.parse(text));
    assert.equal(jsonErrorPosition(text), position);
  });
}

test("jsonErrorPosition names no position for valid JSON or nesting too deep to scan", () => {
  assert.equal(jsonErrorPosition('{"a": [1, "b", true, null]}'), "an unknown position");
  assert.equal(jsonErrorPosition("[".repeat(100_000)), "an unknown position");
});
