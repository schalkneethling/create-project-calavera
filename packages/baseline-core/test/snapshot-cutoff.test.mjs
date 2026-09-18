import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { getTimeline } from "baseline-browser-mapping";

import baselineData from "../data/baseline.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import { BASELINE_SNAPSHOT_DATE } from "../scripts/snapshot.mjs";
import {
  latestReleaseDate,
  parseArguments,
  renderChangeset,
  renderSnapshotModule,
  staleCutoffMessages,
  validateCutoff,
} from "../scripts/snapshot-cutoff.mjs";

const buildScript = fileURLToPath(new URL("../scripts/build-data.mjs", import.meta.url));
const dataPath = fileURLToPath(new URL("../data/baseline.json", import.meta.url));
const snapshotPath = fileURLToPath(new URL("../scripts/snapshot.mjs", import.meta.url));

function runBuildData(...args) {
  return spawnSync(process.execPath, [buildScript, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

test("the pinned browser mapping never emits a release later than the snapshot cutoff", () => {
  const latest = latestReleaseDate(getTimeline());
  const emitted = [
    baselineData.browserTargets.widely,
    baselineData.browserTargets.newly,
    ...Object.values(baselineData.browserTargets.years),
  ]
    .flatMap((target) => Object.values(target).map(({ releaseDate }) => releaseDate))
    .filter(Boolean)
    .sort()
    .at(-1);

  assert.match(latest, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(emitted <= latest, `${emitted} emitted after the timeline maximum ${latest}`);
  assert.ok(latest <= BASELINE_SNAPSHOT_DATE, `${latest} is later than the cutoff`);
});

test("latest release date ignores empty and unknown release dates", () => {
  assert.equal(
    latestReleaseDate([
      {
        date: "2026-01-01",
        browsers: [{ browser: "safari", version: "27", release_date: "unknown" }],
      },
      { date: "2025-01-01", browsers: [{ browser: "chrome", version: "1", release_date: "" }] },
      {
        date: "2024-01-01",
        browsers: [{ browser: "firefox", version: "1", release_date: "2024-01-09" }],
      },
      {
        date: "2023-01-01",
        browsers: [{ browser: "edge", version: "1", release_date: "2024-01-08" }],
      },
    ]),
    "2024-01-09",
  );
  assert.equal(latestReleaseDate([]), null);
});

test("latest release date ignores an impossible calendar date that would otherwise sort as the maximum", () => {
  assert.equal(
    latestReleaseDate([
      {
        date: "2026-02-01",
        browsers: [{ browser: "chrome", version: "1", release_date: "2026-02-30" }],
      },
      {
        date: "2024-01-01",
        browsers: [{ browser: "firefox", version: "1", release_date: "2024-01-09" }],
      },
    ]),
    "2024-01-09",
  );
});

test("scripts/snapshot.mjs matches the template the generator writes", () => {
  assert.equal(readFileSync(snapshotPath, "utf8"), renderSnapshotModule(BASELINE_SNAPSHOT_DATE));
});

test("cutoff validation rejects each bad value with a distinct reason", () => {
  const context = { today: "2026-09-15", latestReleaseDate: "2026-09-01" };
  const reasons = ["2026/09/15", "2026-02-30", "2026-09-16", "2026-08-31"].map((value) => {
    try {
      validateCutoff(value, context);
      return null;
    } catch (error) {
      return error.message;
    }
  });

  assert.ok(reasons.every(Boolean), "every bad value is rejected");
  assert.equal(new Set(reasons).size, reasons.length, "reasons are distinct");
  assert.match(reasons[0], /YYYY-MM-DD/);
  assert.match(reasons[1], /calendar date/);
  assert.match(reasons[2], /after today 2026-09-15/);
  assert.match(reasons[3], /latest browser release 2026-09-01/);
  assert.doesNotThrow(() => validateCutoff("2026-09-01", context));
  assert.doesNotThrow(() => validateCutoff("2026-09-15", context));
});

test("stale cutoff messages name the cutoff, the latest release, and the source, and differ by mode", () => {
  const messages = staleCutoffMessages({
    cutoff: "2026-07-25",
    latestReleaseDate: "2026-09-01",
    sourceVersion: "2.11.23",
  });
  const staleData = "Generated Baseline data is stale.";

  for (const message of [messages.check, messages.generate]) {
    assert.match(message, /2026-07-25/);
    assert.match(message, /2026-09-01/);
    assert.match(message, /2\.11\.23/);
  }
  assert.match(messages.generate, /--cutoff YYYY-MM-DD/);
  assert.equal(new Set([messages.check, messages.generate, staleData]).size, 3);
});

test("argument parsing recognizes the three flags and rejects the rest", () => {
  assert.deepEqual(parseArguments([]), { check: false, changeset: false, cutoff: null });
  assert.deepEqual(parseArguments(["--check"]), { check: true, changeset: false, cutoff: null });
  assert.deepEqual(parseArguments(["--cutoff", "2026-09-15", "--changeset"]), {
    check: false,
    changeset: true,
    cutoff: "2026-09-15",
  });
  assert.throws(() => parseArguments(["--cutoff"]), /--cutoff requires a YYYY-MM-DD value/);
  assert.throws(() => parseArguments(["--force"]), /Unknown argument --force/);
});

test("changeset text is a patch naming the sources, the cutoff, and the widely floor changes", () => {
  const text = renderChangeset({
    previous: {
      generatedAt: "2026-07-25T00:00:00.000Z",
      sources: { webFeatures: "3.37.0", baselineBrowserMapping: "2.11.9" },
      browserTargets: { widely: { firefox: { version: "122" }, safari: { version: "17.2" } } },
    },
    next: {
      generatedAt: "2026-09-15T00:00:00.000Z",
      sources: { webFeatures: "3.37.0", baselineBrowserMapping: "2.11.23" },
      browserTargets: { widely: { firefox: { version: "123" }, safari: { version: "17.2" } } },
    },
  });

  assert.ok(text.startsWith('---\n"@schalkneethling/calavera-baseline-core": patch\n---\n\n'));
  assert.match(text, /web-features 3\.37\.0/);
  assert.match(text, /baseline-browser-mapping 2\.11\.23 \(previously 2\.11\.9\)/);
  assert.match(text, /cutoff 2026-09-15 \(previously 2026-07-25\)/);
  assert.match(text, /firefox 122 to 123/);
  assert.doesNotMatch(text, /safari/);
  assert.ok(text.endsWith("\n"));
});

test("generated data records the source versions pinned in package.json", () => {
  assert.deepEqual(baselineData.sources, {
    webFeatures: packageJson.dependencies["web-features"],
    baselineBrowserMapping: packageJson.dependencies["baseline-browser-mapping"],
  });
});

test("an invalid --cutoff fails before any file is written", () => {
  const dataBefore = readFileSync(dataPath, "utf8");
  const snapshotBefore = readFileSync(snapshotPath, "utf8");

  const tooEarly = runBuildData("--cutoff", "2020-01-01");
  assert.notEqual(tooEarly.status, 0);
  assert.match(tooEarly.stderr, /2020-01-01 is older than the latest browser release/);

  const malformed = runBuildData("--cutoff", "not-a-date");
  assert.notEqual(malformed.status, 0);
  assert.match(malformed.stderr, /not-a-date is not a YYYY-MM-DD date/);

  assert.equal(readFileSync(dataPath, "utf8"), dataBefore);
  assert.equal(readFileSync(snapshotPath, "utf8"), snapshotBefore);
});

test("--check never prompts when stdin is not a terminal", () => {
  const result = runBuildData("--check");
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
