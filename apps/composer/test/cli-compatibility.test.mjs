import assert from "node:assert/strict";
import test from "node:test";

import { integrationCatalog } from "../../../packages/cli/src/catalog.js";
import {
  assertRecipeIntegrationsSupported,
  CLI_VERSION_PATTERN,
  filterIntegrationsForCli,
  integrationResponseForCli,
  isFallbackCliIntegration,
  loadPublishedCliCompatibility,
  SAFE_CLI_FALLBACK_VERSION,
  versionMeetsMinimum,
} from "../cli-compatibility.js";

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

test("every post-v2.2 integration declares its minimum CLI version", () => {
  for (const integration of integrationCatalog) {
    if (isFallbackCliIntegration(integration.id)) continue;
    assert.equal(typeof integration.minimumCliVersion, "string", integration.id);
    assert.match(integration.minimumCliVersion, CLI_VERSION_PATTERN, integration.id);
  }
});

test("v2.2 compatibility excludes Knip and logical CSS until v2.3 is published", () => {
  const v220Ids = filterIntegrationsForCli(integrationCatalog, "2.2.0").map(({ id }) => id);
  const v230Ids = filterIntegrationsForCli(integrationCatalog, "2.3.0").map(({ id }) => id);

  assert.equal(v220Ids.includes("stylelint-logical-css"), false);
  assert.equal(v220Ids.includes("knip"), false);
  assert.equal(v220Ids.includes("stylelint-baseline"), true);
  assert.equal(v230Ids.includes("stylelint-logical-css"), true);
  assert.equal(v230Ids.includes("knip"), true);
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
