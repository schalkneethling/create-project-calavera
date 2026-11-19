// The one-line TOML table header reader that `eject` uses for `.codex/config.toml` (#678).
import assert from "node:assert/strict";
import test from "node:test";

import { tomlHeader } from "../src/utils/toml-header.js";

test("tomlHeader reads every spelling of a table header", () => {
  const table = { keys: ["mcp_servers", "calavera"], array: false };
  for (const line of [
    "[mcp_servers.calavera]",
    "  [ mcp_servers . calavera ]  ",
    "[mcp_servers.calavera] # mine",
    '[mcp_servers."calavera"]',
    "[mcp_servers.'calavera']",
    '["mcp_servers".calavera]',
    '[mcp_servers."\\u0063alavera"]',
  ]) {
    assert.deepEqual(tomlHeader(line), table, line);
  }
  assert.deepEqual(tomlHeader('[a."b.c"]'), { keys: ["a", "b.c"], array: false });
  assert.deepEqual(tomlHeader("[a-b_1]"), { keys: ["a-b_1"], array: false });
});

test("tomlHeader reads an array of tables", () => {
  assert.deepEqual(tomlHeader("[[mcp_servers.calavera.tools]]"), {
    keys: ["mcp_servers", "calavera", "tools"],
    array: true,
  });
});

test("tomlHeader refuses a line that is no header", () => {
  for (const line of [
    "",
    "# [mcp_servers.calavera]",
    'args = ["a"]',
    "x = [a]",
    '  ["a"],',
    "[a] x",
    "[a]]",
    "[[a]",
    "[]",
    "[a.]",
    "[.a]",
    "[a b]",
    "[a..b]",
    '["\\q"]',
    "['a]",
  ]) {
    assert.equal(tomlHeader(line), undefined, line);
  }
});
