// Issue #1022: `init --apply` prints the grouped summary that `apply --dry-run` prints since #617,
// not its old one-line-per-field note. The test pins the summary block for a Vite+-managed
// project and runs the #918 rehearsal's listing check over the whole output, so the recipe
// summary above the dry run does not name a package or a file the dry run names again.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { listingViolations, namedItems } from "../../../scripts/rehearsal-checks.mjs";
import { initRecipeSummary, initSummaryLines } from "../src/init-summary.js";
import { copyReleaseFixture, writeVitePlusStub } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));

const initArguments = [
  "init",
  "--apply",
  "--dry-run",
  "--yes",
  "--profile",
  "minimal",
  "--package-manager",
  "pnpm",
  "--integrations",
  "editorconfig,stylelint,stylelint-standard",
];

/**
 * Runs the CLI in `root` and returns its standard output as the terminal shows it, without colors
 * and with the machine-specific paths replaced.
 *
 * @param {string} root
 * @param {string[]} args
 */
function runCli(root, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd: root,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 60_000,
  });
  assert.equal(result.status, 0, `init failed:\n${result.stdout}\n${result.stderr}`);
  return stripVTControlCharacters(result.stdout)
    .replaceAll(process.execPath, "<node>")
    .replaceAll(root, "<project>");
}

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
  await callback(fixture.root);
}

test("init --apply prints the grouped apply summary, each item once under a heading (#1022)", async () => {
  await inManagedProject(async (root) => {
    const output = runCli(root, initArguments);

    assert.deepEqual(output.split("\n"), [
      "┌  Compose your Calavera tooling recipe",
      "│",
      // The apply dry run below names the package manager, the integrations, and their packages.
      "◇  Recipe summary ───╮",
      "│                    │",
      "│  Profile: minimal  │",
      "│                    │",
      "├────────────────────╯",
      "Calavera apply dry run complete. No files were changed.",
      "",
      "Project:",
      "  Package manager: pnpm",
      "  Vite+ detection: managed. This project is vp-managed (vite-plus-dependency signal at package.json).",
      "  JavaScript and TypeScript linting, formatting, type-checking, and testing are provided by Vite+, not by Calavera.",
      "",
      "Integrations:",
      "  editorconfig",
      "  stylelint",
      "  stylelint-standard (stylelint-config-standard)",
      "  Install command: vp add -D stylelint stylelint-config-standard",
      "  The package manager given to Calavera (pnpm) does not change this command: Vite+ installs with the package manager the project pins.",
      "  Vite+ runs this with the package manager the project pins; apply runs it with: <node> <project>/node_modules/vite-plus/bin/vp",
      "",
      "Files:",
      "  Would update package.json",
      "  Would write and own .editorconfig",
      "  Would write and own .stylelintrc.json",
      "",
      "Scripts:",
      '  Would add script lint:styles: "stylelint \\"**/*.{css,scss}\\" --allow-empty-input"',
      '  Would add script lint:styles:fix: "stylelint \\"**/*.{css,scss}\\" --allow-empty-input --fix"',
      '  Would add script quality: "vp check && vp test --passWithNoTests && pnpm lint:styles"',
      "│",
      "└  Calavera recipe previewed.",
      "",
      // The closing lines no longer repeat the profile, package manager, and integrations.
      "Calavera recipe dry run complete. Would write calavera.config.json.",
      "Apply was previewed but not run.",
      "",
    ]);

    const { applyDryRun } = JSON.parse(runCli(root, [...initArguments, "--json"]));
    assert.deepEqual(
      listingViolations(output, namedItems(applyDryRun), applyDryRun.vitePlus.lines),
      [],
    );
  });
});

test("init without --apply still lists the whole recipe in its summary (#1022)", async () => {
  await inManagedProject(async (root) => {
    const output = runCli(
      root,
      initArguments.filter((argument) => argument !== "--apply"),
    );

    assert.match(output, /│ {2}Package manager: pnpm +│/);
    assert.match(output, /│ {2}Dependencies: stylelint, stylelint-config-standard +│/);
    assert.match(output, /\nIntegrations: editorconfig, stylelint, stylelint-standard\n/);
    assert.doesNotMatch(output, /Calavera apply dry run complete/);
  });
});

test("init --apply prints a pointer the dry run already printed once, not again after applying (#1022)", async () => {
  await inManagedProject(async (root) => {
    const output = runCli(root, [
      "init",
      "--apply",
      "--yes",
      "--no-install",
      "--profile",
      "minimal",
      "--package-manager",
      "pnpm",
      "--integrations",
      "editorconfig,varlock",
    ]);

    const pointer = "Varlock recommends committing non-local .env.* files";
    assert.equal(output.split(pointer).length - 1, 1, output);
    assert.match(output, /\nNotes:\n {2}Review \.env\.schema/);
    assert.match(output, /\nWrote calavera\.config\.json\.\nCalavera apply complete\.\n$/);
  });
});

// The cases below build the result by hand and run in-process, so Stryker sees which test reaches
// each branch; it cannot see into the child processes the tests above start.
const recipe = /** @type {import("../src/index.js").Recipe} */ ({
  version: 1,
  profile: "minimal",
  packageManager: "pnpm",
  integrations: ["editorconfig", "knip"],
});

/** @param {Partial<import("../src/index.js").InitResult>} overrides */
function initResult(overrides) {
  return /** @type {import("../src/index.js").InitResult} */ ({
    command: "init",
    config: "calavera.config.json",
    dryRun: false,
    recipe,
    ...overrides,
  });
}

/** @param {string[]} pointers */
function applyResult(pointers) {
  return /** @type {import("../src/index.js").ApplyResult} */ ({ pointers });
}

/** @param {import("../src/summary-lines.js").SummaryLine[]} lines */
function levels(lines) {
  return lines.map(({ level, text }) => `${level}: ${text}`);
}

test("the recipe summary names only the profile with --apply, and the whole recipe without it (#1022)", () => {
  const explanation = { dependencies: ["knip"], aiArtifacts: [{}] };
  assert.equal(
    stripVTControlCharacters(initRecipeSummary(recipe, explanation, true)),
    "Profile: minimal",
  );
  assert.equal(
    stripVTControlCharacters(initRecipeSummary(recipe, explanation, false)),
    [
      "Profile: minimal",
      "Package manager: pnpm",
      "Integrations: 2 items",
      "Dependencies: knip",
      "AI artifacts: 1",
    ].join("\n"),
  );
  assert.match(
    stripVTControlCharacters(
      initRecipeSummary(
        { ...recipe, integrations: undefined },
        { dependencies: [], aiArtifacts: [] },
        false,
      ),
    ),
    /\nIntegrations: 0 items\nDependencies: none\nAI artifacts: 0$/,
  );
});

test("init without --apply closes with the recipe it wrote (#1022)", () => {
  // An empty ai list prints no AI artifacts line.
  assert.deepEqual(levels(initSummaryLines(initResult({ recipe: { ...recipe, ai: [] } }))), [
    "success: Wrote calavera.config.json.",
    "info: Profile: minimal",
    "info: Package manager: pnpm",
    "info: Integrations: editorconfig, knip",
  ]);
  assert.deepEqual(
    levels(
      initSummaryLines(
        initResult({
          dryRun: true,
          recipe: { ...recipe, integrations: undefined, ai: [{ id: "a" }] },
        }),
      ),
    ),
    [
      "info: Calavera recipe dry run complete. Would write calavera.config.json.",
      "info: Profile: minimal",
      "info: Package manager: pnpm",
      "info: Integrations: ",
      "info: AI artifacts: 1",
    ],
  );
});

test("init --apply closes without repeating what the apply dry run named (#1022)", () => {
  assert.deepEqual(
    levels(initSummaryLines(initResult({ dryRun: true, applyDryRun: applyResult(["shared"]) }))),
    [
      "info: Calavera recipe dry run complete. Would write calavera.config.json.",
      "info: Apply was previewed but not run.",
    ],
  );
  assert.deepEqual(
    levels(
      initSummaryLines(
        initResult({
          applyDryRun: applyResult(["shared"]),
          applyResult: applyResult(["shared", "only after apply"]),
        }),
      ),
    ),
    [
      "success: Wrote calavera.config.json.",
      "success: Calavera apply complete.",
      "info: only after apply",
    ],
  );
});
