import assert from "node:assert/strict";
import test from "node:test";

import {
  baselineConfiguration,
  baselineMetadata,
  createBaselineEngine,
  describeBaselineTarget,
  normalizeBaselineTarget,
  recommendBaselineTarget,
  searchBaselineFeatures,
} from "../src/index.js";
import { isCssSpecificationUrl } from "../src/specification-url.js";

test("generated Baseline data records pinned sources and CSS features", () => {
  assert.equal(baselineMetadata.sources.webFeatures, "3.34.0");
  assert.equal(baselineMetadata.sources.baselineBrowserMapping, "2.10.43");
  assert.ok(baselineMetadata.featureCount > 100);
  assert.ok(searchBaselineFeatures("nesting").some(({ id }) => id === "nesting"));
});

test("CSS specification URLs require the exact approved host", () => {
  assert.equal(isCssSpecificationUrl("https://drafts.csswg.org/css-grid/"), true);
  assert.equal(isCssSpecificationUrl("https://drafts.csswg.org.evil.example/css-grid/"), false);
  assert.equal(
    isCssSpecificationUrl("https://evil.example/?url=https://drafts.csswg.org/css-grid/"),
    false,
  );
  assert.equal(isCssSpecificationUrl("not a URL containing drafts.csswg.org"), false);
});

test("target descriptions distinguish moving and fixed targets", () => {
  assert.equal(describeBaselineTarget("widely").fixed, false);
  assert.equal(describeBaselineTarget("newly").evolving, true);
  assert.equal(describeBaselineTarget(2025).fixed, true);
  assert.ok(describeBaselineTarget(2025).browserVersions.chrome);
});

test("target normalization rejects unsupported values", () => {
  assert.equal(normalizeBaselineTarget("2025"), 2025);
  assert.throws(() => normalizeBaselineTarget("limited"), /Baseline target/);
  assert.throws(() => normalizeBaselineTarget(2014), /Baseline target/);
});

test("feature recommendations identify the earliest fixed target and limiting features", () => {
  const recommendation = recommendBaselineTarget(["has", "subgrid", "nesting"]);

  assert.equal(recommendation.recommendedTarget, 2023);
  assert.equal(recommendation.compatibleWithNewly, true);
  assert.ok(recommendation.limitingFeatures.length > 0);
  assert.equal(
    recommendation.integrationOptions["stylelint-baseline"].available,
    recommendation.recommendedTarget,
  );
});

test("limited features do not receive a Baseline target", () => {
  const fixture = {
    schemaVersion: 1,
    generatedAt: "2026-01-01T00:00:00.000Z",
    sources: {},
    firstBaselineYear: 2015,
    currentYear: 2026,
    browserTargets: { widely: {}, newly: {}, years: { 2026: {} } },
    features: [
      {
        id: "future-css",
        name: "Future CSS",
        description: "Not interoperable yet.",
        groups: ["css"],
        availability: "limited",
        support: {},
        stylelintDetectable: true,
      },
    ],
  };
  const engine = createBaselineEngine(fixture);
  const recommendation = engine.recommendTarget(["future-css"]);

  assert.equal(recommendation.recommendedTarget, null);
  assert.equal(recommendation.compatibleWithNewly, false);
  assert.deepEqual(
    recommendation.limitingFeatures.map(({ id }) => id),
    ["future-css"],
  );
});

test("configuration output is shared by Stylelint and Calavera recipes", () => {
  const output = baselineConfiguration(2025);

  assert.deepEqual(output.stylelintRule["plugin/use-baseline"], [
    true,
    { available: 2025, severity: "warning" },
  ]);
  assert.deepEqual(
    output.calaveraRecipe.integrationOptions["stylelint-baseline"],
    output.stylelintRule["plugin/use-baseline"][1],
  );
});
