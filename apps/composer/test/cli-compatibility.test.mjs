import assert from "node:assert/strict";
import test from "node:test";

import Ajv from "ajv";
import { integrationCatalog } from "../../../packages/cli/src/catalog.js";
import { aiArtifactCatalog } from "../../../packages/cli/src/ai/catalog.js";
import {
  artifactResponseForCli,
  assertRecipeArtifactsSupported,
  assertRecipeIntegrationsSupported,
  CLI_VERSION_PATTERN,
  filterArtifactsForCli,
  filterIntegrationsForCli,
  integrationResponseForCli,
  isFallbackCliIntegration,
  loadPublishedCliCompatibility,
  SAFE_CLI_FALLBACK_VERSION,
  versionSatisfiesCompatibility,
  versionMeetsMinimum,
} from "../cli-compatibility.js";
import viteConfig from "../vite.config.js";
import { releaseEnvironmentInputSchema } from "../repository-controls-input-schema.js";

test("WebMCP release-environment schema accepts every disabled representation", () => {
  const validate = new Ajv({ strict: true }).compile(releaseEnvironmentInputSchema);

  assert.equal(validate(false), true);
  assert.equal(validate(null), true);
  assert.equal(validate({ reviewers: ["octocat"] }), true);
  assert.equal(validate({}), false);
  assert.equal(validate({ reviewers: ["octocat"], waitTimer: 43_201 }), false);
});

test("version comparison keeps unreleased integrations behind their CLI release", () => {
  assert.equal(versionMeetsMinimum("2.2.0", "2.3.0"), false);
  assert.equal(versionMeetsMinimum("2.3.0-alpha", "2.3.0-beta"), false);
  assert.equal(versionMeetsMinimum("2.3.0-beta", "2.3.0-alpha"), true);
  assert.equal(versionMeetsMinimum("2.3.0-beta.2", "2.3.0-beta.11"), false);
  assert.equal(versionMeetsMinimum("2.3.0-next.1", "2.3.0"), false);
  assert.equal(versionMeetsMinimum("2.3.0", "2.3.0-next.1"), true);
  assert.equal(versionMeetsMinimum("2.3.0", "2.3.0"), true);
  assert.equal(versionMeetsMinimum("3.0.0", "2.3.0"), true);
});

test("artifact compatibility honors complete Calavera version ranges", () => {
  assert.equal(versionSatisfiesCompatibility("2.3.0", ">=2.3.0 <3"), true);
  assert.equal(versionSatisfiesCompatibility("2.4.0-next.1", ">=2.4.0 <3"), false);
  assert.equal(versionSatisfiesCompatibility("2.4.0", ">=2.4.0 <3"), true);
  assert.equal(versionSatisfiesCompatibility("3.0.0", ">=2.4.0 <3"), false);
  assert.equal(versionSatisfiesCompatibility("2.5.0", "^2.4.0"), true);
  assert.throws(
    () => versionSatisfiesCompatibility("2.4.0", "not a semver range"),
    /Invalid Calavera compatibility range/,
  );
});

test("every post-v2.2 integration declares its minimum CLI version", () => {
  for (const integration of integrationCatalog) {
    if (isFallbackCliIntegration(integration.id)) continue;
    assert.equal(typeof integration.minimumCliVersion, "string", integration.id);
    assert.match(integration.minimumCliVersion, CLI_VERSION_PATTERN, integration.id);
  }
});

test("v2.2 compatibility excludes post-v2.2 integrations until v2.3 is published", () => {
  const v220Ids = filterIntegrationsForCli(integrationCatalog, "2.2.0").map(({ id }) => id);
  const v230Ids = filterIntegrationsForCli(integrationCatalog, "2.3.0").map(({ id }) => id);

  assert.equal(v220Ids.includes("stylelint-logical-css"), false);
  assert.equal(v220Ids.includes("knip"), false);
  assert.equal(v220Ids.includes("varlock"), false);
  assert.equal(v220Ids.includes("stylelint-baseline"), true);
  assert.equal(v230Ids.includes("stylelint-logical-css"), true);
  assert.equal(v230Ids.includes("knip"), true);
  assert.equal(v230Ids.includes("varlock"), true);
});

test("repository controls require the Calavera 2.5 CLI contract", () => {
  const before = filterIntegrationsForCli(integrationCatalog, "2.4.0").map(({ id }) => id);
  const supported = filterIntegrationsForCli(integrationCatalog, "2.5.0").map(({ id }) => id);

  assert.equal(before.includes("github-repository-controls"), false);
  assert.equal(supported.includes("github-repository-controls"), true);
});

test("WebMCP catalog responses and recipes use the same published CLI boundary", () => {
  const response = integrationResponseForCli(
    { profile: "minimal", integrations: integrationCatalog },
    "2.2.0",
  );

  assert.equal(
    response.integrations.some(({ id }) => id === "knip"),
    false,
  );
  assert.throws(
    () =>
      assertRecipeIntegrationsSupported(
        { integrations: ["stylelint-logical-css"] },
        integrationCatalog,
        "2.2.0",
      ),
    /does not support: stylelint-logical-css/,
  );
  assert.deepEqual(
    assertRecipeIntegrationsSupported(
      { integrations: ["stylelint-logical-css"] },
      integrationCatalog,
      "2.3.0",
    ),
    { integrations: ["stylelint-logical-css"] },
  );

  const artifactResponse = artifactResponseForCli({ artifacts: aiArtifactCatalog }, "2.3.0");
  assert.equal(
    artifactResponse.artifacts.some(({ id }) => id === "skill-release-with-confidence"),
    false,
  );
  assert.throws(
    () =>
      assertRecipeArtifactsSupported(
        { ai: [{ id: "skill-release-with-confidence" }] },
        aiArtifactCatalog,
        "2.3.0",
      ),
    /does not support these AI artifacts: skill-release-with-confidence/,
  );
  assert.deepEqual(
    assertRecipeArtifactsSupported(
      { ai: [{ id: "skill-release-with-confidence" }] },
      aiArtifactCatalog,
      "2.4.0",
    ),
    { ai: [{ id: "skill-release-with-confidence" }] },
  );
});

test("release-with-confidence remains hidden until CLI 2.4.0 is published", () => {
  const v230Ids = filterArtifactsForCli(aiArtifactCatalog, "2.3.0").map(({ id }) => id);
  const v240Ids = filterArtifactsForCli(aiArtifactCatalog, "2.4.0").map(({ id }) => id);

  assert.equal(v230Ids.includes("skill-release-with-confidence"), false);
  assert.equal(v240Ids.includes("skill-release-with-confidence"), true);
});

test("published CLI lookup fails closed to the known v2.2 catalog", async () => {
  const compatibility = await loadPublishedCliCompatibility(async () => {
    throw new Error("registry unavailable");
  });

  assert.deepEqual(compatibility, {
    version: SAFE_CLI_FALLBACK_VERSION,
    source: "fallback",
  });
});

test("published CLI lookup accepts valid npm latest metadata", async () => {
  const compatibility = await loadPublishedCliCompatibility(async () => ({
    ok: true,
    json: async () => ({ version: "2.3.0" }),
  }));

  assert.deepEqual(compatibility, { version: "2.3.0", source: "npm" });
});

test("Composer build rejects Node-only modules in its browser graph", () => {
  const browserOnlyPlugin = viteConfig.plugins.find(
    ({ name }) => name === "browser-only-module-graph",
  );

  assert.ok(browserOnlyPlugin);
  assert.equal(browserOnlyPlugin.enforce, "pre");
  assert.throws(
    () =>
      browserOnlyPlugin.resolveId.call(
        {
          error(message) {
            throw new Error(message);
          },
        },
        "node:path",
        "packages/cli/src/recipe.js",
      ),
    {
      message: "Node-only module node:path reached the Composer from packages/cli/src/recipe.js.",
    },
  );
});
