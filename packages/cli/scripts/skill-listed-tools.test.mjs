// #1053: ADR-0018 Decision 7. The skill and the project's pinned MCP server update separately, so
// a skill newer than the server may describe a tool the server does not have. The skill tells the
// agent to use only the tools listed to it, to treat no listed tools apart from one missing tool,
// and to ask the user before switching from the MCP tools to the CLI for any reason. These tests
// keep the two copies identical and check that each gate sentence is still there. They check that
// the safe sentences exist; they cannot prove that no other sentence contradicts them.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import { bundledSkillCopies } from "./bundled-skill-copies.mjs";

// The sentences that keep the dry run and the CLI preview as the approval steps, and that make
// every switch from MCP to the CLI the user's choice.
const GATES = [
  // The switch rule.
  "Before you switch from the MCP tools to the CLI in Fallbacks, for any reason, ask the user and wait for their agreement.",
  // A call refused at a permission prompt.
  "When the user refuses a Calavera tool call at a permission prompt, stop and ask the user how to continue, and never run the CLI apply command in its place unless the user then agrees to switch to Fallbacks.",
  // The dry-run approval before apply_recipe.
  "Call `apply_recipe` only after the user explicitly approves the dry run.",
  // The Fallbacks entry condition and its preview approval.
  "Use this flow only after the user agrees to switch from the MCP tools to the CLI",
  "Ask the user to approve the preview before running the matching apply command.",
  // A missing approval tool.
  "When `compose_recipe`, `dry_run_apply`, or `apply_recipe` is missing, apply nothing through MCP,",
];

test("both copies of the bundled Calavera skill are byte-identical", async () => {
  const [first, ...rest] = await Promise.all(bundledSkillCopies.map(({ url }) => readFile(url)));
  for (const [index, copy] of rest.entries()) {
    assert.ok(
      first.equals(copy),
      `${bundledSkillCopies[index + 1].source} differs from ${bundledSkillCopies[0].source}`,
    );
  }
});

for (const { source, url } of bundledSkillCopies) {
  test(`the bundled Calavera skill at ${source} uses only the tools listed to the agent`, async () => {
    const skill = await readFile(url, "utf8");

    assert.doesNotMatch(skill, /Look for tools named/, `${source} still has a fixed tool list`);
    assert.match(skill, /use only the Calavera tools listed to you/, source);
    assert.match(skill, /Never call a tool that is not listed to you\./, source);
  });

  test(`the bundled Calavera skill at ${source} separates no listed tools from a missing tool`, async () => {
    const skill = await readFile(url, "utf8");
    const steps = skill.split(/\n(?=\d+\.\s)/);
    const noTools = steps.filter((step) => step.includes("the Calavera tools are unavailable"));
    const missingTool = steps.filter((step) => step.includes("that is a missing tool"));

    assert.equal(noTools.length, 1, `${source} must have one step for no listed tools`);
    assert.equal(missingTool.length, 1, `${source} must have one step for a missing tool`);
    assert.notEqual(noTools[0], missingTool[0], `${source} handles both cases in one step`);
  });

  test(`the bundled Calavera skill at ${source} keeps every approval and switch gate`, async () => {
    const skill = await readFile(url, "utf8");

    for (const gate of GATES) {
      assert.ok(skill.includes(gate), `${source} no longer says: ${gate}`);
    }
  });

  test(`the bundled Calavera skill at ${source} suggests a prompt that does not stop on a missing tool`, async () => {
    const skill = await readFile(url, "utf8");

    assert.doesNotMatch(skill, /If they are not available, stop/, source);
    assert.match(skill, /If a tool you need is missing, tell me which one/, source);
  });
}
