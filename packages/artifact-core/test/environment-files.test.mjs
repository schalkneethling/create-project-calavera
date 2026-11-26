import assert from "node:assert/strict";
import test from "node:test";

import { mayHoldVariable, parseEnvironmentFile } from "../src/environment-files.js";

test("parseEnvironmentFile finds the keys and raw values that dotenv's parse finds", () => {
  const entries = parseEnvironmentFile(
    [
      "export EXPORTED=${A}",
      "COLON: ${B}",
      "SPACED = plain",
      "# COMMENTED=${C}",
      "INLINE=plain # ${D}",
      'QUOTED="multi',
      '${E}"',
      "WINDOWS=${F}\r",
      "OLD_MAC=${G}\rNEXT=plain",
    ].join("\n"),
  );
  assert.deepEqual(Object.fromEntries(entries), {
    EXPORTED: "${A}",
    COLON: "${B}",
    SPACED: " plain",
    INLINE: "plain ",
    QUOTED: '"multi\n${E}"',
    WINDOWS: "${F}",
    OLD_MAC: "${G}",
    NEXT: "plain",
  });
});

test("mayHoldVariable counts every $, escaped or not, because Yarn and Bun unescape \\$ to a literal $ that Calavera would expand", () => {
  assert.equal(mayHoldVariable("http://${X}/"), true);
  assert.equal(mayHoldVariable("http://$X/"), true);
  assert.equal(mayHoldVariable("http://\\${X}/"), true);
  assert.equal(mayHoldVariable("http://plain.example.com/"), false);
});
