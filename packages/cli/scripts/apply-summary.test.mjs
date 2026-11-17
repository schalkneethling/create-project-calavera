// Issue #617: the human output of `apply --dry-run` and `apply` names each fact once, under
// headings, with blank lines between the groups. Each integration is one line, with the packages it
// installs in parentheses only where their names differ (owner decision of 2026-11-14), and each
// artifact is one line with its version and destination. The tests pin the whole output for a
// Vite+-managed project with integrations, dependencies, inputs, artifacts, and wiring, and run the
// #918 rehearsal's listing check on the output of the recipe the rehearsal applies.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { listingViolations, namedItems } from "../../../scripts/rehearsal-checks.mjs";
import { applySummaryLines } from "../src/apply-summary.js";
import { applyRecipeObject } from "../src/index.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { copyReleaseFixture, writeVitePlusStub } from "./vite-plus-fixtures.mjs";

const LOCK_PATH = ".calavera/artifacts.lock.json";

const applyOptions = {
  json: true,
  assumeYes: true,
  config: "calavera.config.json",
};

/**
 * Runs `callback` in a copy of the vite-plus 1.0.0 library fixture, a Git repository whose vp
 * formats files and records installs instead of running them.
 *
 * @param {(root: string) => Promise<void>} callback
 */
async function inManagedProject(callback) {
  await using fixture = await copyReleaseFixture("library", { vitePlus: false });
  await writeVitePlusStub(fixture.root, { logPath: join(fixture.root, "vp-invocations.log") });
  execFileSync("git", ["init", "--quiet"], { cwd: fixture.root });
  const originalDirectory = process.cwd();
  process.chdir(fixture.root);

  try {
    await callback(fixture.root);
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * The summary as the terminal shows it, with the machine-specific paths replaced.
 *
 * @param {import("../src/index.js").ApplyResult} result
 * @param {string} root
 */
function summary(result, root) {
  return applySummaryLines(result).map(({ text }) =>
    text.replaceAll(process.execPath, "<node>").replaceAll(root, "<project>"),
  );
}

/** @param {string[]} lines */
function printed(lines) {
  return `${lines.join("\n")}\n`;
}

const richRecipe = {
  ...buildRecipe(
    "default",
    [
      "editorconfig",
      "stylelint",
      "stylelint-standard",
      "stylelint-scss",
      "knip",
      "github-repository-controls",
    ],
    "pnpm",
    [],
    { "github-repository-controls": { repository: "example/summary", defaultBranch: "main" } },
  ),
  ai: [
    { id: "skill-protected-branch-guard", inputs: { protectedBranch: "main" } },
    { id: "hook-block-dangerous-commands" },
  ],
};

const richReleases = new Map([
  ["skill-protected-branch-guard", "1.0.0"],
  ["hook-block-dangerous-commands", "0.4.0"],
]);

const guardBlock = (/** @type {string} */ hook) =>
  JSON.stringify(`node .agents/skills/protected-branch-guard/scripts/guard.mjs ${hook} main`);

const guardGroup = (/** @type {string} */ argument, /** @type {string} */ matcher = "") =>
  JSON.stringify({
    ...(matcher ? { matcher } : {}),
    hooks: [
      {
        type: "command",
        command: `node "$CLAUDE_PROJECT_DIR/.agents/skills/protected-branch-guard/scripts/guard.mjs" ${argument} main`,
        timeout: 10,
      },
    ],
  });

const dispatcherWarning =
  "The Vite+ hook dispatcher is not installed in this clone, so Git runs none of the scripts in .vite-hooks, and the hooks skill-protected-branch-guard wires there will not run. Run vp config to install it.";

const notes = [
  "Notes:",
  "  Installed skills are available under .agents/skills/.",
  "  Hook scripts for claude-code are installed under .agents/hooks/claude-code/. Review bundled settings-fragment.json files before wiring them into agent settings.",
  "  Calavera ignores .calavera/cache/ through its artifact-cache block, because the folder is a local npm download cache and does not belong in Git. Commit .calavera/artifacts.lock.json and .calavera/packages/, which hold the exact artifact versions and payloads the project uses.",
];

test("apply --dry-run and apply name each fact once, grouped under headings (#617)", async (t) => {
  await inManagedProject(async (root) => {
    const registry = stubRegistry(richReleases);
    const dryRun = await applyRecipeObject(richRecipe, { ...applyOptions, dryRun: true }, registry);

    await t.test("the dry run", () => {
      assert.deepEqual(summary(dryRun, root), [
        "Calavera apply dry run complete. No files were changed.",
        "",
        "Project:",
        "  Package manager: pnpm",
        "  Vite+ detection: managed. This project is vp-managed (vite-plus-dependency signal at package.json).",
        "  JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera.",
        "",
        "Integrations:",
        "  editorconfig",
        "  knip",
        "  github-repository-controls",
        "    defaultBranch = main (recorded in the recipe)",
        "  stylelint",
        "  stylelint-standard (stylelint-config-standard)",
        "  stylelint-scss (also stylelint-config-standard-scss)",
        "  Install command: vp add -D knip stylelint stylelint-config-standard stylelint-scss stylelint-config-standard-scss",
        "  Vite+ runs this with the package manager the project pins; apply runs it with: <node> <project>/node_modules/vite-plus/bin/vp",
        "",
        "Files:",
        "  Would update package.json",
        "  Would write and own .editorconfig",
        "  Would write and own .stylelintrc.json",
        "  Would write and own knip.json",
        "  Would write and own .github/repository-controls.json",
        "  Would write and own .github/dependabot.yml",
        "  Would write and own scripts/repository-controls.mjs",
        "  Would write and own docs/repository-controls.md",
        "  Would update .gitignore",
        '    Would add the artifact-cache block: ".calavera/cache/"',
        "  Would write .coderabbit.yaml",
        "",
        "Scripts:",
        '  Would add script lint:styles: "stylelint \\"**/*.{css,scss}\\" --allow-empty-input"',
        '  Would add script lint:styles:fix: "stylelint \\"**/*.{css,scss}\\" --allow-empty-input --fix"',
        '  Would add script knip: "knip"',
        '  Would add script repo:controls:check: "node scripts/repository-controls.mjs"',
        '  Would add script repo:controls:apply: "node scripts/repository-controls.mjs --apply"',
        '  Would add script quality: "vp check && vp test --passWithNoTests && pnpm lint:styles && pnpm knip"',
        "",
        "Artifacts:",
        "  Would lock skill-protected-branch-guard 1.0.0 and write .agents/skills/protected-branch-guard",
        "    protectedBranch = main (recorded in the recipe)",
        `    Would write its block in .vite-hooks/pre-commit: ${guardBlock("commit")}`,
        `    Would write its block in .vite-hooks/prepare-commit-msg: ${guardBlock("commit")}`,
        `    Would write its block in .vite-hooks/pre-push: ${guardBlock("pre-push")}`,
        `    Would add a SessionStart group to .claude/settings.json: ${guardGroup("session-start")}`,
        `    Would add a PreToolUse group to .claude/settings.json: ${guardGroup("claude-pre-tool-use", "Write|Edit|MultiEdit|NotebookEdit")}`,
        "  Would lock hook-block-dangerous-commands 0.4.0 and write:",
        "    .agents/hooks/claude-code/block-dangerous-commands.mjs",
        "    .agents/hooks/claude-code/block-dangerous-commands.settings-fragment.json",
        `  ${dispatcherWarning}`,
        "",
        ...notes,
      ]);
    });

    const applied = await applyRecipeObject(
      dryRun.recipe,
      { ...applyOptions, approvedArtifacts: dryRun.autoInstalledArtifacts },
      registry,
    );

    await t.test("the apply", () => {
      assert.deepEqual(summary(applied, root), [
        "Calavera apply complete.",
        "",
        "Integrations:",
        "  editorconfig",
        "  knip",
        "  github-repository-controls",
        "    defaultBranch = main (recorded in the recipe)",
        "  stylelint",
        "  stylelint-standard (stylelint-config-standard)",
        "  stylelint-scss (also stylelint-config-standard-scss)",
        "  Installed with: vp add -D knip stylelint stylelint-config-standard stylelint-scss stylelint-config-standard-scss",
        "",
        "Files:",
        "  Updated package.json",
        "  Wrote .editorconfig, which Calavera owns",
        "  Wrote .stylelintrc.json, which Calavera owns",
        "  Wrote knip.json, which Calavera owns",
        "  Wrote .github/repository-controls.json, which Calavera owns",
        "  Wrote .github/dependabot.yml, which Calavera owns",
        "  Wrote scripts/repository-controls.mjs, which Calavera owns",
        "  Wrote docs/repository-controls.md, which Calavera owns",
        "  Updated .gitignore",
        '    Added the artifact-cache block: ".calavera/cache/"',
        "  Wrote .coderabbit.yaml",
        "",
        "Scripts:",
        '  Added script lint:styles: "stylelint \\"**/*.{css,scss}\\" --allow-empty-input"',
        '  Added script lint:styles:fix: "stylelint \\"**/*.{css,scss}\\" --allow-empty-input --fix"',
        '  Added script knip: "knip"',
        '  Added script repo:controls:check: "node scripts/repository-controls.mjs"',
        '  Added script repo:controls:apply: "node scripts/repository-controls.mjs --apply"',
        '  Added script quality: "vp check && vp test --passWithNoTests && pnpm lint:styles && pnpm knip"',
        "",
        "Artifacts:",
        "  Locked skill-protected-branch-guard 1.0.0 and wrote .agents/skills/protected-branch-guard",
        "    protectedBranch = main (recorded in the recipe)",
        `    Wrote its block in .vite-hooks/pre-commit: ${guardBlock("commit")}`,
        `    Wrote its block in .vite-hooks/prepare-commit-msg: ${guardBlock("commit")}`,
        `    Wrote its block in .vite-hooks/pre-push: ${guardBlock("pre-push")}`,
        `    Added a SessionStart group to .claude/settings.json: ${guardGroup("session-start")}`,
        `    Added a PreToolUse group to .claude/settings.json: ${guardGroup("claude-pre-tool-use", "Write|Edit|MultiEdit|NotebookEdit")}`,
        "  Locked hook-block-dangerous-commands 0.4.0 and wrote:",
        "    .agents/hooks/claude-code/block-dangerous-commands.mjs",
        "    .agents/hooks/claude-code/block-dangerous-commands.settings-fragment.json",
        `  ${dispatcherWarning}`,
        "",
        ...notes,
      ]);
    });

    await t.test(
      "a second dry run names each unchanged file once and why the install still runs",
      async () => {
        // The vp stub records the install instead of running it, so list the packages as the
        // install would have.
        const manifest = JSON.parse(await readFile("package.json", "utf8"));
        manifest.devDependencies = {
          ...manifest.devDependencies,
          ...Object.fromEntries(applied.dependencies.map((name) => [name, "^1.0.0"])),
        };
        await writeFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);

        const second = await applyRecipeObject(
          dryRun.recipe,
          { ...applyOptions, dryRun: true },
          registry,
        );
        const lines = summary(second, root);
        assert.deepEqual(lines.slice(0, 2), [
          "Calavera apply dry run complete. No files were changed.",
          "Nothing to change: the project already matches this recipe.",
        ]);
        assert.ok(
          lines.includes(
            "  Every package in this command is already a dev dependency of the project; apply still runs the command, which can update their versions and the lockfile.",
          ),
          printed(lines),
        );
        assert.deepEqual(lines.slice(lines.indexOf("Files:"), lines.indexOf("Scripts:")), [
          "Files:",
          "  Unchanged package.json",
          "  Unchanged .editorconfig",
          "  Unchanged .stylelintrc.json",
          "  Unchanged knip.json",
          "  Unchanged .github/repository-controls.json",
          "  Unchanged .github/dependabot.yml",
          "  Unchanged scripts/repository-controls.mjs",
          "  Unchanged docs/repository-controls.md",
          "  Unchanged .gitignore",
          '    Already holds the artifact-cache block: ".calavera/cache/"',
          "",
        ]);
        assert.deepEqual(lines.slice(lines.indexOf("Scripts:"), lines.indexOf("Scripts:") + 3), [
          "Scripts:",
          "  Scripts already set: lint:styles, lint:styles:fix, knip, repo:controls:check, repo:controls:apply, quality",
          "",
        ]);
        // A locked artifact whose files match gets no line of its own; its wiring still does.
        assert.deepEqual(lines.slice(lines.indexOf("Artifacts:"), lines.indexOf("Notes:")), [
          "Artifacts:",
          "  skill-protected-branch-guard",
          "    protectedBranch = main (recorded in the recipe)",
          `    .vite-hooks/pre-commit already holds its block: ${guardBlock("commit")}`,
          `    .vite-hooks/prepare-commit-msg already holds its block: ${guardBlock("commit")}`,
          `    .vite-hooks/pre-push already holds its block: ${guardBlock("pre-push")}`,
          "    .claude/settings.json already holds its hook groups",
          `  ${dispatcherWarning}`,
          "",
        ]);
      },
    );

    await t.test(
      "a dry run says when a lock leaves the installed files unchanged (#749)",
      async () => {
        // As after a bootstrap that installed the files before the project had a lock.
        await rm(LOCK_PATH);
        const relock = await applyRecipeObject(
          dryRun.recipe,
          { ...applyOptions, dryRun: true },
          registry,
        );
        const lines = summary(relock, root);
        assert.ok(
          lines.includes(
            "  Would lock skill-protected-branch-guard 1.0.0; its files in the project already match",
          ),
          printed(lines),
        );
        assert.ok(
          lines.includes(
            "  Would lock hook-block-dangerous-commands 0.4.0; its files in the project already match",
          ),
          printed(lines),
        );
        assert.ok(!lines.includes("Nothing to change: the project already matches this recipe."));
      },
    );
  });
});

test("the install note names the packages the project already lists when only some are", async () => {
  await inManagedProject(async (root) => {
    const manifest = JSON.parse(await readFile("package.json", "utf8"));
    manifest.devDependencies = { ...manifest.devDependencies, knip: "^5.0.0" };
    await writeFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);

    const result = await applyRecipeObject(buildRecipe("minimal", ["knip", "stylelint"], "pnpm"), {
      ...applyOptions,
      dryRun: true,
    });

    assert.equal(
      result.installNotes.at(-1),
      "knip is already a dev dependency of the project; apply still installs it with the others, which can update its version and the lockfile.",
    );
    assert.ok(summary(result, root).includes(`  ${result.installNotes.at(-1)}`));
  });
});

test("the output of the recipe the #918 rehearsal applies passes its listing check (#617)", async () => {
  await inManagedProject(async () => {
    // The rehearsal applies the default profile with one artifact (scripts/rehearsal-checks.mjs).
    const recipe = {
      ...buildRecipe(
        "default",
        ["editorconfig", "stylelint", "stylelint-standard", "stylelint-baseline"],
        "pnpm",
      ),
      ai: [{ id: "skill-release-with-confidence" }],
    };
    const registry = stubRegistry(new Map([["skill-release-with-confidence", "0.2.3"]]));
    const text = (/** @type {import("../src/index.js").ApplyResult} */ result) =>
      printed(applySummaryLines(result).map((line) => line.text));

    const dryRun = await applyRecipeObject(recipe, { ...applyOptions, dryRun: true }, registry);
    const planned = namedItems(JSON.parse(JSON.stringify(dryRun)));
    assert.deepEqual(listingViolations(text(dryRun), planned, dryRun.vitePlus.lines), []);

    const applied = await applyRecipeObject(
      dryRun.recipe,
      { ...applyOptions, approvedArtifacts: dryRun.autoInstalledArtifacts },
      registry,
    );
    assert.deepEqual(listingViolations(text(applied), planned), []);

    const second = await applyRecipeObject(
      dryRun.recipe,
      { ...applyOptions, dryRun: true },
      registry,
    );
    assert.deepEqual(
      listingViolations(
        text(second),
        namedItems(JSON.parse(JSON.stringify(second))),
        second.vitePlus.lines,
      ),
      [],
    );
  });
});

test("every line the dry run prints for the rich recipe fits in 100 columns, except fixed text and quoted values", async () => {
  await inManagedProject(async (root) => {
    const dryRun = await applyRecipeObject(
      richRecipe,
      { ...applyOptions, dryRun: true },
      stubRegistry(richReleases),
    );
    // The ADR-0011 report lines, the notes, and the warning are fixed sentences; quoted values are
    // the exact text apply writes; the runner note holds two absolute paths.
    const fixed = new Set([
      ...dryRun.vitePlus.lines,
      // The summary prints the cache pointer without the ignore file it names under Files.
      ...dryRun.pointers.map((pointer) => pointer.replace(" in .gitignore,", ",")),
      ...dryRun.wiringWarnings,
    ]);
    const long = summary(dryRun, root).filter(
      (line) =>
        line.length > 100 &&
        !fixed.has(line.trim()) &&
        !line.includes('"') &&
        !line.includes("<project>") &&
        !line.startsWith("  Install command: "),
    );
    assert.deepEqual(long, []);
  });
});

/**
 * An apply result with nothing in it, for the cases a fixture project does not reach.
 *
 * @param {Partial<import("../src/index.js").ApplyResult>} overrides
 * @returns {import("../src/index.js").ApplyResult}
 */
function emptyResult(overrides) {
  return {
    command: "apply",
    dryRun: true,
    packageManager: "npm",
    dependencies: [],
    installCommand: null,
    installNotes: [],
    integrations: [],
    projectInspection: {
      packageManager: "npm",
      files: [],
      findings: [],
      vitePlus: { status: "unmanaged", corroborating: [] },
    },
    vitePlus: { status: "unmanaged", signalConflict: false, lines: [] },
    changes: [],
    scriptChanges: [],
    pointers: [],
    autoInstalledArtifacts: [],
    artifactRegistries: [],
    artifactWarnings: [],
    artifactInputs: [],
    integrationInputs: [],
    inputWarnings: [],
    wiringChanges: [],
    wiringWarnings: [],
    ignoreChanges: [],
    recipe: { version: 1, integrations: [] },
    ...overrides,
  };
}

/** @param {import("../src/apply-summary.js").SummaryLine[]} lines */
function levels(lines) {
  return lines.map(({ level, text }) => `${level} ${text}`);
}

test("each kind of file, script, and finding has one line, in both tenses", () => {
  const changes = [
    {
      type: "update",
      path: "package.json",
      scripts: ["kept", "renamed", "changed", "added"],
      removedDefaultTestScript: true,
      removedQualityScript: "old quality",
      omittedScripts: [{ script: "lint:html", reason: "no HTML files" }],
      omittedQualitySteps: [{ step: "vp check", reason: "Vite+ is not installed" }],
    },
    { type: "write", path: "owned.json", action: "write", ownership: "calavera" },
    { type: "write", path: ".env.schema", action: "scaffold", ownership: "project" },
    { type: "write", path: "merged.json", action: "merge", ownership: "project" },
    { type: "write", path: "plain.yaml", action: "write", ownership: "project" },
    { type: "unchanged", path: "same.json" },
    { type: "skip", path: "skipped.json" },
  ];
  const scriptChanges = [
    { script: "renamed", value: "run renamed", previous: "run old", renamedFrom: "old-name" },
    { script: "changed", value: "run new", previous: "run before" },
    { script: "added", value: "run added" },
  ];
  const findings = [
    { severity: "info", kind: "package-manager", message: "Detected npm." },
    { severity: "info", kind: "vite-plus-unmanaged", message: "Not managed." },
    { severity: "warning", kind: "vite-plus-signal-conflict", message: "Conflict." },
    { severity: "warning", kind: "vite-plus-detection-unknown", message: "Unknown." },
    { severity: "info", kind: "vite-plus-managed", message: "Managed." },
    { severity: "warning", kind: "existing-config", message: "knip.json exists." },
  ];
  const dryRun = emptyResult({
    changes,
    scriptChanges,
    projectInspection: {
      packageManager: "npm",
      files: [],
      findings,
      vitePlus: { status: "unmanaged", corroborating: [] },
    },
    vitePlus: {
      status: "unmanaged",
      signalConflict: false,
      lines: ["Vite+ detection: unmanaged."],
    },
    pointers: ["A pointer."],
    inputWarnings: ["An input warning."],
  });

  assert.deepEqual(levels(applySummaryLines(dryRun)), [
    "info Calavera apply dry run complete. No files were changed.",
    "info ",
    "info Project:",
    "info   Package manager: npm",
    "info   Vite+ detection: unmanaged.",
    "info   Inspection warning: knip.json exists.",
    "info ",
    "info Files:",
    "info   Would update package.json",
    "info   Would write and own owned.json",
    "info   Would scaffold .env.schema",
    "info   Would merge merged.json",
    "info   Would write plain.yaml",
    "info   Unchanged same.json",
    "info ",
    "info Scripts:",
    'info   Would rename script old-name to renamed: "run renamed"',
    'info   Would change script changed from "run before" to "run new"',
    'info   Would add script added: "run added"',
    "info   Scripts already set: kept",
    "info   Would remove the default npm test placeholder script",
    'info   Would remove script quality: "old quality"',
    "info   Would omit script lint:html: no HTML files",
    "info   Would omit vp check from script quality: Vite+ is not installed",
    "info ",
    "info Notes:",
    "info   A pointer.",
    "warn   An input warning.",
  ]);

  assert.deepEqual(levels(applySummaryLines({ ...dryRun, dryRun: false })), [
    "success Calavera apply complete.",
    "info ",
    "info Files:",
    "info   Updated package.json",
    "info   Wrote owned.json, which Calavera owns",
    "info   Scaffolded .env.schema",
    "info   Merged merged.json",
    "info   Wrote plain.yaml",
    "info   Unchanged same.json",
    "info ",
    "info Scripts:",
    'info   Renamed script old-name to renamed: "run renamed"',
    'info   Changed script changed from "run before" to "run new"',
    'info   Added script added: "run added"',
    "info   Scripts already set: kept",
    "info   Removed the default npm test placeholder script",
    'info   Removed script quality: "old quality"',
    "info   Omitted script lint:html: no HTML files",
    "info   Omitted vp check from script quality: Vite+ is not installed",
    "info ",
    "info Notes:",
    "info   A pointer.",
    "warn   An input warning.",
  ]);
});

test("nothing to change is said only when every change is unchanged and nothing is locked", () => {
  const nothing = "Nothing to change: the project already matches this recipe.";
  const texts = (/** @type {Partial<import("../src/index.js").ApplyResult>} */ overrides) =>
    applySummaryLines(emptyResult(overrides)).map(({ text }) => text);

  assert.equal(texts({ changes: [] }).includes(nothing), false);
  assert.equal(texts({ changes: [{ type: "unchanged", path: "a" }] })[1], nothing);
  assert.equal(
    texts({
      changes: [
        { type: "unchanged", path: "a" },
        { type: "write", path: "b" },
      ],
    }).includes(nothing),
    false,
  );
  assert.equal(
    texts({
      changes: [{ type: "unchanged", path: "a" }],
      autoInstalledArtifacts: [/** @type {any} */ ({ id: "skill-project-goal", version: "0.1.0" })],
      recipe: { version: 1, integrations: [], ai: [{ id: "skill-project-goal" }] },
    }).includes(nothing),
    false,
  );
});

test("each ignore file is named once, with each owner's lines under it", () => {
  const ignoreChanges = [
    {
      path: ".gitignore",
      integration: "stryker",
      type: "update",
      lines: ["b/"],
      previousLines: ["a/"],
    },
    { path: ".gitignore", integration: "stryker", type: "unchanged", lines: ["c/"] },
    { path: ".gitignore", integration: "stryker", type: "update", removedLines: ["d/"] },
    {
      path: ".gitignore",
      integration: "artifact-cache",
      type: "update",
      removedLines: [".calavera/cache/"],
    },
    { path: ".htmlvalidateignore", type: "update", removedLines: ["e/"] },
    { path: ".htmlvalidateignore", integration: "html-validate", type: "update", lines: ["f/"] },
    { path: ".other-ignore", integration: "stryker", type: "write", lines: ["g/"] },
  ];
  const result = emptyResult({
    changes: [
      { type: "update", path: ".gitignore", action: "merge", ownership: "project" },
      { type: "write", path: ".htmlvalidateignore", action: "write", ownership: "calavera" },
    ],
    ignoreChanges: /** @type {any} */ (ignoreChanges),
  });

  const expected = (/** @type {boolean} */ dryRun) => {
    const verb = (/** @type {string} */ planned, /** @type {string} */ done) =>
      dryRun ? planned : done;
    return [
      "Files:",
      `  ${verb("Would update", "Updated")} .gitignore`,
      `    ${verb("Would replace", "Replaced")} the stryker block: "a/" with "b/"`,
      '    Already holds the stryker block: "c/"',
      `    ${verb("Would remove", "Removed")} the stryker block, because stryker no longer adds lines to it: "d/"`,
      `    ${verb("Would remove", "Removed")} the artifact-cache block, because the recipe selects no artifacts and .calavera/cache/ does not exist: ".calavera/cache/"`,
      `  ${dryRun ? "Would write and own .htmlvalidateignore" : "Wrote .htmlvalidateignore, which Calavera owns"}`,
      `    ${verb("Would remove", "Removed")} lines no selected integration declares: "e/"`,
      `    ${verb("Would add", "Added")} the html-validate lines: "f/"`,
      "  .other-ignore",
      `    ${verb("Would add", "Added")} the stryker lines: "g/"`,
    ];
  };
  const files = (/** @type {import("../src/index.js").ApplyResult} */ value) => {
    const lines = applySummaryLines(value).map(({ text }) => text);
    return lines.slice(lines.indexOf("Files:"));
  };

  assert.deepEqual(files(result), expected(true));
  assert.deepEqual(files({ ...result, dryRun: false }), expected(false));
});

test("integrations name their packages once and say how the install ran", () => {
  const recipe = {
    version: 1,
    integrations: ["editorconfig", "knip", "stylelint-scss", "stylelint-standard"],
  };
  const dependencies = [
    "knip",
    "stylelint-scss",
    "stylelint-config-standard-scss",
    "stylelint-config-standard",
  ];
  const integrationInputs = [
    {
      integration: "knip",
      name: "branch",
      path: "integrationOptions.knip.branch",
      value: "main",
      source: "default",
      defaultSource: { detail: "origin/HEAD" },
    },
    { integration: "knip", name: "other", path: "x", value: "v", source: "prompt" },
    { integration: "knip", name: "plain", path: "y", value: "w", source: "default" },
  ];
  const base = emptyResult({
    recipe,
    dependencies,
    integrationInputs: /** @type {any} */ (integrationInputs),
  });
  const integrations = (/** @type {import("../src/index.js").ApplyResult} */ value) => {
    const lines = applySummaryLines(value).map(({ text }) => text);
    const start = lines.indexOf("Integrations:");
    const end = lines.indexOf("", start);
    return lines.slice(start, end === -1 ? undefined : end);
  };
  const named = [
    "Integrations:",
    "  editorconfig",
    "  knip",
    "    branch = main (the default (origin/HEAD), because the recipe records no value; apply needs it recorded in the recipe)",
    "    other = v (your answer)",
    "    plain = w (the default, because the recipe records no value; apply needs it recorded in the recipe)",
    // stylelint-scss includes stylelint, which the recipe resolves first.
    "  stylelint",
    "  stylelint-standard (stylelint-config-standard)",
    "  stylelint-scss (also stylelint-config-standard-scss)",
  ];

  assert.deepEqual(integrations({ ...base, dryRun: false }), [
    ...named,
    "  Not installed, because apply ran with --no-install.",
  ]);
  assert.deepEqual(
    integrations({
      ...base,
      installCommand: "npm install --save-dev knip",
      installNotes: ["A note."],
    }),
    [...named, "  Install command: npm install --save-dev knip", "  A note."],
  );
  assert.deepEqual(
    integrations({ ...base, dryRun: false, installCommand: "npm install --save-dev knip" }),
    [...named, "  Installed with: npm install --save-dev knip"],
  );
  // Without packages, no install line.
  assert.deepEqual(
    applySummaryLines(emptyResult({ recipe: { version: 1, integrations: ["editorconfig"] } })).map(
      ({ text }) => text,
    ),
    [
      "Calavera apply dry run complete. No files were changed.",
      "",
      "Project:",
      "  Package manager: npm",
      "",
      "Integrations:",
      "  editorconfig",
    ],
  );
});

test("each artifact is one line, with its outputs, inputs, and wiring under it", () => {
  const recipe = {
    version: 1,
    integrations: [],
    ai: [
      { id: "skill-project-goal" },
      { id: "hook-block-dangerous-commands" },
      { id: "skill-code-review" },
      { id: "skill-css-tokens" },
    ],
  };
  const changes = [
    {
      type: "write",
      path: ".agents/skills/project-goal",
      category: "ai",
      aiType: "skill",
      name: "project-goal",
    },
    {
      type: "write",
      path: ".agents/hooks/claude-code/block-dangerous-commands.mjs",
      category: "ai",
    },
    {
      type: "write",
      path: ".agents/hooks/claude-code/block-dangerous-commands.settings-fragment.json",
      category: "ai",
    },
    { type: "write", path: ".vite-hooks/pre-commit", action: "write", ownership: "project" },
  ];
  const wiringChanges = [
    {
      artifact: "skill-code-review",
      path: ".vite-hooks/pre-commit",
      kind: "vite-hook",
      type: "unchanged",
      block: "run a",
    },
    {
      artifact: "skill-code-review",
      path: ".vite-hooks/pre-push",
      kind: "vite-hook",
      type: "update",
      block: "run b",
    },
    {
      artifact: "skill-code-review",
      path: ".vite-hooks/pre-push",
      kind: "vite-hook",
      type: "update",
      removedBlock: "run c",
    },
    {
      artifact: "skill-code-review",
      path: ".claude/settings.json",
      kind: "claude-settings",
      type: "unchanged",
    },
    {
      artifact: "skill-code-review",
      path: ".claude/settings.json",
      kind: "claude-settings",
      type: "update",
      groupChanges: [
        { event: "SessionStart", action: "replace", group: { a: 1 }, previous: { a: 0 } },
        { event: "PreToolUse", action: "remove", previous: { b: 0 } },
      ],
      reformatted: true,
    },
    {
      artifact: "skill-dropped",
      path: ".vite-hooks/pre-commit",
      kind: "vite-hook",
      type: "update",
      removedBlock: "run d",
      deselected: true,
    },
    {
      artifact: "skill-dropped",
      path: ".claude/settings.json",
      kind: "claude-settings",
      type: "update",
      groupChanges: [{ event: "Stop", action: "remove", previous: { c: 0 } }],
      deselected: true,
    },
  ];
  const result = emptyResult({
    recipe,
    changes: /** @type {any} */ (changes),
    autoInstalledArtifacts: /** @type {any} */ ([{ id: "skill-css-tokens", version: "0.3.0" }]),
    artifactRegistries: [{ origin: "https://registry.example", source: "project .npmrc" }],
    artifactWarnings: ["An npm setting was ignored."],
    artifactInputs: /** @type {any} */ ([
      {
        artifact: "skill-code-review",
        index: 2,
        name: "branch",
        value: "main",
        source: "recorded",
      },
    ]),
    wiringChanges: /** @type {any} */ (wiringChanges),
    wiringWarnings: ["A wiring warning."],
  });

  const artifacts = (/** @type {import("../src/index.js").ApplyResult} */ value) => {
    const lines = levels(applySummaryLines(value));
    return lines.slice(lines.indexOf("info Artifacts:"));
  };

  assert.deepEqual(artifacts(result), [
    "info Artifacts:",
    "info   Registry: https://registry.example (from the project .npmrc)",
    "info   Would write skill-project-goal to .agents/skills/project-goal",
    "info   Would write hook-block-dangerous-commands:",
    "info     .agents/hooks/claude-code/block-dangerous-commands.mjs",
    "info     .agents/hooks/claude-code/block-dangerous-commands.settings-fragment.json",
    "info   skill-code-review",
    "info     branch = main (recorded in the recipe)",
    'info     .vite-hooks/pre-commit already holds its block: "run a"',
    'info     Would update its block in .vite-hooks/pre-push: "run b"',
    'info     Would remove its block from .vite-hooks/pre-push, because it no longer wires that hook: "run c"',
    "info     .claude/settings.json already holds its hook groups",
    'info     Would replace the SessionStart group in .claude/settings.json: {"a":0} with {"a":1}',
    'info     Would remove the PreToolUse group from .claude/settings.json: {"b":0}',
    "info     Would also change the layout of the rest of .claude/settings.json, because Calavera writes the whole file in the project's format; no value outside the groups changes",
    "info   Would lock skill-css-tokens 0.3.0; its files in the project already match",
    "info   skill-dropped, which the recipe no longer selects",
    'info     Would remove its block from .vite-hooks/pre-commit, because the recipe no longer selects it: "run d"',
    'info     Would remove the Stop group from .claude/settings.json, because the recipe no longer selects it: {"c":0}',
    "warn   An npm setting was ignored.",
    "warn   A wiring warning.",
  ]);

  assert.deepEqual(artifacts({ ...result, dryRun: false }).slice(2, 4), [
    "info   Wrote skill-project-goal to .agents/skills/project-goal",
    "info   Wrote hook-block-dangerous-commands:",
  ]);
  assert.equal(
    artifacts({ ...result, dryRun: false }).includes(
      "info   Locked skill-css-tokens 0.3.0; its files in the project already matched",
    ),
    true,
  );
  // The wiring file sits under the artifact, not under Files.
  const lines = applySummaryLines(result).map(({ text }) => text);
  assert.equal(lines.includes("Files:"), false);
  // An artifact with nothing to report has no line, and no group appears without one.
  assert.equal(
    applySummaryLines(
      emptyResult({ recipe: { version: 1, integrations: [], ai: [{ id: "skill-project-goal" }] } }),
    )
      .map(({ text }) => text)
      .includes("Artifacts:"),
    false,
  );
});

test("a package manager given to apply that differs from the detected one stays visible", () => {
  const finding = {
    severity: "info",
    kind: "package-manager",
    message: "Detected pnpm as the project package manager.",
  };
  const texts = (/** @type {string} */ detected) =>
    applySummaryLines(
      emptyResult({
        projectInspection: {
          packageManager: /** @type {any} */ (detected),
          files: [],
          findings: /** @type {any} */ ([finding]),
          vitePlus: { status: "unmanaged", corroborating: [] },
        },
      }),
    ).map(({ text }) => text);

  assert.equal(texts("npm").includes(`  Inspection info: ${finding.message}`), false);
  assert.equal(texts("pnpm").includes(`  Inspection info: ${finding.message}`), true);
});

test("apply does not say nothing to change; only the dry run does", () => {
  const unchanged = emptyResult({ changes: [{ type: "unchanged", path: "a" }] });
  assert.deepEqual(
    applySummaryLines({ ...unchanged, dryRun: false }).map(({ text }) => text),
    ["Calavera apply complete.", "", "Files:", "  Unchanged a"],
  );
});

test("artifact and wiring warnings print even when no artifact has a line", () => {
  assert.deepEqual(
    levels(
      applySummaryLines(
        emptyResult({ artifactWarnings: ["An npm setting."], wiringWarnings: ["A hook."] }),
      ),
    ).slice(-3),
    ["info Artifacts:", "warn   An npm setting.", "warn   A hook."],
  );
});

test("the runner note keeps its exact command when it does not end with the install arguments", () => {
  const note =
    "Vite+ runs this with the package manager the project pins; apply runs it as: node vp add -D other";
  const lines = applySummaryLines(
    emptyResult({
      recipe: { version: 1, integrations: ["knip"] },
      dependencies: ["knip"],
      installCommand: "vp add -D knip",
      installNotes: [note, "Another note."],
    }),
  ).map(({ text }) => text);
  assert.ok(lines.includes(`  ${note}`));
  assert.ok(lines.includes("  Another note."));
});

test("the artifact group reads in the past tense after apply, and names the default registry alone", () => {
  const result = emptyResult({
    dryRun: false,
    recipe: {
      version: 1,
      integrations: [],
      ai: [{ id: "skill-code-review" }, { id: "skill-css-tokens" }],
    },
    artifactRegistries: [{ origin: "https://registry.npmjs.org", source: "default" }],
    autoInstalledArtifacts: /** @type {any} */ ([{ id: "skill-css-tokens", version: "0.3.0" }]),
    // An artifact with only an input still gets a line, with the input under it.
    artifactInputs: /** @type {any} */ ([
      {
        artifact: "skill-code-review",
        index: 0,
        name: "branch",
        value: "main",
        source: "recorded",
      },
    ]),
    wiringChanges: /** @type {any} */ ([
      {
        artifact: "skill-css-tokens",
        path: ".vite-hooks/pre-push",
        kind: "vite-hook",
        type: "update",
        block: "run b",
      },
      {
        artifact: "skill-css-tokens",
        path: ".vite-hooks/pre-push",
        kind: "vite-hook",
        type: "update",
        removedBlock: "run c",
      },
      {
        artifact: "skill-css-tokens",
        path: ".claude/settings.json",
        kind: "claude-settings",
        type: "update",
        groupChanges: [
          { event: "SessionStart", action: "add", group: { a: 1 } },
          { event: "Stop", action: "replace", group: { a: 1 }, previous: { a: 0 } },
          { event: "PreToolUse", action: "remove", previous: { b: 0 } },
        ],
        reformatted: true,
      },
    ]),
  });
  const lines = applySummaryLines(result).map(({ text }) => text);
  assert.deepEqual(lines.slice(lines.indexOf("Artifacts:")), [
    "Artifacts:",
    "  Registry: https://registry.npmjs.org",
    "  skill-code-review",
    "    branch = main (recorded in the recipe)",
    "  Locked skill-css-tokens 0.3.0; its files in the project already matched",
    '    Updated its block in .vite-hooks/pre-push: "run b"',
    '    Removed its block from .vite-hooks/pre-push, because it no longer wires that hook: "run c"',
    '    Added a SessionStart group to .claude/settings.json: {"a":1}',
    '    Replaced the Stop group in .claude/settings.json: {"a":0} with {"a":1}',
    '    Removed the PreToolUse group from .claude/settings.json: {"b":0}',
    "    Also changed the layout of the rest of .claude/settings.json, because Calavera writes the whole file in the project's format; no value outside the groups changes",
  ]);
});

test("a registry is named only with an artifact line; the scripts come from the change that has them", () => {
  const lines = applySummaryLines(
    emptyResult({
      artifactRegistries: [{ origin: "https://registry.example", source: "default" }],
      changes: [
        { type: "write", path: "first.json", action: "write", ownership: "project" },
        { type: "unchanged", path: "package.json", scripts: ["knip"] },
      ],
      ignoreChanges: /** @type {any} */ ([
        { path: "first.json", integration: "stryker", type: "write", lines: ["a/", "b/"] },
      ]),
    }),
  ).map(({ text }) => text);
  assert.equal(lines.includes("Artifacts:"), false);
  assert.ok(lines.includes('    Would add the stryker lines: "a/", "b/"'));
  assert.deepEqual(lines.slice(lines.indexOf("Scripts:")), [
    "Scripts:",
    "  Scripts already set: knip",
  ]);
});

test("a differing package manager keeps only its own finding", () => {
  const lines = applySummaryLines(
    emptyResult({
      projectInspection: {
        packageManager: "pnpm",
        files: [],
        findings: /** @type {any} */ ([
          { severity: "info", kind: "package-manager", message: "Detected pnpm." },
          { severity: "info", kind: "vite-plus-unmanaged", message: "Not managed." },
        ]),
        vitePlus: { status: "unmanaged", corroborating: [] },
      },
    }),
  ).map(({ text }) => text);
  assert.ok(lines.includes("  Inspection info: Detected pnpm."));
  assert.equal(lines.includes("  Inspection info: Not managed."), false);
});

test("the runner note is shortened only for a vp command whose arguments it ends with", () => {
  const prefix = "Vite+ runs this with the package manager the project pins; apply runs it as: ";
  const notesFor = (/** @type {string} */ installCommand, /** @type {string} */ note) =>
    applySummaryLines(
      emptyResult({
        recipe: { version: 1, integrations: ["knip"] },
        dependencies: ["knip"],
        installCommand,
        installNotes: [note],
      }),
    )
      .map(({ text }) => text)
      .at(-1);

  assert.equal(
    notesFor("vp add -D knip", `${prefix}node vp add -D knip`),
    "  Vite+ runs this with the package manager the project pins; apply runs it with: node vp",
  );
  assert.equal(
    notesFor("pnpm add -D knip", `${prefix}node vp add -D knip`),
    `  ${prefix}node vp add -D knip`,
  );
  assert.equal(
    notesFor("vp add -D knip", "Other note ending add -D knip"),
    "  Other note ending add -D knip",
  );
});
