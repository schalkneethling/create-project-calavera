import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { profileDefaults, projectLocalCommandSteps } from "../../../packages/cli/src/recipe.js";
import {
  assertPublishedCliCompatibility,
  commaSeparatedValues,
  composerNextCommands,
  composerRecipe,
} from "../recipe-builder.js";

const fixtures = JSON.parse(
  await readFile(new URL("./fixtures/composer-recipes.json", import.meta.url), "utf8"),
);

/** @param {unknown} value */
function serialized(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

test("the default profile selection matches the pinned recipe byte for byte", () => {
  const recipe = composerRecipe({
    profile: "default",
    packageManager: "npm",
    integrations: [...profileDefaults.default],
    baseline: { available: "widely", severity: "warning" },
    repositoryControls: { repository: "", requiredChecks: [] },
  });

  assert.equal(serialized(recipe), serialized(fixtures["default-profile"]));
});

test("integration options, targets, and artifact order match the pinned recipe byte for byte", () => {
  const recipe = composerRecipe({
    profile: "minimal",
    packageManager: "pnpm",
    integrations: ["editorconfig", "stylelint-baseline", "github-repository-controls"],
    aiArtifacts: [
      { id: "skill-calavera", target: "codex" },
      { id: "hook-block-dangerous-commands", target: " codex " },
      { id: "agent-technical-devils-advocate", target: "" },
    ],
    baseline: { available: "2024", severity: "error" },
    repositoryControls: {
      repository: "octocat/example",
      requiredChecks: commaSeparatedValues(" quality, ,build "),
    },
  });

  assert.equal(serialized(recipe), serialized(fixtures["minimal-with-options-and-artifacts"]));
});

test("an unselected integration drops its options and an empty package manager defaults to npm", () => {
  const recipe = composerRecipe({
    profile: "minimal",
    packageManager: "",
    integrations: [],
    baseline: { available: "newly", severity: "error" },
    repositoryControls: { repository: "octocat/example", requiredChecks: ["quality"] },
  });

  assert.equal(serialized(recipe), serialized(fixtures["minimal-bare"]));
});

test("a target with a path separator is refused with the artifact index", () => {
  assert.throws(
    () =>
      composerRecipe({
        profile: "minimal",
        aiArtifacts: [
          { id: "skill-calavera" },
          { id: "hook-block-dangerous-commands", target: "../codex" },
        ],
      }),
    /Invalid aiArtifacts\[1\]\.target: \.\.\/codex/,
  );
});

test("an unknown artifact id is refused by name", () => {
  assert.throws(
    () => composerRecipe({ profile: "minimal", aiArtifacts: [{ id: "skill-missing" }] }),
    { message: "Unknown AI artifact: skill-missing." },
  );
});

test("the published CLI guard takes the CLI version as an argument", () => {
  const recipe = composerRecipe({
    profile: "default",
    integrations: [...profileDefaults.default],
    baseline: { available: "widely", severity: "warning" },
  });

  assert.throws(
    () => assertPublishedCliCompatibility(recipe, "3.0.0"),
    /The published Calavera CLI v3\.0\.0 does not support: default/,
  );
  assert.deepEqual(assertPublishedCliCompatibility(recipe, "4.0.0"), recipe);

  const minimal = composerRecipe({
    profile: "minimal",
    integrations: ["knip"],
    aiArtifacts: [{ id: "skill-release-with-confidence" }],
  });
  assert.throws(
    () => assertPublishedCliCompatibility(minimal, "2.2.0"),
    /v2\.2\.0 does not support: knip/,
  );
  assert.throws(
    () => assertPublishedCliCompatibility({ ...minimal, integrations: [] }, "2.3.0"),
    /does not support these AI artifacts: skill-release-with-confidence/,
  );
  assert.throws(() => assertPublishedCliCompatibility({ profile: "minimal" }, "4.0.0"));
});

test("only leaving lint:html out of quality records an html-validate option", () => {
  const selection = { profile: "minimal", integrations: ["html-validate"] };

  assert.equal(
    composerRecipe({ ...selection, htmlValidate: { quality: true } }).integrationOptions,
    undefined,
  );
  assert.equal(composerRecipe(selection).integrationOptions, undefined);
  assert.deepEqual(
    composerRecipe({ ...selection, htmlValidate: { quality: false } }).integrationOptions,
    { "html-validate": { quality: false } },
  );
  assert.equal(
    composerRecipe({ profile: "minimal", integrations: [], htmlValidate: { quality: false } })
      .integrationOptions,
    undefined,
  );
});

test("the published CLI guard refuses html-validate options below CLI 4.2.0", () => {
  const recipe = composerRecipe({
    profile: "minimal",
    integrations: ["html-validate"],
    htmlValidate: { quality: false },
  });

  assert.throws(
    () => assertPublishedCliCompatibility(recipe, "4.1.0"),
    /The published Calavera CLI v4\.1\.0 does not support integrationOptions for: html-validate/,
  );
  assert.deepEqual(assertPublishedCliCompatibility(recipe, "4.2.0"), recipe);
  assert.ok(
    assertPublishedCliCompatibility(
      composerRecipe({ profile: "minimal", integrations: ["html-validate"] }),
      "4.1.0",
    ),
  );
});

test("next commands follow the package manager and default to npm", () => {
  assert.deepEqual(composerNextCommands("pnpm"), projectLocalCommandSteps("pnpm"));
  assert.deepEqual(composerNextCommands(undefined), projectLocalCommandSteps("npm"));
});
