// Issue #1022: `init --apply` prints the grouped summary that `apply --dry-run` prints since #617,
// not its old one-line-per-field note. The test pins the summary block for a Vite+-managed
// project and runs the #918 rehearsal's listing check over the whole output, so the recipe
// summary above the dry run does not name a package or a file the dry run names again.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";

import { listingViolations, namedItems } from "../../../scripts/rehearsal-checks.mjs";
import {
  initApplyDryRunLines,
  initDefaultInputLines,
  initRecipeSummary,
  initSummaryLines,
} from "../src/init-summary.js";
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

test("init --apply prints the grouped apply summary, and the lines around it repeat nothing it names (#1022)", async () => {
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

    // init wrote the recipe before the dry run, so the headline does not say nothing changed.
    assert.match(
      output,
      /\nCalavera apply dry run complete\. Apply has not changed any files yet; init wrote only calavera\.config\.json\.\n/,
    );
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

/**
 * @param {string[]} pointers
 * @param {import("../src/utils/cleanup.js").TemporaryFolderLeftover[]} [temporaryFolderLeftovers]
 */
function applyResult(pointers, temporaryFolderLeftovers = []) {
  return /** @type {import("../src/index.js").ApplyResult} */ ({
    pointers,
    temporaryFolderLeftovers,
  });
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
      "info: Integrations: none",
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
  // #1033: a temporary folder the apply could not remove is still named, as a warning.
  assert.deepEqual(
    levels(
      initSummaryLines(
        initResult({
          applyDryRun: applyResult([]),
          applyResult: applyResult(
            [],
            [{ path: ".calavera/.staging/x", reason: "EBUSY. Remove it by hand." }],
          ),
        }),
      ),
    ),
    [
      "success: Wrote calavera.config.json.",
      "success: Calavera apply complete.",
      "warn: Not removed .calavera/.staging/x: EBUSY. Remove it by hand.",
    ],
  );
});

test("init --apply names a default input by its place in the recipe, under a heading, because the dry run names its artifact (#1022)", () => {
  const artifactInputs = /** @type {import("../src/ai/artifact-inputs.js").ResolvedInput[]} */ ([
    {
      artifact: "skill-guard",
      index: 0,
      name: "protectedBranch",
      value: "main",
      source: "default",
    },
    { artifact: "skill-guard", index: 0, name: "remote", value: "origin", source: "recorded" },
  ]);
  const integrationInputs =
    /** @type {import("../src/integration-inputs.js").ResolvedIntegrationInput[]} */ ([
      {
        integration: "github-repository-controls",
        name: "defaultBranch",
        path: "integrationOptions.github-repository-controls.defaultBranch",
        value: "main",
        source: "default",
      },
      {
        integration: "github-repository-controls",
        name: "repository",
        path: "integrationOptions.github-repository-controls.repository",
        value: "example/summary",
        source: "prompt",
      },
    ]);

  assert.deepEqual(
    levels(initDefaultInputLines(artifactInputs, integrationInputs, "calavera.config.json", true)),
    [
      "info: ",
      "info: Defaults recorded in the recipe:",
      "info:   ai[0].inputs.protectedBranch = main in calavera.config.json. Change it there if it is wrong.",
      "info:   integrationOptions.github-repository-controls.defaultBranch = main in calavera.config.json. Change it there if it is wrong.",
      // A blank line keeps the apply dry run headline that follows out of this group.
      "info: ",
    ],
  );
  assert.deepEqual(
    levels(initDefaultInputLines(artifactInputs, integrationInputs, "calavera.config.json", false)),
    [
      "info: Input: skill-guard protectedBranch = main, the default, recorded as ai[0].inputs.protectedBranch in calavera.config.json. Change it there if it is wrong.",
      "info: Input: github-repository-controls defaultBranch = main, the default, recorded as integrationOptions.github-repository-controls.defaultBranch in calavera.config.json. Change it there if it is wrong.",
    ],
  );
  // Without a default, init --apply prints no heading.
  assert.deepEqual(initDefaultInputLines([], [], "calavera.config.json", true), []);
});

test("init --apply says in the dry run headline whether it has written the recipe (#1022)", () => {
  const applyDryRun = /** @type {import("../src/index.js").ApplyResult} */ ({
    dryRun: true,
    recipe: { version: 1, integrations: [] },
    packageManager: "pnpm",
    vitePlus: { lines: [] },
    projectInspection: { findings: [], packageManager: "pnpm" },
    changes: [],
    dependencies: [],
    integrationInputs: [],
    ignoreChanges: [],
    wiringChanges: [],
    scriptChanges: [],
    stagingLeftovers: [],
    temporaryFolderLeftovers: [],
    autoInstalledArtifacts: [],
    artifactInputs: [],
    artifactRegistries: [],
    artifactWarnings: [],
    wiringWarnings: [],
    pointers: [],
    inputWarnings: [],
  });
  const headline = (/** @type {boolean} */ dryRun) =>
    initApplyDryRunLines(applyDryRun, {
      config: "calavera.config.json",
      dryRun,
      noInstall: false,
    })[0];

  assert.deepEqual(headline(true), {
    level: "info",
    text: "Calavera apply dry run complete. No files were changed.",
  });
  assert.deepEqual(headline(false), {
    level: "info",
    text: "Calavera apply dry run complete. Apply has not changed any files yet; init wrote only calavera.config.json.",
  });
});

test("with --no-install, the apply dry run and init --apply say the packages will not be installed (#1022)", async () => {
  await inManagedProject(async (root) => {
    const notInstalled = [
      "  Not installed, because apply runs with --no-install.",
      "  Install them later with: vp add -D stylelint stylelint-config-standard",
      "",
    ].join("\n");

    const init = runCli(root, [
      "init",
      "--apply",
      "--yes",
      "--no-install",
      "--profile",
      "minimal",
      "--package-manager",
      "pnpm",
      "--integrations",
      "editorconfig,stylelint,stylelint-standard",
    ]);
    assert.ok(
      init.includes(`  stylelint-standard (stylelint-config-standard)\n${notInstalled}`),
      init,
    );
    assert.doesNotMatch(init, /Install command:/);

    // init wrote the recipe above, so apply plans nothing new but still names the packages.
    const apply = runCli(root, ["apply", "--dry-run", "--no-install"]);
    assert.ok(
      apply.includes(`  stylelint-standard (stylelint-config-standard)\n${notInstalled}`),
      apply,
    );
    assert.doesNotMatch(apply, /Install command:/);
  });
});

test("a real run with --no-install gives the command to install the packages later, in its own field (#1022)", async () => {
  await inManagedProject(async (root) => {
    const later = "  Install them later with: vp add -D stylelint stylelint-config-standard\n";
    const count = (/** @type {string} */ output) => output.split(later).length - 1;

    // init --apply prints the dry run, which names the command; it prints it once.
    const init = runCli(root, [
      "init",
      "--apply",
      "--yes",
      "--no-install",
      "--profile",
      "minimal",
      "--package-manager",
      "pnpm",
      "--integrations",
      "editorconfig,stylelint,stylelint-standard",
    ]);
    assert.equal(count(init), 1, init);

    for (const command of ["apply", "update"]) {
      const output = runCli(root, [command, "--yes", "--no-install"]);
      assert.ok(
        output.includes(`  Not installed, because apply ran with --no-install.\n${later}`),
        output,
      );

      // installCommand stays null when apply skips the install; the command has its own field.
      const result = JSON.parse(runCli(root, [command, "--yes", "--no-install", "--json"]));
      assert.equal(result.installCommand, null);
      assert.deepEqual(result.installNotes, []);
      assert.equal(result.laterInstallCommand, "vp add -D stylelint stylelint-config-standard");
    }

    // Nothing was installed: the vp stub records every install it is asked to run.
    const log = join(root, "vp-invocations.log");
    const installs = existsSync(log)
      ? readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => line.includes('"add"'))
      : [];
    assert.deepEqual(installs, []);

    // Without a skipped install, the field is absent: a dry run carries installCommand instead,
    // and so does an apply that installs.
    const dryRun = JSON.parse(runCli(root, ["apply", "--dry-run", "--no-install", "--json"]));
    assert.equal(dryRun.installCommand, "vp add -D stylelint stylelint-config-standard");
    assert.equal("laterInstallCommand" in dryRun, false);
    const installed = JSON.parse(runCli(root, ["apply", "--yes", "--json"]));
    assert.equal(installed.installCommand, "vp add -D stylelint stylelint-config-standard");
    assert.equal("laterInstallCommand" in installed, false);
  });
});
