// Issue #1221: `editJson` changes one member of a JSON object and keeps every other byte. The
// harness-file cases are in `init-mcp-bytes.test.mjs`; these cover the shapes those files rarely
// have.
import assert from "node:assert/strict";
import test from "node:test";

import { editJson, withoutBom } from "../src/utils/json-edit.js";

test("a member added to an object written on one line follows the last member, one level in", () => {
  assert.equal(
    editJson('{\n  "a": { "b": 1 }\n}\n', [{ path: ["a", "c"], value: 2 }]),
    '{\n  "a": { "b": 1,\n    "c": 2 }\n}\n',
  );
});

test("a member added to an empty object gets its own line, at one level in from the object's line", () => {
  assert.equal(
    editJson('{\n\t"a": {}\n}\n', [{ path: ["a", "b"], value: [1] }]),
    '{\n\t"a": {\n\t\t"b": [\n\t\t\t1\n\t\t]\n\t}\n}\n',
  );
});

test("missing objects on the way to a member are added with it", () => {
  assert.equal(
    editJson('{\n  "a": 1\n}\n', [{ path: ["b", "c", "d"], value: true }]),
    '{\n  "a": 1,\n  "b": {\n    "c": {\n      "d": true\n    }\n  }\n}\n',
  );
});

test("removing a member takes the comma that separates it, wherever it is", () => {
  const text = '{\n  "a": 1,\n  "b": 2,\n  "c": 3\n}\n';
  assert.equal(editJson(text, [{ path: ["a"], value: undefined }]), '{\n  "b": 2,\n  "c": 3\n}\n');
  assert.equal(editJson(text, [{ path: ["b"], value: undefined }]), '{\n  "a": 1,\n  "c": 3\n}\n');
  assert.equal(editJson(text, [{ path: ["c"], value: undefined }]), '{\n  "a": 1,\n  "b": 2\n}\n');
});

test("removing the only member leaves an empty object, and removing a missing one changes nothing", () => {
  assert.equal(
    editJson('{\n  "a": {\n    "b": 1\n  }\n}\n', [{ path: ["a", "b"], value: undefined }]),
    '{\n  "a": {}\n}\n',
  );
  assert.equal(editJson('{ "a": 1 }', [{ path: ["b"], value: undefined }]), '{ "a": 1 }');
});

test("a member is never added inside a value that is not an object, which the error names", () => {
  assert.throws(
    () => editJson('{\n  "a": { "b": [1] }\n}\n', [{ path: ["a", "b", "c"], value: 1 }]),
    /^Error: The JSON at a\.b is not an object\.$/,
  );
  assert.throws(
    () => editJson("[1]", [{ path: ["a"], value: 1 }]),
    /^Error: The JSON at the root is not an object\.$/,
  );
});

test("withoutBom removes only a byte order mark that opens the text", () => {
  assert.equal(withoutBom("﻿{}"), "{}");
  assert.equal(withoutBom("{}﻿"), "{}﻿");
});

test("the indentation level comes from the outer object's first member, not the first indented line", () => {
  assert.equal(
    editJson('{"a": {\n      "b": 1\n  },\n  "c": {}\n}\n', [{ path: ["c", "d"], value: 1 }]),
    '{"a": {\n      "b": 1\n  },\n  "c": {\n    "d": 1\n  }\n}\n',
  );
  assert.equal(
    editJson('{\n   "a": {}\n}\n', [{ path: ["a", "b"], value: 1 }]),
    '{\n   "a": {\n      "b": 1\n   }\n}\n',
  );
});
