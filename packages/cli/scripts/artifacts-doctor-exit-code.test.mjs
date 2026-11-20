// Issue #994: `artifacts doctor` exits 1 and prints an overall verdict when an artifact's files
// are missing, are not managed by Calavera, or carry a local edit, so a script or an agent can
// tell a healthy project from a broken one. A healthy project exits 0. `artifacts status` reports
// the same problems but stays informational, so it still exits 0 (#1030 set the same split for
// `doctor`: errors fail the run, everything else is advisory).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { artifactDoctorVerdict } from "../src/artifact-status-report.js";
import { buildRecipe } from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { createTemporaryFixture, json } from "./vite-plus-fixtures.mjs";

const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const ARTIFACT = "skill-project-goal";
// A skill installs as a directory, so the whole directory has to go for its files to be missing.
const SKILL_DIRECTORY = ".agents/skills/project-goal";
const SKILL_FILE = `${SKILL_DIRECTORY}/SKILL.md`;
const HEALTHY = "Calavera artifacts doctor found no problems.";
const PROBLEM = `Calavera artifacts doctor found problems with 1 artifact: ${ARTIFACT}.`;

/**
 * Runs the CLI in `cwd` and resolves with its exit code, whatever it is. A run killed by a signal
 * resolves with a null code, so it cannot pass as an exit 0.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [cliPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolve({
          code: error ? (typeof error.code === "number" ? error.code : null) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

/**
 * A project whose recipe selects one skill, installed through the workspace payload, so the CLI
 * run that follows finds a lock entry, managed state, and the installed file.
 *
 * @param {string} label
 */
async function installedProject(label) {
  const fixture = await createTemporaryFixture(label, {
    "calavera.config.json": json({
      ...buildRecipe("minimal", [], "npm"),
      ai: [{ id: ARTIFACT }],
    }),
  });
  const originalDirectory = process.cwd();
  try {
    process.chdir(fixture.root);
    await runArtifactCommand(
      { config: "calavera.config.json", dryRun: false, artifactAction: "install" },
      stubRegistry(new Map([[ARTIFACT, "0.2.1"]])),
    );
  } finally {
    process.chdir(originalDirectory);
  }
  return fixture;
}

const problems = [
  {
    name: "a missing artifact",
    note: "files missing",
    /** @param {string} root */
    break: (root) => rm(join(root, SKILL_DIRECTORY), { recursive: true }),
  },
  {
    name: "a locally edited artifact",
    note: "locally edited",
    /** @param {string} root */
    break: (root) => writeFile(join(root, SKILL_FILE), "local edit\n"),
  },
];

const outputModes = [
  { label: "text", args: [] },
  { label: "--json", args: ["--json"] },
];

for (const { label, args } of outputModes) {
  test(`artifacts doctor exits 0 on a healthy project (${label} output)`, async () => {
    await using fixture = await installedProject("artifacts-doctor-healthy");

    const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "doctor", ...args]);

    assert.equal(code, 0, `artifacts doctor exited ${code}\n${stdout}\n${stderr}`);
    if (label === "--json") {
      const report = JSON.parse(stdout);
      assert.equal(report.ok, true);
      assert.deepEqual(
        report.artifacts.map(({ id }) => id),
        [ARTIFACT],
      );
    } else {
      const lines = stdout.trimEnd().split("\n");
      assert.equal(lines.at(-1), HEALTHY, stdout);
      assert.equal(stderr, "");
    }
  });

  for (const problem of problems) {
    test(`artifacts doctor exits 1 on ${problem.name} (${label} output)`, async () => {
      await using fixture = await installedProject("artifacts-doctor-problem");
      await problem.break(fixture.root);

      const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "doctor", ...args]);

      assert.equal(code, 1, `artifacts doctor exited ${code}\n${stdout}\n${stderr}`);
      if (label === "--json") {
        const report = JSON.parse(stdout);
        assert.equal(report.ok, false);
        assert.equal(stderr, "");
      } else {
        assert.match(stdout, new RegExp(`${ARTIFACT} .*${problem.note}`));
        // The verdict is an error, so it goes to stderr and closes the output.
        assert.equal(stderr.trimEnd(), PROBLEM);
        assert.ok(!stdout.includes(HEALTHY), stdout);
      }
    });

    test(`artifacts status still exits 0 on ${problem.name} (${label} output)`, async () => {
      await using fixture = await installedProject("artifacts-status-problem");
      await problem.break(fixture.root);

      const { code, stdout, stderr } = await runCli(fixture.root, ["artifacts", "status", ...args]);

      assert.equal(code, 0, `artifacts status exited ${code}\n${stdout}\n${stderr}`);
      if (label === "--json") {
        assert.equal(JSON.parse(stdout).ok, false);
      } else {
        assert.match(stdout, new RegExp(`${ARTIFACT} .*${problem.note}`));
        assert.ok(!`${stdout}${stderr}`.includes("Calavera artifacts doctor"), stdout + stderr);
      }
    });
  }
}

test("the verdict names every artifact with a problem, and only those", () => {
  /** @param {string} id @param {Partial<Record<"installed" | "managed" | "locallyEdited", boolean>>} health */
  const entry = (id, health) => ({
    id,
    installed: true,
    managed: true,
    locallyEdited: false,
    ...health,
  });
  const verdict = (/** @type {ReturnType<typeof entry>[]} */ artifacts) =>
    artifactDoctorVerdict(
      /** @type {Parameters<typeof artifactDoctorVerdict>[0]} */ (
        /** @type {unknown} */ ({
          ok: artifacts.every((a) => a.installed && a.managed && !a.locallyEdited),
          artifacts,
        })
      ),
    );

  assert.deepEqual(verdict([]), { level: "success", message: HEALTHY });
  assert.deepEqual(verdict([entry("a", {})]), { level: "success", message: HEALTHY });
  assert.deepEqual(
    verdict([
      entry("a", {}),
      entry("b", { installed: false }),
      entry("c", { managed: false }),
      entry("d", { locallyEdited: true }),
    ]),
    {
      level: "error",
      message: "Calavera artifacts doctor found problems with 3 artifacts: b, c, d.",
    },
  );
});
