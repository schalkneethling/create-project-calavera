// #1053: ADR-0018 Decision 7. The skill and the project's pinned MCP server update separately, so
// a skill newer than the server may describe a tool the server does not have. The skill must tell
// the agent to use only the tools the server lists, and to treat a missing tool differently from a
// missing server: a missing server needs registering or repair, a missing tool does not. These
// tests fail when either copy loses one of those instructions, lets a missing tool lead to an
// apply without a dry run, or brings back the old "Look for tools named" list.
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
  assert.equal(
    matches.length,
    1,
    `${source} has ${matches.length} instructions matching ${pattern}`,
  );
  return matches[0];
}

/**
 * The sentences of one instruction, so a check can require that words appear together.
 *
 * @param {string} instruction
 * @returns {string[]}
 */
function sentencesIn(instruction) {
  return instruction.split(/(?<=\.)\s+(?=[A-Z`])/);
}

/**
 * The one sentence of `instruction` that contains every string in `parts`.
 *
 * @param {string} instruction
 * @param {string[]} parts
 * @param {string} source
 * @returns {string}
 */
function onlySentenceWith(instruction, parts, source) {
  const matches = sentencesIn(instruction).filter((sentence) =>
    parts.every((part) => sentence.includes(part)),
  );
  assert.equal(matches.length, 1, `${source} has ${matches.length} sentences with ${parts}`);
  return matches[0];
}

/**
 * The text of a `## ` section, up to the next `## ` heading.
 *
 * @param {string} text
 * @param {string} heading
 * @param {string} source
 * @returns {string}
 */
function sectionText(text, heading, source) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `${source} has no "## ${heading}" section`);
  const rest = text.slice(start + heading.length + 5);
  const end = rest.indexOf("\n## ");
  return end === -1 ? rest : rest.slice(0, end);
}

const APPROVAL_TOOLS = ["`compose_recipe`", "`dry_run_apply`", "`apply_recipe`"];

test("both copies of the bundled Calavera skill are byte-identical", async () => {
  const [first, ...rest] = await Promise.all(bundledSkillCopies.map(({ url }) => readFile(url)));
  for (const [index, copy] of rest.entries()) {
    assert.ok(
      first.equals(copy),
      `${bundledSkillCopies[index + 1].source} differs from ${bundledSkillCopies[0].source}`,
    );
  }
});

test("the sentence check ties the approval tools to applying nothing through MCP", () => {
  const unsafe =
    "When `compose_recipe`, `dry_run_apply`, or `apply_recipe` is missing, call `apply_recipe`. Apply nothing through MCP when the server is missing.";
  const sentence = onlySentenceWith(unsafe, APPROVAL_TOOLS, "fixture");

  assert.doesNotMatch(sentence, /apply nothing through MCP/i);
  assert.equal(sentencesIn("Call `a_b` now. `c_d` follows.").length, 2);
});

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
    const missingTool = onlyInstructionMatching(instructions, /that is a missing tool/i, source);

    assert.notEqual(missingServer, missingTool, `${source} handles both cases in one instruction`);
    assert.match(missingServer, /tell the user that the Calavera MCP server is missing/i, source);
    assert.match(missingServer, /register or repair/i, `${source}: a missing server needs repair`);
    assert.match(missingTool, /does not need repair/i, `${source}: a missing tool needs no repair`);
    assert.match(missingTool, /tell the user which tool/i, `${source}: name the missing tool`);
    // A missing approval tool must not lead to an apply without a dry run (C8), so the rule must
    // name all three tools and the outcome in the same sentence. This checks that the safe rule
    // exists; it cannot prove that no other sentence in the skill contradicts it.
    assert.match(
      onlySentenceWith(missingTool, APPROVAL_TOOLS, source),
      /apply nothing through MCP/i,
      `${source}: a missing approval tool must stop applies through MCP`,
    );
    // A tool the client hides, for example through a permission rule, is the user's choice, so the
    // agent asks before switching to the CLI instead of working around the denial.
    assert.match(
      onlySentenceWith(missingTool, ["permission rule"], source),
      /ask the user before/i,
      `${source}: a hidden tool must not be sidestepped`,
    );
    assert.match(
      onlySentenceWith(missingTool, ["server version lacks that approval tool"], source),
      /Fallbacks/,
      `${source}: a server that lacks the tool goes to Fallbacks`,
    );
    assert.doesNotMatch(missingTool, /would provide/, `${source}: a newer version may not have it`);
    assert.match(missingTool, /newer than the pinned one may provide the tool/, source);
  });

  test(`the bundled Calavera skill at ${source} lets a missing approval tool reach the fallback`, async () => {
    const skill = await readFile(url, "utf8");
    const fallbacks = sectionText(skill, "Fallbacks", source);
    const firstParagraph = fallbacks.trim().split(/\n\s*\n/)[0];

    for (const name of APPROVAL_TOOLS) {
      assert.ok(firstParagraph.includes(name), `${source}: Fallbacks does not cover ${name}`);
    }
    const inspect = onlyInstructionMatching(
      instructionsIn(skill),
      /^\d+\. Call `inspect_project`/,
      source,
    );
    assert.match(
      inspect,
      /missing approval tool/,
      `${source}: manual inspection excludes a missing approval tool`,
    );
  });

  test(`the bundled Calavera skill at ${source} suggests a prompt that does not stop on a missing tool`, async () => {
    const skill = await readFile(url, "utf8");
    const prompt = sectionText(skill, "User Prompt", source);

    assert.doesNotMatch(prompt, /If they are not available, stop/, source);
    assert.match(prompt, /use only those/i, `${source}: the prompt must use only the listed tools`);
    assert.match(prompt, /If a tool you need is missing, tell me which one/, source);
  });
}
