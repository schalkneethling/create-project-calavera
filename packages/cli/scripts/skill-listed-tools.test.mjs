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

/**
 * The sentences that mention a refused or denied call and the CLI without forbidding the CLI or
 * sending the agent back to the user.
 *
 * @param {string} text
 * @returns {string[]}
 */
function cliAfterRefusal(text) {
  return instructionsIn(text)
    .flatMap(sentencesIn)
    .filter(
      (sentence) =>
        /\b(?:den(?:y|ies|ied)|refus\w*|declin\w*)\b/i.test(sentence) &&
        /\b(?:CLI|apply command|create-project-calavera)\b/.test(sentence) &&
        !/\b(?:never|do not|ask the user)\b/i.test(sentence),
    );
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

test("the refusal check catches a sentence that runs the CLI after a denied call", () => {
  assert.deepEqual(
    cliAfterRefusal(
      "If the user denied the call when prompted, run the CLI apply command instead.",
    ),
    ["If the user denied the call when prompted, run the CLI apply command instead."],
  );
  assert.deepEqual(
    cliAfterRefusal(
      "When the user refuses a Calavera tool call, stop, and never run the CLI apply command in its place.",
    ),
    [],
  );
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

    const missingServer = onlyInstructionMatching(
      instructions,
      /the Calavera tools are unavailable/i,
      source,
    );
    const missingTool = onlyInstructionMatching(instructions, /that is a missing tool/i, source);

    assert.notEqual(missingServer, missingTool, `${source} handles both cases in one instruction`);
    // No listed tools can also mean the user's own deny rule, so the agent names both causes and
    // asks before registering or repairing anything.
    for (const cause of [/not registered/, /does not allow/]) {
      assert.match(missingServer, cause, `${source}: no listed tools must name ${cause}`);
    }
    assert.match(missingServer, /tell the user that the Calavera tools are unavailable/i, source);
    assert.match(missingServer, /ask the user before you register or repair/i, source);
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
    // The agent cannot tell a tool the server lacks from one the client hides, so no branch may
    // send it to Fallbacks without asking (see the switch test below).
    assert.doesNotMatch(missingTool, /Fallbacks/, `${source}: step 2 must not route to Fallbacks`);
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

  test(`the bundled Calavera skill at ${source} asks before switching from MCP to the CLI`, async () => {
    const skill = await readFile(url, "utf8");
    const rule = onlyInstructionMatching(
      instructionsIn(skill),
      /before you switch from the MCP tools to the CLI/i,
      source,
    );

    assert.match(rule, /ask the user and wait for their agreement/i, source);
    for (const reason of ["the server lacks", "the client hides", "permission prompt"]) {
      assert.ok(rule.includes(reason), `${source}: the switch rule does not cover ${reason}`);
    }
    assert.match(
      onlySentenceWith(rule, ["refuses a Calavera tool call"], source),
      /never run the CLI apply command in its place/,
      `${source}: a refused call must not lead to the CLI apply`,
    );
  });

  test(`the bundled Calavera skill at ${source} never permits the CLI after a refused call`, async () => {
    const skill = await readFile(url, "utf8");

    assert.deepEqual(cliAfterRefusal(skill), [], `${source} permits the CLI after a refusal`);
  });

  test(`the bundled Calavera skill at ${source} keeps both approval steps`, async () => {
    const skill = await readFile(url, "utf8");

    assert.match(skill, /Call `apply_recipe` only after the user explicitly approves the dry run/);
    assert.match(
      sectionText(skill, "Fallbacks", source),
      /Ask the user to approve the preview before running the matching apply command/,
    );
    assert.match(
      onlySentenceWith(skill, ["`create-project-calavera apply`"], source),
      /agreed to.*approves its preview/,
      `${source}: the CLI apply needs the switch agreement and an approved preview`,
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
