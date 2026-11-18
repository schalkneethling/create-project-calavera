import assert from "node:assert/strict";
import test from "node:test";

import { AI_TARGET_LABELS } from "../src/ai/catalog.js";
import { integrationStatusLabels } from "../src/catalog.js";
import {
  composeRecipe,
  listAiArtifactOptions,
  listIntegrationOptions,
  validateRecipe,
} from "../src/recipe.js";
import { artifactTargetPromptOptions, groupedPromptOptions } from "../src/utils/prompt-options.js";

/** @param {Record<string, Array<{ value: string, label: string, hint: string }>>} groups */
function promptOptionsById(groups) {
  return new Map(
    Object.values(groups)
      .flat()
      .map((option) => [option.value, option]),
  );
}

test("the integration prompt shows each status by its catalog label, not its ID (#990)", () => {
  const integrations = listIntegrationOptions();
  const options = promptOptionsById(groupedPromptOptions(integrations));

  for (const integration of integrations) {
    const hintParts = options.get(integration.id)?.hint.split(" · ") ?? [];

    assert.ok(
      hintParts.includes(integrationStatusLabels[integration.status]),
      `${integration.id} hint "${hintParts.join(" · ")}" needs its status label`,
    );
    assert.ok(
      !hintParts.includes(integration.status),
      `${integration.id} hint shows the raw status ID ${integration.status}`,
    );
  }

  const frameworkSpecific = integrations.find(({ status }) => status === "framework-specific");
  assert.ok(frameworkSpecific, "the catalog needs a framework-specific integration for this test");
  assert.match(options.get(frameworkSpecific.id)?.hint ?? "", /^Framework-specific\b/);
});

test("the AI artifact prompt shows no raw status or target IDs (#990)", () => {
  const artifacts = listAiArtifactOptions();
  const options = promptOptionsById(groupedPromptOptions(artifacts));

  for (const artifact of artifacts) {
    const hintParts = options.get(artifact.id)?.hint.split(" · ") ?? [];

    assert.ok(!hintParts.includes(artifact.status), `${artifact.id} hint shows its raw status`);
    for (const { id } of artifact.targets) {
      assert.ok(
        !hintParts.includes(`target: ${id}`),
        `${artifact.id} hint shows the raw target ID ${id}`,
      );
    }
    if (artifact.defaultTarget) {
      assert.ok(
        hintParts.includes(`target: ${AI_TARGET_LABELS[artifact.defaultTarget]}`),
        `${artifact.id} hint "${hintParts.join(" · ")}" needs its default target by label`,
      );
    }
  }
});

test("the target prompt offers only the artifact's targets, by label, and each passes recipe validation (#990)", () => {
  const artifactsWithTargets = listAiArtifactOptions().filter(
    ({ defaultTarget }) => defaultTarget !== undefined,
  );
  assert.ok(artifactsWithTargets.length > 0, "the catalog needs an artifact with targets");

  for (const artifact of artifactsWithTargets) {
    const options = artifactTargetPromptOptions(artifact);

    assert.deepEqual(
      options,
      artifact.targets.map(({ id }) => ({ value: id, label: AI_TARGET_LABELS[id] })),
      `${artifact.id} target options`,
    );
    assert.ok(
      options.some(({ value }) => value === artifact.defaultTarget),
      `${artifact.id} target options include its default target`,
    );

    for (const { value } of options) {
      // The path --init takes: compose the recipe from the answer, then validate it.
      const recipe = composeRecipe({
        profile: "default",
        tools: [],
        aiArtifacts: [{ id: artifact.id, target: value }],
      });
      validateRecipe(recipe);
      assert.deepEqual(
        recipe.ai?.find(({ id }) => id === artifact.id),
        { id: artifact.id, target: value },
        `${artifact.id} with target ${value}`,
      );
    }
  }
});

test("groupedPromptOptions groups by catalog group and builds the hint from labels only (#990)", () => {
  assert.deepEqual(
    groupedPromptOptions([
      {
        id: "agent-example",
        group: "Agents",
        label: "Example agent",
        type: "agent",
        targets: [
          { id: "claude-code", label: "Claude Code" },
          { id: "codex", label: "Codex" },
        ],
        defaultTarget: "codex",
      },
      { id: "integration-example", group: "Agents", statusLabel: "Optional" },
      { id: "ungrouped" },
    ]),
    {
      Agents: [
        { value: "agent-example", label: "Example agent", hint: "agent · target: Codex" },
        { value: "integration-example", label: "integration-example", hint: "Optional" },
      ],
      Other: [{ value: "ungrouped", label: "ungrouped", hint: "" }],
    },
  );
});
