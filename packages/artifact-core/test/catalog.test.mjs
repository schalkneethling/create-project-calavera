import assert from "node:assert/strict";
import test from "node:test";

import {
  ARTIFACT_TARGET_LABELS,
  artifactCatalog,
  DEFAULT_ARTIFACT_TARGET,
} from "../src/catalog.js";

// #580: the Composer and agents show a target by its label, so every target an artifact declares,
// and the default target, needs one in the catalog rather than in each consumer.
test("every artifact target, and the default target, has a display label", () => {
  const targets = new Set([
    DEFAULT_ARTIFACT_TARGET,
    ...artifactCatalog.flatMap((artifact) => artifact.targets ?? []),
  ]);

  assert.ok(targets.size > 1);
  for (const target of targets) {
    assert.equal(typeof ARTIFACT_TARGET_LABELS[target], "string", `${target} needs a label`);
    assert.ok(
      ARTIFACT_TARGET_LABELS[target].trim().length > 0,
      `${target} label must not be empty`,
    );
  }
});

test("the target labels are the names the tools use for themselves", () => {
  assert.deepEqual(ARTIFACT_TARGET_LABELS, {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor",
    opencode: "OpenCode",
  });
});
