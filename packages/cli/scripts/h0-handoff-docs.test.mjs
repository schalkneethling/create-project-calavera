// Issue #750: the sequencing map and STATUS.md must agree with the tracker and
// the readiness record once handoff H0 is delivered. These checks cover only
// facts that stay true after H0 (the H0 row, the ADR-0010 and #442 status, the
// audit count against the audit table), so they fail if a stale statement
// returns. They do not check content that each session or increment rewrites,
// such as Section 0 or STATUS.md's date and next steps.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const mapPath = join(repoRoot, "docs", "cross-repo", "sequencing-map.md");
const statusPath = join(repoRoot, "STATUS.md");
const auditPath = join(repoRoot, "docs", "catalog-audit.md");

const map = await readFile(mapPath, "utf8");
const status = await readFile(statusPath, "utf8");
const audit = await readFile(auditPath, "utf8");

const classifications = new Set(["keep", "delegate", "remove", "watch"]);

/**
 * Counts the rows of the audit table (Section 3) and the rows whose
 * Classification column holds one of the four classifications.
 *
 * @returns {{ rows: number, classified: number }}
 */
function auditTableCounts() {
  const lines = audit.split("\n");
  const header = lines.findIndex(
    (line) => line.startsWith("| Entry ") && line.includes("Classification"),
  );
  assert.notEqual(header, -1, "the audit table header exists");
  const column =
    header === -1
      ? -1
      : lines[header].split("|").findIndex((cell) => cell.trim() === "Classification");
  let rows = 0;
  let classified = 0;
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith("|")) break;
    rows += 1;
    if (classifications.has(line.split("|")[column].trim())) classified += 1;
  }
  return { rows, classified };
}

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
    assert.doesNotMatch(
      line,
      /\(proposed\)|ADR-0010[^.]*\bis proposed\b/i,
      `stale status: ${line}`,
    );
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
    assert.doesNotMatch(
      line,
      /pending/i,
      `#442 is closed, so the line must not call it pending: ${line}`,
    );
  }
});

test("the status line carries a Revised date below the Draft 1 date", () => {
  const lines = map.split("\n");
  const draft = lines.findIndex((line) => line.includes("Draft 1, 9 September 2026"));
  assert.notEqual(draft, -1);
  const revised = lines.findIndex((line) => /^\*\*Revised:\*\* .*\d{4}/.test(line));
  assert.ok(revised > draft, "a Revised line follows the Draft 1 line");
});

test("STATUS.md names H0 as delivered with its version and date", () => {
  assert.match(status, /^- H0: delivered 6\.1\.0 2026-11-07/m);
});

test("the audit line carries one count, and it matches the audit table", () => {
  const auditLine = section(status, "## Audit", /\n## /);
  const counts = auditLine.match(/classified: (\d+) of (\d+)/g);
  assert.equal(counts?.length, 1, "one 'classified: N of M' count");
  const [, classified, rows] = auditLine.match(/classified: (\d+) of (\d+)/);
  assert.deepEqual(
    { rows: Number(rows), classified: Number(classified) },
    auditTableCounts(),
    "STATUS.md counts the rows the table classifies",
  );
});

test("the timeline marks step 1, which delivered H0, as complete", () => {
  const timeline = section(map, "## 2. Timeline", /\n## 3\. /);
  assert.match(timeline, /Step 1 is complete: Increment 1 delivered H0 on 7 November 2026/);
});
