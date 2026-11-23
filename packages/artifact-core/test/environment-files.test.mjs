import assert from "node:assert/strict";
import test from "node:test";

import {
  hasBunReference,
  hasYarnReference,
  parseEnvironmentFile,
} from "../src/environment-files.js";

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

test("hasYarnReference and hasBunReference follow each tool's expansion syntax and escapes", () => {
  assert.equal(hasYarnReference("http://${X}/"), true);
  assert.equal(hasYarnReference("http://\\${X}/"), false);
  assert.equal(hasYarnReference("http://\\\\${X}/"), true);
  assert.equal(hasYarnReference("http://$X/"), false);
  assert.equal(hasBunReference("http://$X/"), true);
  assert.equal(hasBunReference("http://${X}/"), true);
  assert.equal(hasBunReference("http://\\$X/"), false);
  assert.equal(hasBunReference("http://\\\\$X/"), false);
  assert.equal(hasBunReference("http://$1/"), true);
  assert.equal(hasBunReference("http://$/"), false);
});
