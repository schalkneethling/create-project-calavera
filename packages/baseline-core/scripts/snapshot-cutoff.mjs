const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PACKAGE_NAME = "@schalkneethling/calavera-baseline-core";

function isCalendarDate(value) {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function latestReleaseDate(events) {
  return (
    events
      .flatMap(({ browsers }) => browsers.map(({ release_date: releaseDate }) => releaseDate))
      .filter((releaseDate) => DATE_PATTERN.test(releaseDate ?? "") && isCalendarDate(releaseDate))
      .sort()
      .at(-1) ?? null
  );
}

export function validateCutoff(value, { today, latestReleaseDate: latest }) {
  if (!DATE_PATTERN.test(value)) {
    throw new Error(`Cutoff ${value} is not a YYYY-MM-DD date.`);
  }

  if (!isCalendarDate(value)) {
    throw new Error(`Cutoff ${value} is not a calendar date.`);
  }

  if (value > today) {
    throw new Error(`Cutoff ${value} is after today ${today}.`);
  }

  if (value < latest) {
    throw new Error(`Cutoff ${value} is older than the latest browser release ${latest}.`);
  }
}

export function staleCutoffMessages({ cutoff, latestReleaseDate: latest, sourceVersion }) {
  const cause = `Baseline snapshot cutoff ${cutoff} in scripts/snapshot.mjs is older than the latest browser release ${latest} in baseline-browser-mapping ${sourceVersion}.`;

  return {
    check: `${cause} Run pnpm build:data in packages/baseline-core and confirm a new cutoff.`,
    generate: `${cause} Re-run with --cutoff YYYY-MM-DD (not before ${latest}, not after today), or run from a terminal to be prompted.`,
  };
}

export function renderSnapshotModule(date) {
  return `export const BASELINE_SNAPSHOT_DATE = "${date}";\nexport const BASELINE_SNAPSHOT_YEAR = Number(BASELINE_SNAPSHOT_DATE.slice(0, 4));\n`;
}

function describeChange(label, previous, next) {
  return previous === next ? `${label} ${next}` : `${label} ${next} (previously ${previous})`;
}

export function renderChangeset({ previous, next }) {
  const sources = [
    describeChange("web-features", previous.sources.webFeatures, next.sources.webFeatures),
    describeChange(
      "baseline-browser-mapping",
      previous.sources.baselineBrowserMapping,
      next.sources.baselineBrowserMapping,
    ),
  ].join(" and ");
  const cutoff = describeChange(
    "snapshot cutoff",
    previous.generatedAt.slice(0, 10),
    next.generatedAt.slice(0, 10),
  );
  const floorChanges = Object.entries(next.browserTargets.widely)
    .filter(
      ([browser, { version }]) => previous.browserTargets.widely[browser]?.version !== version,
    )
    .map(
      ([browser, { version }]) =>
        `${browser} ${previous.browserTargets.widely[browser]?.version ?? "none"} to ${version}`,
    );
  const floor =
    floorChanges.length > 0
      ? ` Widely available floor: ${floorChanges.join(", ")}.`
      : " The widely available floor is unchanged.";

  return `---\n"${PACKAGE_NAME}": patch\n---\n\nRefresh Baseline data from ${sources} at ${cutoff}.${floor}\n`;
}

export function parseArguments(argv) {
  const options = { check: false, changeset: false, cutoff: null };

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];

    if (argument === "--check") {
      options.check = true;
    } else if (argument === "--changeset") {
      options.changeset = true;
    } else if (argument === "--cutoff") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new Error("--cutoff requires a YYYY-MM-DD value.");
      }
      options.cutoff = value;
      index += 1;
    } else {
      throw new Error(
        `Unknown argument ${argument}. Expected --check, --cutoff YYYY-MM-DD, or --changeset.`,
      );
    }
  }

  return options;
}
