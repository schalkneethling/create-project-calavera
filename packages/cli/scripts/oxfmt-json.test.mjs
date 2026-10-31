import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { formatJSON } from "../src/utils/oxfmt-json.js";

const oxfmt = fileURLToPath(new URL("../../../node_modules/.bin/oxfmt", import.meta.url));

const long = "x".repeat(70);
const samples = {
  empty: {},
  scalars: {
    string: 'a "quoted" \\ value',
    number: 1.5,
    integer: 10,
    yes: true,
    no: false,
    none: null,
  },
  unicode: { name: "Schalk Ñeethling", emoji: "✓", escaped: "line\nbreak\ttab" },
  emptyCollections: { object: {}, array: [], nested: { inner: {} } },
  shortArray: { extends: ["html-validate:recommended", "html-validate:document"] },
  // Oxfmt's default print width is 100. Each "At" line is exactly 100 characters, and each "Past"
  // line would be 101 or 102.
  arrayAtWidth: { kk: ["a".repeat(42), "b".repeat(42)] },
  arrayPastWidth: { kk: ["a".repeat(43), "b".repeat(42)] },
  arrayAtWidthWithComma: { kk: ["a".repeat(42), "b".repeat(41)], last: true },
  arrayPastWidthWithComma: { kk: ["a".repeat(42), "b".repeat(42)], last: true },
  nestedArrayAtWidth: { a: { b: { kk: ["a".repeat(40), "b".repeat(40)] } } },
  nestedArrayPastWidth: { a: { b: { kk: ["a".repeat(41), "b".repeat(40)] } } },
  longString: { k: [long, long] },
  singleLongItem: { k: ["a".repeat(90)] },
  objectsInArray: { hooks: [{ type: "command", command: "node guard.mjs" }] },
  emptyObjectsInArray: { k: [{}, {}] },
  arrayOfPairs: {
    k: [
      ["a", "b"],
      ["c", "d"],
    ],
  },
  arrayOfSingletons: { k: [["a"], ["b"]] },
  arrayOfOnePair: { k: [["a", "b"]] },
  mixedArray: { k: [1, "two", null, true, [], {}] },
  numbers: { k: [1, 2, 3] },
  manyNumbers: { k: Array.from({ length: 40 }, (_, index) => index * 1000) },
  topLevelArray: ["a", "b"],
  // Oxfmt counts display columns: a wide CJK character as 2 and a combining mark as 0.
  wideAtWidth: { kk: ["\u4e2d".repeat(21), "b".repeat(42)] },
  widePastWidth: { kk: ["\u4e2d".repeat(22), "b".repeat(41)] },
  wideCharacters: { kk: ["\u4e2d".repeat(30), "\u4e2d".repeat(30)] },
  wideKey: { ["\u4e2d".repeat(10)]: ["a".repeat(36), "b".repeat(36)] },
  combiningMarks: { kk: ["e\u0301".repeat(30), "b".repeat(40)] },
  hangulAndKana: { kk: ["\ud55c".repeat(15), "\u30ab".repeat(15), "\uff21".repeat(10)] },
  emoji: { kk: ["\u{1F600}".repeat(20), "b".repeat(30)] },
  exponents: { k: [1e21, 1.7976931348623157e308, 5e-324, 1e-7, -1e21] },
  claudeSettings: {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: { allow: ["Bash(git status)", "Bash(pnpm test)"], deny: [] },
    hooks: {
      SessionStart: [
        {
          hooks: [
            {
              type: "command",
              command:
                'node "$CLAUDE_PROJECT_DIR/.agents/skills/protected-branch-guard/scripts/guard.mjs" session-start main',
              timeout: 10,
            },
          ],
        },
      ],
      PreToolUse: [
        {
          matcher: "Write|Edit|MultiEdit|NotebookEdit",
          hooks: [{ type: "command", command: "echo hi" }],
        },
      ],
    },
  },
};

test("formatJSON writes short arrays on one line and objects expanded, as Oxfmt does", () => {
  assert.equal(
    formatJSON(samples.shortArray),
    '{\n  "extends": ["html-validate:recommended", "html-validate:document"]\n}\n',
  );
  assert.equal(formatJSON({}), "{}\n");
  assert.equal(formatJSON({ a: {}, b: [] }), '{\n  "a": {},\n  "b": []\n}\n');
  assert.equal(
    formatJSON(samples.arrayPastWidth),
    `{\n  "kk": [\n    "${"a".repeat(43)}",\n    "${"b".repeat(42)}"\n  ]\n}\n`,
  );
  assert.equal(
    formatJSON(samples.objectsInArray),
    '{\n  "hooks": [\n    {\n      "type": "command",\n      "command": "node guard.mjs"\n    }\n  ]\n}\n',
  );
});

test("the width samples sit exactly at and just past Oxfmt's print width", () => {
  const widest = (value) =>
    Math.max(
      ...formatJSON(value)
        .split("\n")
        .map((line) => line.length),
    );
  for (const name of ["arrayAtWidth", "arrayAtWidthWithComma", "nestedArrayAtWidth"]) {
    assert.equal(widest(samples[name]), 100, name);
  }
  for (const name of ["arrayPastWidth", "arrayPastWidthWithComma", "nestedArrayPastWidth"]) {
    assert.ok(widest(samples[name]) < 100, name);
  }
});

test("formatJSON output passes this repository's oxfmt --check with no configuration", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-oxfmt-json-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".claude"));
  const files = Object.entries(samples).map(([name, value]) => [`${name}.json`, value]);
  files.push([".claude/settings.json", samples.claudeSettings]);
  for (const [name, value] of files) {
    const text = formatJSON(value);
    assert.deepEqual(JSON.parse(text), value, name);
    await writeFile(join(directory, name), text);
  }

  const result = spawnSync(oxfmt, ["--check", "."], { cwd: directory, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`${files.length} files`));
});

test("formatJSON writes an exponent without a plus sign, as Oxfmt does", () => {
  assert.equal(formatJSON([1e21, 1e-7]), "[1e21, 1e-7]\n");
});

test("formatJSON refuses values JSON cannot hold", () => {
  for (const value of [
    undefined,
    () => {},
    Number.NaN,
    Infinity,
    { k: undefined },
    [undefined],
    1n,
  ]) {
    assert.throws(() => formatJSON(value), /cannot be written as JSON/, String(value));
  }
});
