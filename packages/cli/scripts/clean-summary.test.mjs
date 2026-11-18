// @ts-check
// #331: the human-readable summary of `clean --dry-run` and `clean` names each file, artifact, and
// wiring file once, under a heading, with dry-run and completed wording, and passes the #918
// rehearsal's listing check. The `--json` result keeps its shape and its `message`.
import assert from "node:assert/strict";
import test from "node:test";

import { listingViolations, namedItems } from "../../../scripts/rehearsal-checks.mjs";
import { cleanHeadline, cleanSummaryLines } from "../src/clean-summary.js";

const guard = "protected-branch-guard";
const skillDirectory = ".agents/skills/protected-branch-guard";
const localEditsReason =
  "Managed file has local edits (installed=aaa, state=bbb). Clean keeps your version. To have clean remove it, restore the content Calavera wrote, or delete it yourself.";
const stillMentionedReason = `.vite-hooks/post-merge still mentions .agents/skills/old-skill after clean, so deleting it would break what runs there. Remove those lines or groups, then run clean again.`;

/**
 * A clean result with every kind of item: wiring in two hook files and in one settings file with
 * two groups, a removed managed file, a removed artifact, and a kept file and artifact.
 *
 * @param {boolean} dryRun
 * @returns {import("../src/index.js").CleanResult}
 */
function fullResult(dryRun) {
  return {
    command: "clean",
    dryRun,
    changes: [
      { type: "update", path: ".vite-hooks/pre-commit", action: "update", ownership: "project" },
      { type: "update", path: ".vite-hooks/pre-push", action: "update", ownership: "project" },
      { type: "update", path: ".claude/settings.json", action: "update", ownership: "project" },
      { type: "delete", path: ".editorconfig" },
      { type: "skip", path: "knip.json", reason: localEditsReason, skipReasons: ["local-edits"] },
      {
        type: "delete",
        path: skillDirectory,
        category: "ai",
        aiType: "skill",
        name: guard,
      },
      {
        type: "skip",
        path: ".agents/skills/old-skill",
        category: "ai",
        aiType: "skill",
        name: "old-skill",
        reason: stillMentionedReason,
        skipReasons: ["still-mentioned"],
      },
    ],
    wiringChanges: [
      {
        artifact: guard,
        path: ".vite-hooks/pre-commit",
        kind: "vite-hook",
        type: "update",
        removedBlock: "sh .agents/skills/protected-branch-guard/scripts/guard.sh pre-commit",
        deselected: true,
      },
      {
        artifact: guard,
        path: ".vite-hooks/pre-push",
        kind: "vite-hook",
        type: "update",
        removedBlock: "sh .agents/skills/protected-branch-guard/scripts/guard.sh pre-push",
        deselected: true,
      },
      {
        artifact: guard,
        path: ".claude/settings.json",
        kind: "claude-settings",
        type: "update",
        groupChanges: [
          { event: "SessionStart", action: "remove", previous: { hooks: [] } },
          { event: "PreToolUse", action: "remove", previous: { matcher: "Bash", hooks: [] } },
        ],
        reformatted: true,
        deselected: true,
      },
    ],
    message: "not printed when there are changes",
  };
}

/** @param {import("../src/clean-summary.js").SummaryLine[]} lines */
function text(lines) {
  return lines.map(({ text: line }) => line).join("\n");
}

test("a clean dry run lists each wiring file, file, and artifact once, under headings, with planned wording", () => {
  const output = text(cleanSummaryLines(fullResult(true), true));

  assert.equal(
    output,
    [
      "Dry run complete. No files were removed.",
      "",
      "Wiring:",
      "  Would update .vite-hooks/pre-commit",
      `    Would remove the ${guard} block, because the recipe no longer selects ${guard}: "sh .agents/skills/protected-branch-guard/scripts/guard.sh pre-commit"`,
      "  Would update .vite-hooks/pre-push",
      `    Would remove the ${guard} block, because the recipe no longer selects ${guard}: "sh .agents/skills/protected-branch-guard/scripts/guard.sh pre-push"`,
      "  Would update .claude/settings.json",
      `    Would remove the SessionStart group for ${guard}, because the recipe no longer selects ${guard}: {"hooks":[]}`,
      `    Would remove the PreToolUse group for ${guard}, because the recipe no longer selects ${guard}: {"matcher":"Bash","hooks":[]}`,
      "    Would also change the layout of the rest of the file, because Calavera writes the whole file in the project's format; no value outside the groups changes",
      "",
      "Files:",
      "  Would remove .editorconfig",
      `  Would skip knip.json: ${localEditsReason}`,
      "",
      "Artifacts:",
      `  Would remove ${skillDirectory}`,
      "  Would skip .agents/skills/old-skill: .vite-hooks/post-merge still mentions this item after clean, so deleting it would break what runs there. Remove those lines or groups, then run clean again.",
    ].join("\n"),
  );
});

test("a completed clean uses past-tense wording for each item", () => {
  const output = text(cleanSummaryLines(fullResult(false), false));

  assert.match(
    output,
    /^Removed stale managed files and the wiring of artifacts the recipe no longer selects\.$/m,
  );
  assert.match(output, /^ {2}Updated \.claude\/settings\.json$/m);
  assert.match(output, new RegExp(`^ {4}Removed the ${guard} block, because`, "m"));
  assert.match(output, new RegExp(`^ {4}Removed the PreToolUse group for ${guard}, because`, "m"));
  assert.match(output, /^ {4}Also changed the layout of the rest of the file, because/m);
  assert.match(output, /^ {2}Removed \.editorconfig$/m);
  assert.match(output, /^ {2}Skipped knip\.json: Managed file has local edits/m);
  assert.match(output, new RegExp(`^ {2}Removed ${skillDirectory.replaceAll(".", "\\.")}$`, "m"));
  assert.doesNotMatch(output, /Would /);
});

test("the clean summary passes the #918 rehearsal's listing check, in a dry run and after clean", () => {
  for (const dryRun of [true, false]) {
    const result = fullResult(dryRun);
    assert.deepEqual(
      listingViolations(text(cleanSummaryLines(result, dryRun)), namedItems(result)),
      [],
    );
  }
});

test("a clean that keeps every stale item names each kept item once, not again in a summary sentence", () => {
  /** @type {import("../src/index.js").CleanResult} */
  const result = {
    command: "clean",
    wiringChanges: [],
    changes: [
      { type: "skip", path: "knip.json", reason: localEditsReason, skipReasons: ["local-edits"] },
    ],
    message: `No stale managed items were safe to remove. Kept knip.json, because it has local edits. Clean keeps your version. To have clean remove an item, restore the content Calavera wrote, or delete the item yourself.`,
  };

  assert.equal(
    text(cleanSummaryLines(result, true)),
    [
      "No stale managed items were safe to remove.",
      "",
      "Files:",
      `  Would skip knip.json: ${localEditsReason}`,
    ].join("\n"),
  );
  assert.deepEqual(
    listingViolations(text(cleanSummaryLines(result, true)), namedItems(result)),
    [],
  );
});

test("a clean with nothing to list prints its message alone", () => {
  for (const message of [
    "No Calavera state found. Nothing to clean.",
    "No stale managed files found.",
    "Clean cancelled.",
  ]) {
    assert.deepEqual(
      cleanSummaryLines({ command: "clean", changes: [], wiringChanges: [], message }, false),
      [{ level: "info", text: message }],
    );
  }
});

test("the clean headline names what clean removed, and is the start of the JSON message", () => {
  assert.equal(
    cleanHeadline({ dryRun: true, removed: 0, wiringFiles: 0, kept: 0 }),
    "No stale managed files found.",
  );
  assert.equal(
    cleanHeadline({ dryRun: false, removed: 0, wiringFiles: 0, kept: 1 }),
    "No stale managed items were safe to remove.",
  );
  assert.equal(
    cleanHeadline({ dryRun: true, removed: 1, wiringFiles: 1, kept: 0 }),
    "Dry run complete. No files were removed.",
  );
  assert.equal(
    cleanHeadline({ dryRun: false, removed: 0, wiringFiles: 1, kept: 0 }),
    "Removed the wiring of artifacts the recipe no longer selects.",
  );
  assert.equal(
    cleanHeadline({ dryRun: false, removed: 2, wiringFiles: 0, kept: 0 }),
    "Removed stale managed files.",
  );
  assert.equal(
    cleanHeadline({ dryRun: false, removed: 1, wiringFiles: 1, kept: 0 }),
    "Removed stale managed files and the wiring of artifacts the recipe no longer selects.",
  );
});

test("a kept item's reason names a longer path that starts with the item's path, but not the item's own path again", () => {
  const path = ".agents/skills/guard";
  /** @type {import("../src/index.js").CleanResult} */
  const result = {
    command: "clean",
    wiringChanges: [],
    changes: [
      {
        type: "skip",
        path,
        category: "ai",
        reason: `.vite-hooks/pre-commit runs ${path}/scripts/run.sh and ${path}-extra, and mentions ${path}. Fix ${path}.`,
        skipReasons: ["still-mentioned"],
      },
    ],
    message: "unused",
  };

  assert.equal(
    cleanSummaryLines(result, true).at(-1)?.text,
    `  Would skip ${path}: .vite-hooks/pre-commit runs ${path}/scripts/run.sh and ${path}-extra, and mentions this item. Fix this item.`,
  );
});

test("a kept item's reason that starts with the item's path, and a settings file whose layout does not change, are listed without repeating the path", () => {
  const path = ".agents/skills/guard";
  /** @type {import("../src/index.js").CleanResult} */
  const result = {
    command: "clean",
    wiringChanges: [
      {
        artifact: "guard",
        path: ".claude/settings.json",
        kind: "claude-settings",
        type: "update",
        groupChanges: [{ event: "Stop", action: "remove", previous: { hooks: [] } }],
        reformatted: false,
        deselected: true,
      },
    ],
    changes: [
      { type: "update", path: ".claude/settings.json", action: "update", ownership: "project" },
      {
        type: "skip",
        path,
        category: "ai",
        reason: `${path} is still mentioned.`,
        skipReasons: ["still-mentioned"],
      },
    ],
    message: "unused",
  };

  assert.deepEqual(
    cleanSummaryLines(result, false).map(({ text: line }) => line),
    [
      "Removed the wiring of artifacts the recipe no longer selects.",
      "",
      "Wiring:",
      "  Updated .claude/settings.json",
      '    Removed the Stop group for guard, because the recipe no longer selects guard: {"hooks":[]}',
      "",
      "Artifacts:",
      `  Skipped ${path}: this item is still mentioned.`,
    ],
  );
});

test("a skip reason keeps the name of a wiring file it refers to, so the person knows which file to change", () => {
  const path = ".agents/skills/guard";
  /** @type {import("../src/index.js").CleanResult} */
  const result = {
    command: "clean",
    dryRun: true,
    wiringChanges: [
      {
        artifact: "guard",
        path: ".vite-hooks/pre-commit",
        kind: "vite-hook",
        type: "update",
        removedBlock: "sh run.sh",
        deselected: true,
      },
    ],
    changes: [
      { type: "update", path: ".vite-hooks/pre-commit", action: "update", ownership: "project" },
      {
        type: "skip",
        path,
        category: "ai",
        reason: `Calavera cannot read .vite-hooks/pre-commit (EACCES), so it cannot tell whether it runs ${path}. Make that file readable, then run clean again.`,
        skipReasons: ["unreadable"],
      },
    ],
    message: "unused",
  };

  assert.equal(
    cleanSummaryLines(result, true).at(-1)?.text,
    `  Would skip ${path}: Calavera cannot read .vite-hooks/pre-commit (EACCES), so it cannot tell whether it runs this item. Make that file readable, then run clean again.`,
  );
});
