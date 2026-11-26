// Issue #1101: doctor resolves a legacy AI entry (`{ "type": "skill", "src": "skills/project-goal" }`)
// to its catalog artifact, as apply and `artifacts status` do. apply installs the artifact's package
// payload, so the legacy source path never exists in the project, and doctor must not report it
// as a missing source. Since #1030 that error made doctor exit 1 on a project apply set up.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempDisposable, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { callMcpTool } from "../src/mcp.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));

/** @param {object[]} ai */
function recipeWith(ai) {
  return { ...buildRecipe("minimal", [], "npm"), ai };
}

/**
 * Runs `callback` in a new Git repository on a feature branch, holding a `package.json`.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-doctor-legacy-"));
  const originalDirectory = process.cwd();
  process.chdir(project.path);
  try {
    execFileSync("git", ["init", "--quiet", "--initial-branch=main"]);
    execFileSync("git", ["switch", "--quiet", "-c", "1101-legacy"]);
    await writeFile("package.json", `${JSON.stringify({ name: "fixture" }, null, 2)}\n`);
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {object} recipe */
async function writeRecipe(recipe) {
  await writeFile("calavera.config.json", `${JSON.stringify(recipe, null, 2)}\n`);
}

/** Runs `doctor --json` and returns its exit status and output. */
function runDoctor() {
  const { status, stdout, stderr } = spawnSync(process.execPath, [cli, "doctor", "--json"], {
    encoding: "utf8",
  });
  return { status, stdout, stderr };
}

test("Given apply installed a legacy skill entry, doctor reports no issue and exits 0", async () => {
  await inProject(async () => {
    const recipe = recipeWith([{ type: "skill", src: "skills/project-goal" }]);
    const registry = stubRegistry(new Map([["skill-project-goal", "0.1.0"]]));
    await callMcpTool("apply_recipe", { recipe, noInstall: true }, registry);
    await writeRecipe(recipe);

    const { status, stdout, stderr } = runDoctor();
    assert.equal(status, 0, `doctor exited ${status}\n${stdout}\n${stderr}`);
    // Applied with nothing to report: only the phase line (ADR-0020, Decision 4).
    const report = JSON.parse(stdout);
    assert.equal(report.ok, true);
    assert.equal(report.phase, "applied");
    assert.deepEqual(
      report.issues.map((/** @type {{ check: string }} */ { check }) => check),
      ["phase"],
    );
  });
});

test("Given a legacy skill entry apply has not installed, doctor reports it as pending instead of a missing source", async () => {
  await inProject(async () => {
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/project-goal" }]));

    const { status, stdout, stderr } = runDoctor();
    assert.equal(status, 0, `doctor exited ${status}\n${stdout}\n${stderr}`);
    // The legacy entry is named by its catalog ID, as a pending artifact (ADR-0020, Decision 4).
    assert.deepEqual(
      JSON.parse(stdout).issues.filter(
        (/** @type {{ check: string }} */ { check }) => check === "artifact",
      ),
      [
        {
          level: "info",
          check: "artifact",
          artifact: "skill-project-goal",
          message:
            "The recipe selects skill-project-goal, which has no lock entry yet, so artifacts install or apply installs it.",
        },
      ],
    );
  });
});

test("Given a legacy entry selects a wired artifact apply installed, doctor treats its recorded wiring as selected", async () => {
  await inProject(async () => {
    const id = "skill-protected-branch-guard";
    const registry = stubRegistry(new Map([[id, "0.1.0"]]));
    await callMcpTool(
      "apply_recipe",
      { recipe: recipeWith([{ id, inputs: { protectedBranch: "main" } }]), noInstall: true },
      registry,
    );
    // The same artifact, selected by its legacy type and src.
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/protected-branch-guard" }]));
    // Each recorded block missing, so doctor names whether the recipe still selects the guard.
    await writeFile(".vite-hooks/pre-commit", "#!/bin/sh\n");

    const { stdout } = runDoctor();
    const messages = JSON.parse(stdout).issues.map(
      (/** @type {{ message: string }} */ { message }) => message,
    );
    assert.ok(
      messages.some((message) => message.includes(`the ${id} block that Calavera recorded`)),
      messages.join("\n"),
    );
    assert.deepEqual(
      messages.filter((message) => message.includes("no longer selects")),
      [],
    );
  });
});

test("Given a legacy entry that names a source no catalog provides, doctor reports an error and exits 1", async () => {
  await inProject(async () => {
    await writeRecipe(recipeWith([{ type: "skill", src: "skills/not-in-catalog" }]));

    const { status, stdout, stderr } = runDoctor();
    assert.equal(status, 1, `doctor exited ${status}\n${stdout}\n${stderr}`);
    // #1137: the entry is named by its position, not by its src, which is text from the file.
    assert.match(`${stdout}${stderr}`, /ai\[0\]\) names a legacy src that Calavera does not know/);
    assert.doesNotMatch(`${stdout}${stderr}`, /not-in-catalog/);
  });
});

// Issue #1140: since #1125, apply refuses a legacy entry that selects an artifact with wiring or
// inputs and points to `artifacts migrate`. doctor reports that refusal as an error, with the
// entries and the remedy apply names, as it reports apply's other refusals (#997, #1031).
const GUARD_LEGACY_REFUSAL = [
  "apply stops before writing anything, because these legacy AI entries select artifacts that need wiring or inputs:",
  '- ai[1] {"type":"skill","src":"skills/protected-branch-guard"} selects skill-protected-branch-guard by its legacy type and src, and skill-protected-branch-guard needs wiring and inputs, which a legacy entry cannot record.',
  "Run create-project-calavera artifacts migrate, which rewrites each legacy entry as an ID entry, then apply the recipe again. Apply in a terminal asks for each input value the recipe does not record; any other run names where the recipe must record it.",
].join("\n");

test("Given a legacy entry selects the protected branch guard, doctor reports apply's refusal as an error and exits 1", async () => {
  await inProject(async () => {
    await writeRecipe(
      recipeWith([
        { type: "skill", src: "skills/project-goal" },
        { type: "skill", src: "skills/protected-branch-guard" },
      ]),
    );

    const { status, stdout, stderr } = runDoctor();
    assert.equal(status, 1, `doctor exited ${status}\n${stdout}\n${stderr}`);
    const { ok, issues } = JSON.parse(stdout);
    assert.equal(ok, false);
    assert.deepEqual(
      issues
        .filter((/** @type {{ level: string }} */ { level }) => level === "error")
        .map((/** @type {{ level: string, message: string }} */ { level, message }) => ({
          level,
          message,
        })),
      [{ level: "error", message: GUARD_LEGACY_REFUSAL }],
    );
    // The refusal comes before the findings whose remedy is to run apply, which apply refuses
    // until artifacts migrate rewrites the entry.
    const messages = issues.map((/** @type {{ message: string }} */ { message }) => message);
    // The guard is not installed yet, so doctor reports it as pending (ADR-0020, Decision 4).
    const missingGuard = messages.findIndex((message) =>
      message.startsWith(
        "The recipe selects skill-protected-branch-guard, which has no lock entry",
      ),
    );
    assert.ok(missingGuard > 0, messages.join("\n"));
    assert.ok(messages.indexOf(GUARD_LEGACY_REFUSAL) < missingGuard, messages.join("\n"));
  });
});

test("Given a legacy entry selects the guard, doctor names the same entries and remedy as apply's refusal", async () => {
  await inProject(async () => {
    await writeRecipe(
      recipeWith([
        { type: "skill", src: "skills/project-goal" },
        { type: "skill", src: "skills/protected-branch-guard" },
      ]),
    );

    const apply = spawnSync(process.execPath, [cli, "apply", "--dry-run", "--json"], {
      encoding: "utf8",
    });
    assert.notEqual(apply.status, 0, apply.stdout);
    const [, applyDetails] =
      /because these legacy AI entries[^\n]*\n([\s\S]*?apply the recipe again\.)/.exec(
        apply.stderr,
      ) ?? [undefined, apply.stderr];
    const [doctorError] = JSON.parse(runDoctor().stdout).issues.filter(
      (/** @type {{ level: string }} */ { level }) => level === "error",
    );
    assert.ok(
      doctorError.message.includes(applyDetails),
      `${doctorError.message}\n---\n${apply.stderr}`,
    );
  });
});

test("Given ID entries and a legacy entry for an artifact with no wiring or inputs, doctor reports no refusal", async () => {
  await inProject(async () => {
    await writeRecipe(
      recipeWith([
        { type: "skill", src: "skills/project-goal" },
        { id: "skill-protected-branch-guard", inputs: { protectedBranch: "main" } },
      ]),
    );

    const { stdout } = runDoctor();
    assert.deepEqual(
      JSON.parse(stdout).issues.filter(
        (/** @type {{ level: string }} */ { level }) => level === "error",
      ),
      [],
    );
  });
});
