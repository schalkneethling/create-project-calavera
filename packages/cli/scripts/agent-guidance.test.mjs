import assert from "node:assert/strict";
import test from "node:test";

import {
  AGENT_BOOTSTRAP_MARKER,
  AGENT_BOOTSTRAP_SECTION_END,
  AGENT_BOOTSTRAP_SECTION_START,
} from "../src/agent-bootstrap-files.js";
import {
  createAgentBootstrapGuidance,
  createAgentBootstrapGuidanceSection,
} from "../src/agent-guidance.js";

// A project that Vite+ does not manage gets the guidance section without a formatter pass, so the
// template text is the text written into its AGENTS.md. One blank line separates each marker from
// the guidance, as in the whole-file form (#669).
test("the guidance section holds the whole-file guidance between its markers, one blank line from each", () => {
  const guidance = createAgentBootstrapGuidance().slice(`${AGENT_BOOTSTRAP_MARKER}\n\n`.length);

  assert.ok(createAgentBootstrapGuidance().startsWith(`${AGENT_BOOTSTRAP_MARKER}\n\n# `));
  assert.ok(guidance.endsWith(".\n"));
  assert.ok(!guidance.endsWith("\n\n"));
  assert.equal(
    createAgentBootstrapGuidanceSection(),
    `${AGENT_BOOTSTRAP_SECTION_START}\n\n${guidance}\n${AGENT_BOOTSTRAP_SECTION_END}\n`,
  );
});
