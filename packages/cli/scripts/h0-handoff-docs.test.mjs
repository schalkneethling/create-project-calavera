// Issue #750: the sequencing map and STATUS.md must agree with the tracker and
// the readiness record once handoff H0 is delivered. These checks cover the
// statements that went stale in Increment 1, so they fail if one returns.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mapPath = join(repoRoot, "docs", "cross-repo", "sequencing-map.md");
const statusPath = join(repoRoot, "STATUS.md");

const map = await readFile(mapPath, "utf8");
const status = await readFile(statusPath, "utf8");

/**
 * @param {string} text
 * @param {string} heading
 * @param {RegExp} nextHeading
 */
function section(text, heading, nextHeading) {
  const start = text.indexOf(heading);
  assert.notEqual(start, -1, `missing heading: ${heading}`);
  const rest = text.slice(start + heading.length);
  const end = rest.search(nextHeading);
  return end === -1 ? rest : rest.slice(0, end);
}

const mergedPullRequests = [803, 828, 831, 832, 825, 815, 817];

test("the H0 row reads delivered with the CLI version and date, and links the readiness record", () => {
  const row = map.split("\n").find((line) => line.startsWith("| H0 "));
  assert.ok(row, "the H0 row exists");
  assert.match(row, /delivered 6\.1\.0 2026-11-07/);
  const link = row.match(/\]\((\.\.\/bootstrap-readiness-record\.md)\)/);
  assert.ok(link, "the H0 row links the readiness record");
  assert.ok(existsSync(join(dirname(mapPath), link[1])), "the linked record exists");
});

test("the map describes ADR-0010 as accepted with the amendment proposed on 2026-10-21 under #688", () => {
  const lines = map.split("\n").filter((line) => line.includes("0010"));
  assert.ok(lines.length > 0, "the map mentions ADR-0010");
  for (const line of lines) {
    assert.doesNotMatch(line, /\(proposed\)/i, `stale status: ${line}`);
  }
  assert.ok(
    lines.some(
      (line) => /accepted/i.test(line) && line.includes("2026-10-21") && line.includes("#688"),
    ),
    "one line states accepted, 2026-10-21, and #688",
  );
});

test("the map does not describe #442 as pending", () => {
  for (const line of map.split("\n").filter((entry) => entry.includes("#442"))) {
    assert.match(line, /closed/i, `#442 is closed, so the line must say so: ${line}`);
  }
});

test("the status line carries a Revised date below the Draft 1 date", () => {
  const lines = map.split("\n");
  const draft = lines.findIndex((line) => line.includes("Draft 1, 9 September 2026"));
  assert.notEqual(draft, -1);
  const revised = lines.findIndex((line) => /^\*\*Revised:\*\* .*\d{4}/.test(line));
  assert.ok(revised > draft, "a Revised line follows the Draft 1 line");
});

test("Section 0 is a skeleton with the four placeholders", () => {
  const section0 = section(map, "## 0. Current Increment", /\n## 1\. /);
  for (const heading of ["Goal", "Exit condition", "Issues", "Explicitly not now"]) {
    assert.match(
      section0,
      new RegExp(`\\*\\*${heading}:\\*\\*\\s*\\n?[^\\n]*Owner to decide`),
      heading,
    );
  }
  for (const issue of [733, 734, 735, 736]) {
    assert.match(section0, new RegExp(`#${issue}\\b`), `Section 0 names #${issue}`);
  }
});

test("STATUS.md names H0 as delivered with a date and is dated after the last session", () => {
  assert.match(status, /^- H0: delivered 6\.1\.0 2026-11-07/m);
  assert.match(status, /^Updated: 2026-11-07$/m);
});

test("the audit line carries one count", () => {
  const audit = section(status, "## Audit", /\n## /);
  assert.equal(audit.match(/classified: \d+ of \d+/g)?.length, 1, "one 'classified: N of M' count");
  assert.doesNotMatch(audit, /fourteen|\b14\b/, "no second row or entry count");
});

test("STATUS.md lists no merged pull request as open", () => {
  for (const number of mergedPullRequests) {
    for (const line of status.split("\n").filter((entry) => entry.includes(`#${number}`))) {
      assert.doesNotMatch(line, /\bopen\b|waits for review/i, `#${number} is merged: ${line}`);
    }
  }
});

test("'Next session starts with' names #673 and #676 as deferred and #669 as delivered", () => {
  const next = section(status, "## Next session starts with", /\n## |$/);
  assert.match(next, /#673/);
  assert.match(next, /#676/);
  const line = next.split("\n").find((entry) => entry.includes("#669"));
  assert.ok(line, "#669 appears");
  assert.match(line, /delivered in 6\.1\.0/);
});

test("STATUS.md links the friction issues from the readiness record", () => {
  for (const issue of [838, 839, 840, 841, 842, 843, 844, 846]) {
    assert.match(status, new RegExp(`#${issue}\\b`), `#${issue}`);
  }
  assert.match(status, /voidzero-dev\/vite-plus#3381/);
});

test("STATUS.md does not propose that Checkpoint 1 passed", () => {
  assert.doesNotMatch(status, /checkpoint 1 (passed|is met|passes)/i);
  assert.match(status, /Checkpoint 1/);
});
