import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after } from "node:test";
import { fileURLToPath } from "node:url";

import { rewriteLossProblem, toJSONText, writeJSON } from "../src/utils/json-rewrite.js";
import { loadProjectFormatter } from "../src/utils/project-formatter.js";
import { createTemporaryFixture, writeVitePlusFormatter } from "./vite-plus-fixtures.mjs";

const oxfmt = fileURLToPath(new URL("../../../node_modules/.bin/oxfmt", import.meta.url));

const vitePlusProject = await createTemporaryFixture("json-rewrite", {});
after(() => vitePlusProject[Symbol.asyncDispose]());
await writeVitePlusFormatter(vitePlusProject.root);
const oxfmtFormatter = await loadProjectFormatter(vitePlusProject.root, "managed");
const plainFormatter = await loadProjectFormatter(vitePlusProject.root, "unmanaged");

// Values whose JSON.stringify layout Oxfmt changes: a short array goes on one line, a number loses
// the plus sign in its exponent, and a line counts wide characters as two columns.
const samples = {
  shortArray: { extends: ["html-validate:recommended", "html-validate:document"] },
  longArray: { kk: ["a".repeat(43), "b".repeat(42)] },
  wideCharacters: { kk: ["中".repeat(22), "b".repeat(41)] },
  emoji: { kk: ["\u{1F468}‍\u{1F469}‍\u{1F467}".repeat(20), "b".repeat(30)] },
  exponents: { k: [1e21, 1.7976931348623157e308, 5e-324, 1e-7, -1e21] },
  stringsWithPlus: { note: "Ctrl+C or Shift+Insert, use the+key", e: ["e+", "1e+21"] },
  emptyCollections: { object: {}, array: [], nested: { inner: {} } },
  topLevelArray: ["a", "b"],
};

test("writeJSON in a Vite+ project writes what the project's oxfmt --check accepts, and the same values", async (t) => {
  await using project = await createTemporaryFixture("json-rewrite-check", {});
  await mkdir(join(project.root, ".claude"));
  const files = Object.entries(samples).map(([name, value]) => [`${name}.json`, value]);
  files.push([".claude/settings.json", samples.shortArray]);
  for (const [name, value] of files) {
    const text = await writeJSON(value, name, oxfmtFormatter);
    assert.deepEqual(JSON.parse(text), value, name);
    await writeFile(join(project.root, name), text);
  }
  assert.equal(
    await writeJSON(samples.shortArray, "a.json", oxfmtFormatter),
    '{\n  "extends": ["html-validate:recommended", "html-validate:document"]\n}\n',
  );

  const result = spawnSync(oxfmt, ["--check", "."], { cwd: project.root, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, new RegExp(`${files.length} files`));
  t.diagnostic(oxfmtFormatter.description);
});

test("writeJSON in a project without Vite+ writes two-space JSON.stringify output", async () => {
  assert.equal(
    await writeJSON(samples.shortArray, "a.json", plainFormatter),
    `${JSON.stringify(samples.shortArray, null, 2)}\n`,
  );
});

test("toJSONText refuses values JSON cannot hold instead of dropping or nulling them", () => {
  for (const value of [undefined, () => {}, Number.NaN, Infinity, { k: undefined }, [undefined]]) {
    assert.throws(() => toJSONText(value), /cannot be written as JSON/, String(value));
  }
  assert.throws(() => toJSONText(1n), /BigInt/);
});

test("rewriteLossProblem reports a duplicate key and a number Calavera would spell differently", async () => {
  for (const [text, problem] of [
    ['{"model": "opus", "model": "sonnet"}', /holds the key "model" more than once/],
    ['{"a": {"x": 1, "x": 2}}', /holds the key "x" more than once/],
    [
      '{"big": 12345678901234567890}',
      /the number 12345678901234567890, which Calavera would write as 12345678901234567000/,
    ],
    ['{"n": [1.50]}', /the number 1\.50, which Calavera would write as 1\.5/],
    ['{"n": -0}', /the number -0, which Calavera would write as 0/],
    ['{"n": 1E5}', /the number 1E5, which Calavera would write as 100000/],
    ['{"n": 1e400}', /the number 1e400, which is too large for Calavera to write/],
  ]) {
    assert.match((await rewriteLossProblem(text, "a.json", oxfmtFormatter)) ?? "", problem, text);
  }
  // Keys that only look alike, such as the same key in two objects, are not duplicates.
  assert.equal(
    await rewriteLossProblem(
      '{"a": {"x": 1}, "b": {"x": 1}, "x": "{\\"x\\": 1}"}',
      "a.json",
      oxfmtFormatter,
    ),
    undefined,
  );
});

test("rewriteLossProblem asks the project's formatter how a number is spelled", async () => {
  // Oxfmt writes 1e21 where JSON.stringify writes 1e+21, so the same text loses nothing in a
  // Vite+ project and changes in any other.
  const text = '{"n": 1e21}';
  assert.equal(await rewriteLossProblem(text, "a.json", oxfmtFormatter), undefined);
  assert.match(
    (await rewriteLossProblem(text, "a.json", plainFormatter)) ?? "",
    /the number 1e21, which Calavera would write as 1e\+21/,
  );
});

test("Given a vite.config.ts that prints, when its text would reach the file, then writeJSON stops and names the formatter", async () => {
  await using project = await createTemporaryFixture("json-rewrite-banner", {});
  await writeVitePlusFormatter(project.root, {
    banner: "[dotenv@17.2.0] injecting env (3) from .env",
  });
  const noisy = await loadProjectFormatter(project.root, "managed");
  const problem =
    /vp fmt from vite-plus .* returned text for \.claude\/settings\.json that does not hold the values Calavera sent\. It begins: "\[dotenv@17\.2\.0\] injecting env \(3\) from \.env"/;
  await assert.rejects(writeJSON(samples.shortArray, ".claude/settings.json", noisy), problem);
  // The number check formats through writeJSON too, so it reports the same cause.
  await assert.rejects(rewriteLossProblem('{"n": 1}', ".claude/settings.json", noisy), problem);
});
