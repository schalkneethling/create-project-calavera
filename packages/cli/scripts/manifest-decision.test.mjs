// Issue #430: the manifest decision itself, without a project on disk. The tests that apply in a
// real directory are in manifest-choice.test.mjs.
import assert from "node:assert/strict";
import { join } from "node:path";
import test from "node:test";

import {
  ancestorAlreadyManagedError,
  initApplyManifestChoiceError,
  manifestChoiceNotApplicableError,
  manifestChoiceRequiredError,
  manifestDecision,
  manifestDecisionLines,
  pathAtAncestor,
} from "../src/manifest-decision.js";

const root = join("/", "work", "repo");
const directory = join(root, "packages", "fresh");
const manifestPath = join(root, "package.json");

/** @param {"managed" | "unmanaged"} status */
function decisionUnder(status) {
  const decision = manifestDecision(directory, {
    status: "unknown",
    corroborating: [],
    ancestor: { manifestPath, status },
  });
  assert.ok(decision);
  return decision;
}

test("there is a decision only when the directory has no manifest but one above it was found", () => {
  assert.equal(manifestDecision(directory, { status: "managed", corroborating: [] }), undefined);
  assert.equal(manifestDecision(directory, { status: "unmanaged", corroborating: [] }), undefined);
  assert.equal(manifestDecision(directory, { status: "unknown", corroborating: [] }), undefined);
  // Only "unknown" makes a decision, even if a record carried an ancestor with another status.
  assert.equal(
    manifestDecision(directory, {
      status: "managed",
      corroborating: [],
      ancestor: { manifestPath, status: "managed" },
    }),
    undefined,
  );
  assert.deepEqual(decisionUnder("managed").ancestor, { manifestPath, status: "managed" });
  assert.deepEqual(
    decisionUnder("managed").options.map(({ choice }) => choice),
    ["create-here", "apply-at-ancestor", "abandon"],
  );
});

test("the decision states the ancestor's verdict in words", () => {
  const managed = manifestDecisionLines(decisionUnder("managed"));
  const unmanaged = manifestDecisionLines(decisionUnder("unmanaged"));

  assert.match(
    managed[0],
    new RegExp(`, ${manifestPath.replaceAll("/", "\\/")}, is managed by Vite\\+\\.`),
  );
  assert.match(unmanaged[0], /is not managed by Vite\+\./);
  assert.match(managed[1], /^- create-here: .*as a project managed by Vite\+/);
  assert.match(unmanaged[1], /^- create-here: .*as a project not managed by Vite\+/);
  assert.match(managed[2], new RegExp(`^- apply-at-ancestor: Apply the recipe in ${root}`));
  assert.equal(managed[3], "- abandon: Change nothing.");
});

test("each error says what stopped and that nothing was written", () => {
  const decision = decisionUnder("managed");
  const writesNothing = /Calavera stopped before writing anything\.$/;

  assert.match(manifestChoiceRequiredError(decision).message, /--manifest-choice <choice>/);
  assert.match(manifestChoiceRequiredError(decision).message, writesNothing);
  assert.match(
    manifestChoiceNotApplicableError(directory, { status: "managed", corroborating: [] }).message,
    /has its own package\.json, so there is no manifest choice to make/,
  );
  assert.match(
    manifestChoiceNotApplicableError(directory, { status: "unknown", corroborating: [] }).message,
    /has no package\.json and no manifest above it was found, so there is no manifest choice to make/,
  );
  assert.match(initApplyManifestChoiceError(decision).message, /--manifest-choice create-here/);
  assert.deepEqual(initApplyManifestChoiceError(decision).message.split("\n").slice(0, 4), [
    ...manifestDecisionLines(decision),
  ]);
  assert.match(initApplyManifestChoiceError(decision).message, writesNothing);
  const existing = join(root, "calavera.config.json");
  assert.match(
    ancestorAlreadyManagedError(decision, existing).message,
    new RegExp(`in ${root}, but ${existing} already exists there`),
  );
});

test("a path inside the directory moves to the ancestor's directory, and any other path stays", () => {
  const decision = decisionUnder("managed");

  assert.equal(
    pathAtAncestor(decision, "calavera.config.json"),
    join(root, "calavera.config.json"),
  );
  assert.equal(pathAtAncestor(decision, join(directory, "a", "b.json")), join(root, "a", "b.json"));
  // A folder whose name starts with two dots is still inside.
  assert.equal(pathAtAncestor(decision, join("..x", "c.json")), join(root, "..x", "c.json"));
  assert.equal(
    pathAtAncestor(decision, join("..", "other.json")),
    join(root, "packages", "other.json"),
  );
  assert.equal(pathAtAncestor(decision, "/elsewhere/r.json"), "/elsewhere/r.json");
  assert.equal(pathAtAncestor(decision, "."), directory);
  assert.equal(pathAtAncestor(decision, ".."), join(root, "packages"));
});
