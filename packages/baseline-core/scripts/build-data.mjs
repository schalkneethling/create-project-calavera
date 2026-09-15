import { readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";

import { getCompatibleVersions, getTimeline } from "baseline-browser-mapping";
import { features } from "web-features";

import packageJson from "../package.json" with { type: "json" };
import { isCssSpecificationUrl } from "../src/specification-url.js";
import { BASELINE_SNAPSHOT_DATE } from "./snapshot.mjs";
import {
  latestReleaseDate,
  parseArguments,
  renderChangeset,
  renderSnapshotModule,
  staleCutoffMessages,
  validateCutoff,
} from "./snapshot-cutoff.mjs";

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
const PACKAGE_NAME = packageJson.name;
const CHANGESET_NAME = "baseline-data-refresh.md";

const outputUrl = new URL("../data/baseline.json", import.meta.url);
const snapshotUrl = new URL("./snapshot.mjs", import.meta.url);
const changesetUrl = new URL(`../../../.changeset/${CHANGESET_NAME}`, import.meta.url);

const options = parseArguments(process.argv.slice(2));
const sources = {
  webFeatures: packageJson.dependencies["web-features"],
  baselineBrowserMapping: packageJson.dependencies["baseline-browser-mapping"],
};
const latestRelease = latestReleaseDate(getTimeline());
const staleMessages = staleCutoffMessages({
  cutoff: BASELINE_SNAPSHOT_DATE,
  latestReleaseDate: latestRelease,
  sourceVersion: sources.baselineBrowserMapping,
});
const cutoffIsStale = BASELINE_SNAPSHOT_DATE < latestRelease;

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

function buildDataset(cutoff) {
  const year = Number(cutoff.slice(0, 4));
  const years = Object.fromEntries(
    Array.from({ length: year - FIRST_BASELINE_YEAR + 1 }, (_, index) => {
      const targetYear = FIRST_BASELINE_YEAR + index;
      return [targetYear, browserVersions({ targetYear })];
    }),
  );

  return {
    schemaVersion: 1,
    generatedAt: `${cutoff}T00:00:00.000Z`,
    sources,
    firstBaselineYear: FIRST_BASELINE_YEAR,
    currentYear: year,
    browserTargets: {
      widely: browserVersions({ widelyAvailableOnDate: cutoff }),
      newly: browserVersions({ targetYear: year }),
      years,
    },
    features: cssFeatures,
  };
}

function serialize(dataset) {
  return `${JSON.stringify(dataset)}\n`;
}

let prompt = null;

async function ask(question) {
  prompt ??= createInterface({ input: process.stdin, output: process.stdout });
  return (await prompt.question(question)).trim();
}

async function promptForCutoff(context) {
  console.info(staleMessages.check.split(" Run ")[0]);

  for (;;) {
    const answer = (await ask(`New cutoff [${context.today}]: `)) || context.today;

    try {
      validateCutoff(answer, context);
      return answer;
    } catch (error) {
      console.error(error.message);
    }
  }
}

async function resolveCutoff() {
  const today = new Date().toISOString().slice(0, 10);
  const context = { today, latestReleaseDate: latestRelease };

  if (options.cutoff) {
    validateCutoff(options.cutoff, context);
    return options.cutoff;
  }

  if (!cutoffIsStale) {
    return BASELINE_SNAPSHOT_DATE;
  }

  if (!process.stdin.isTTY) {
    throw new Error(staleMessages.generate);
  }

  return promptForCutoff(context);
}

function refreshSummary(previous, next) {
  const lines = [
    `Sources: web-features ${next.sources.webFeatures}, baseline-browser-mapping ${next.sources.baselineBrowserMapping}`,
    `Snapshot cutoff: ${next.generatedAt.slice(0, 10)} (previously ${previous?.generatedAt.slice(0, 10) ?? "none"})`,
    `Features: ${next.features.length} (previously ${previous?.features.length ?? "none"})`,
  ];

  for (const [browser, { version }] of Object.entries(next.browserTargets.widely)) {
    const before = previous?.browserTargets.widely[browser]?.version;
    if (before !== version) {
      lines.push(`Widely available ${browser}: ${before ?? "none"} to ${version}`);
    }
  }

  return lines.join("\n");
}

function refreshChanged(previous, next) {
  return (
    previous === null ||
    JSON.stringify(previous.sources) !== JSON.stringify(next.sources) ||
    previous.generatedAt !== next.generatedAt ||
    JSON.stringify(previous.browserTargets.widely) !== JSON.stringify(next.browserTargets.widely)
  );
}

async function writeChangeset(previous, next) {
  if (!refreshChanged(previous, next)) {
    return;
  }

  const text = renderChangeset({ previous: previous ?? next, next });
  const existing = await readFile(changesetUrl, "utf8").catch(() => null);

  if (existing === text) {
    console.info(`.changeset/${CHANGESET_NAME} is already current.`);
    return;
  }

  let write = options.changeset;

  if (!write && process.stdin.isTTY) {
    const question =
      existing === null
        ? `Write .changeset/${CHANGESET_NAME} (patch for ${PACKAGE_NAME})? [Y/n] `
        : `Overwrite the existing .changeset/${CHANGESET_NAME} (patch for ${PACKAGE_NAME})? [y/N] `;
    const answer = (await ask(question)).toLowerCase();
    write = existing === null ? answer === "" || answer.startsWith("y") : answer.startsWith("y");
  }

  if (write) {
    await writeFile(changesetUrl, text);
    console.info(`Wrote .changeset/${CHANGESET_NAME}.`);
    return;
  }

  console.info(`Next step: add a Changeset for ${PACKAGE_NAME} (patch):\n\n${text}`);
}

async function generate() {
  const cutoff = await resolveCutoff();
  const previous = JSON.parse(await readFile(outputUrl, "utf8").catch(() => "null"));
  const next = buildDataset(cutoff);
  const snapshotModule = renderSnapshotModule(cutoff);

  if ((await readFile(snapshotUrl, "utf8").catch(() => null)) !== snapshotModule) {
    await writeFile(snapshotUrl, snapshotModule);
    console.info(`Wrote scripts/snapshot.mjs with cutoff ${cutoff}.`);
  }

  await writeFile(outputUrl, serialize(next));
  console.info(`Wrote data/baseline.json.\n${refreshSummary(previous, next)}`);
  await writeChangeset(previous, next);
}

if (options.check) {
  if (cutoffIsStale) {
    throw new Error(staleMessages.check);
  }

  const current = await readFile(outputUrl, "utf8");
  if (current !== serialize(buildDataset(BASELINE_SNAPSHOT_DATE))) {
    throw new Error("Generated Baseline data is stale. Run pnpm build:data in baseline-core.");
  }
} else {
  try {
    await generate();
  } finally {
    prompt?.close();
  }
}
