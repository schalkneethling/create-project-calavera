// #1053: ADR-0018 Decision 7. The skill and the project's pinned MCP server update separately, so
// a skill newer than the server may describe a tool the server does not have. The skill must tell
// the agent to use only the tools the server lists, and to treat a missing tool differently from a
// missing server: a missing server needs registering or repair, a missing tool does not. These
// tests fail when either copy loses one of those instructions or goes back to a fixed tool list.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import { bundledSkillCopies } from "./bundled-skill-copies.mjs";

/**
 * The paragraphs and list items of a Markdown text, so each check reads one instruction.
 *
 * @param {string} text
 * @returns {string[]}
 */
function instructionsIn(text) {
  return text.split(/\n\s*\n|\n(?=\d+\.\s)/);
}

/**
 * The one instruction that matches `pattern`.
 *
 * @param {string[]} instructions
 * @param {RegExp} pattern
 * @param {string} source
 * @returns {string}
 */
function onlyInstructionMatching(instructions, pattern, source) {
  const matches = instructions.filter((instruction) => pattern.test(instruction));
  assert.equal(matches.length, 1, `${source} has ${matches.length} instructions matching ${pattern}`);
  return matches[0];
}

for (const { source, url } of bundledSkillCopies) {
  test(`the bundled Calavera skill at ${source} uses only the tools the server lists`, async () => {
    const skill = await readFile(url, "utf8");
    const instructions = instructionsIn(skill);

    assert.doesNotMatch(skill, /Look for tools named/, `${source} still has a fixed tool list`);
    onlyInstructionMatching(instructions, /use only the Calavera tools the server lists/i, source);
    assert.match(skill, /never call a tool the server does not list/i, source);
  });

  test(`the bundled Calavera skill at ${source} separates a missing server from a missing tool`, async () => {
    const skill = await readFile(url, "utf8");
    const instructions = instructionsIn(skill);

    const missingServer = onlyInstructionMatching(instructions, /the server is missing/i, source);
    const missingTool = onlyInstructionMatching(instructions, /a missing tool/i, source);

    assert.notEqual(missingServer, missingTool, `${source} handles both cases in one instruction`);
    assert.match(missingServer, /register or repair/i, `${source}: a missing server needs repair`);
    assert.match(missingTool, /does not need repair/i, `${source}: a missing tool needs no repair`);
    assert.match(missingTool, /tell the user which tool/i, `${source}: name the missing tool`);
  });
}
