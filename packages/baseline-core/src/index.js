// @ts-check
import baselineData from "../data/baseline.json" with { type: "json" };

const MOVING_TARGETS = new Set(["widely", "newly"]);

/**
 * @param {unknown} target
 * @param {{ firstBaselineYear: number, currentYear: number }} data
 * @returns {"widely" | "newly" | number}
 */
export function normalizeBaselineTarget(target, data = baselineData) {
  if (typeof target === "string" && MOVING_TARGETS.has(target)) {
    return /** @type {"widely" | "newly"} */ (target);
  }

  const year = typeof target === "string" && /^\d{4}$/.test(target) ? Number(target) : target;

  if (
    Number.isInteger(year) &&
    Number(year) >= data.firstBaselineYear &&
    Number(year) <= data.currentYear
  ) {
    return Number(year);
  }

  throw new Error(
    `Baseline target must be widely, newly, or a year from ${data.firstBaselineYear} through ${data.currentYear}.`,
  );
}

/**
 * @param {unknown} value
 * @returns {asserts value is typeof baselineData}
 */
function assertDataset(value) {
  const data = /** @type {Record<string, unknown>} */ (value);
  if (
    !value ||
    typeof value !== "object" ||
    !Array.isArray(data.features) ||
    typeof data.firstBaselineYear !== "number" ||
    typeof data.currentYear !== "number" ||
    !data.browserTargets
  ) {
    throw new Error("Expected a generated Baseline dataset.");
  }
}

/**
 * @param {typeof baselineData} [data]
 */
export function createBaselineEngine(data = baselineData) {
  assertDataset(data);
  const featuresById = new Map(data.features.map((feature) => [feature.id, feature]));

  /** @param {unknown} target */
  function featuresForTarget(target) {
    const normalized = normalizeBaselineTarget(target, data);

    if (normalized === "widely") {
      return data.features.filter(({ availability }) => availability === "widely");
    }

    if (normalized === "newly") {
      return data.features.filter(({ availability }) => availability !== "limited");
    }

    return data.features.filter(({ baselineLowDate }) => {
      return baselineLowDate && Number(baselineLowDate.slice(0, 4)) <= normalized;
    });
  }

  /** @param {unknown} target */
  function browserVersionsForTarget(target) {
    const normalized = normalizeBaselineTarget(target, data);
    const years = /** @type {Record<string, typeof data.browserTargets.widely>} */ (
      data.browserTargets.years
    );
    return typeof normalized === "number"
      ? years[String(normalized)]
      : data.browserTargets[normalized];
  }

  /** @param {unknown} target */
  function describeTarget(target) {
    const normalized = normalizeBaselineTarget(target, data);
    const fixed = typeof normalized === "number";

    return {
      target: normalized,
      fixed,
      evolving:
        normalized === "widely" || normalized === "newly" || normalized === data.currentYear,
      description: fixed
        ? `A fixed cumulative target containing features that became Baseline Newly available by the end of ${normalized}.`
        : normalized === "widely"
          ? "A moving target containing features that have been interoperable across the core browser set for at least 30 months."
          : "A moving target containing features currently interoperable across the core browser set.",
      browserVersions: browserVersionsForTarget(normalized),
      featureCount: featuresForTarget(normalized).length,
    };
  }

  function listTargets() {
    const years = Array.from(
      { length: data.currentYear - data.firstBaselineYear + 1 },
      (_, index) => data.firstBaselineYear + index,
    );
    return [describeTarget("widely"), describeTarget("newly"), ...years.map(describeTarget)];
  }

  /**
   * @param {unknown} query
   * @param {{ limit?: number }} [options]
   */
  function searchFeatures(query, options = {}) {
    const normalizedQuery = String(query ?? "")
      .trim()
      .toLowerCase();
    const requestedLimit = options.limit;
    const limit =
      Number.isInteger(requestedLimit) && Number(requestedLimit) > 0 ? Number(requestedLimit) : 20;

    return data.features
      .filter((feature) => {
        if (!normalizedQuery) {
          return true;
        }

        return [feature.id, feature.name, feature.description, ...feature.groups]
          .join(" ")
          .toLowerCase()
          .includes(normalizedQuery);
      })
      .slice(0, limit);
  }

  /** @param {string[]} featureIds */
  function recommendTarget(featureIds) {
    if (!Array.isArray(featureIds) || featureIds.length === 0) {
      throw new Error("Select at least one Baseline feature.");
    }

    const selected = [...new Set(featureIds)].map((id) => {
      const feature = featuresById.get(id);
      if (!feature) {
        throw new Error(`Unknown Baseline feature: ${id}.`);
      }
      return feature;
    });
    const limitedFeatures = selected.filter(({ availability }) => availability === "limited");

    if (limitedFeatures.length > 0) {
      return {
        recommendedTarget: null,
        compatibleWithNewly: false,
        compatibleWithWidely: false,
        limitingFeatures: limitedFeatures,
        limitedFeatures,
        browserVersions: null,
        integrationOptions: null,
      };
    }

    const latestYear = Math.max(
      data.firstBaselineYear,
      ...selected.map(({ baselineLowDate }) =>
        baselineLowDate ? Number(baselineLowDate.slice(0, 4)) : data.currentYear,
      ),
    );
    const limitingFeatures = selected.filter(
      ({ baselineLowDate }) =>
        (baselineLowDate ? Number(baselineLowDate.slice(0, 4)) : data.currentYear) === latestYear,
    );

    return {
      recommendedTarget: latestYear,
      compatibleWithNewly: true,
      compatibleWithWidely: selected.every(({ availability }) => availability === "widely"),
      limitingFeatures,
      limitedFeatures: [],
      browserVersions: browserVersionsForTarget(latestYear),
      integrationOptions: {
        "stylelint-baseline": {
          available: latestYear,
          severity: "warning",
        },
      },
    };
  }

  return {
    metadata: {
      generatedAt: data.generatedAt,
      sources: data.sources,
      featureCount: data.features.length,
      firstBaselineYear: data.firstBaselineYear,
      currentYear: data.currentYear,
    },
    listTargets,
    describeTarget,
    searchFeatures,
    recommendTarget,
  };
}

/**
 * @param {unknown} target
 * @param {string} [severity]
 */
export function stylelintBaselineRule(target, severity = "warning") {
  const available = normalizeBaselineTarget(target);
  if (severity !== "warning" && severity !== "error") {
    throw new Error("Stylelint Baseline severity must be warning or error.");
  }

  return [true, { available, severity }];
}

/**
 * @param {unknown} target
 * @param {string} [severity]
 */
export function baselineConfiguration(target, severity = "warning") {
  const rule = stylelintBaselineRule(target, severity);
  return {
    stylelintRule: { "plugin/use-baseline": rule },
    stylelintConfig: {
      plugins: ["stylelint-plugin-use-baseline"],
      rules: { "plugin/use-baseline": rule },
    },
    calaveraRecipe: {
      integrations: ["stylelint", "stylelint-standard", "stylelint-baseline"],
      integrationOptions: {
        "stylelint-baseline": rule[1],
      },
    },
  };
}

const defaultEngine = createBaselineEngine();

export const baselineMetadata = defaultEngine.metadata;
export const listBaselineTargets = defaultEngine.listTargets;
export const describeBaselineTarget = defaultEngine.describeTarget;
export const searchBaselineFeatures = defaultEngine.searchFeatures;
export const recommendBaselineTarget = defaultEngine.recommendTarget;
