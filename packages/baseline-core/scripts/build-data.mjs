import { readFile, writeFile } from "node:fs/promises";

import { getAllVersions, getCompatibleVersions } from "baseline-browser-mapping";
import { features } from "web-features";

import packageJson from "../package.json" with { type: "json" };
import { isCssSpecificationUrl } from "../src/specification-url.js";

const CURRENT_YEAR = new Date().getUTCFullYear();
const FIRST_BASELINE_YEAR = 2015;
const CORE_BROWSERS = new Set([
  "chrome",
  "chrome_android",
  "edge",
  "firefox",
  "firefox_android",
  "safari",
  "safari_ios",
]);

function isCssFeature(feature) {
  return (
    feature.compat_features?.some((key) => key.startsWith("css.")) ||
    feature.group?.includes("css") ||
    feature.spec?.some(isCssSpecificationUrl)
  );
}

function availability(status) {
  if (status?.baseline === "high") {
    return "widely";
  }

  if (status?.baseline === "low") {
    return "newly";
  }

  return "limited";
}

function support(status) {
  return Object.fromEntries(
    Object.entries(status?.support ?? {}).filter(([browser]) => CORE_BROWSERS.has(browser)),
  );
}

function browserVersions(options) {
  return Object.fromEntries(
    getCompatibleVersions({ ...options, suppressWarnings: true })
      .filter(({ browser }) => CORE_BROWSERS.has(browser))
      .map(({ browser, version, release_date: releaseDate }) => [
        browser,
        { version, ...(releaseDate ? { releaseDate } : {}) },
      ]),
  );
}

const cssFeatures = Object.entries(features)
  .filter(([, feature]) => isCssFeature(feature) && feature.status)
  .map(([id, feature]) => ({
    id,
    name: feature.name,
    description: feature.description,
    groups: feature.group ?? [],
    availability: availability(feature.status),
    baselineLowDate: feature.status.baseline_low_date,
    baselineHighDate: feature.status.baseline_high_date,
    support: support(feature.status),
    stylelintDetectable: feature.compat_features?.some((key) => key.startsWith("css.")) ?? false,
  }))
  .sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id));

const years = Object.fromEntries(
  Array.from({ length: CURRENT_YEAR - FIRST_BASELINE_YEAR + 1 }, (_, index) => {
    const year = FIRST_BASELINE_YEAR + index;
    return [year, browserVersions({ targetYear: year })];
  }),
);
const allVersions = getAllVersions({ suppressWarnings: true });
if (!Array.isArray(allVersions)) {
  throw new Error("Expected Baseline browser mapping to return an array.");
}
const sourceReleaseDate = allVersions
  .flatMap(({ release_date: releaseDate }) =>
    /^\d{4}-\d{2}-\d{2}$/.test(releaseDate ?? "") ? [releaseDate] : [],
  )
  .sort()
  .at(-1);
if (!sourceReleaseDate) {
  throw new Error("Expected Baseline browser mapping to include release dates.");
}

const dataset = {
  schemaVersion: 1,
  generatedAt: `${sourceReleaseDate}T00:00:00.000Z`,
  sources: {
    webFeatures: packageJson.dependencies["web-features"],
    baselineBrowserMapping: packageJson.dependencies["baseline-browser-mapping"],
  },
  firstBaselineYear: FIRST_BASELINE_YEAR,
  currentYear: CURRENT_YEAR,
  browserTargets: {
    widely: browserVersions({}),
    newly: browserVersions({ targetYear: CURRENT_YEAR }),
    years,
  },
  features: cssFeatures,
};

const outputUrl = new URL("../data/baseline.json", import.meta.url);
const output = `${JSON.stringify(dataset)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(outputUrl, "utf8");
  if (current !== output) {
    throw new Error("Generated Baseline data is stale. Run pnpm build:data in baseline-core.");
  }
} else {
  await writeFile(outputUrl, output);
}
