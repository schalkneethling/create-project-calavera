// #1112 (ADR-0020, Decisions 3, 5, and 8): both doctors print the same note for each file of an
// artifact without a lock entry that already exists without a state record, and carry it in
// `unrecordedFiles`. The comparison with the artifact cache runs offline: a registry that counts
// requests receives none, and neither doctor writes into the project.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtempDisposable, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listingViolations } from "../../../scripts/rehearsal-checks.mjs";
import { unrecordedFileNote } from "../src/phase-lines.js";
import { buildRecipe } from "../src/recipe.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const cli = fileURLToPath(new URL("../src/index.js", import.meta.url));
const CONFIG = "calavera.config.json";
const ID = "skill-project-goal";
const SKILL = ".agents/skills/project-goal";
const DRY_RUN = "npm create project-calavera apply -- --dry-run";

test("the note keeps the person's file in every case and names the artifact only in its message", () => {
  const recipe = { packageManager: "npm" };
  const note = (
    /** @type {string | null} */ comparedVersion,
    /** @type {boolean | null} */ matches,
  ) =>
    unrecordedFileNote(ID, { path: SKILL, comparedVersion, matches }, { recipe, config: CONFIG });

  assert.deepEqual(note(null, null), {
    message: `${SKILL} already exists without a state record, and apply stops on it unless it matches the ${ID} package, which the artifact cache cannot supply offline. To keep your file, rename or move it, deselect ${ID}, or move its contents into a file of your own. Run ${DRY_RUN} to see whether apply accepts it, without writing to the project.`,
    detail: `${SKILL} already exists without a state record, and apply stops on it unless it matches the package, which the artifact cache cannot supply offline. To keep your file, rename or move it, deselect the artifact, or move its contents into a file of your own. Run ${DRY_RUN} to see whether apply accepts it, without writing to the project.`,
  });
  assert.equal(
    note("0.1.0", false).detail,
    `${SKILL} already exists without a state record and differs from version 0.1.0 of the package in the artifact cache, so apply stops on it unless the version it resolves online matches the file. To keep your file, rename or move it, deselect the artifact, or move its contents into a file of your own. Run ${DRY_RUN} to see whether apply accepts it, without writing to the project.`,
  );
  // A match is still a note, because apply resolves the current version online.
  assert.equal(
    note("0.1.0", true).detail,
    `${SKILL} already exists without a state record and matches version 0.1.0 of the package in the artifact cache. apply resolves the current version online and accepts the file only if that version matches too. Run ${DRY_RUN} to see whether apply accepts it, without writing to the project.`,
  );
  for (const [version, matches] of [
    [null, null],
    ["0.1.0", false],
    ["0.1.0", true],
  ]) {
    const { message, detail } = note(
      /** @type {string | null} */ (version),
      /** @type {boolean | null} */ (matches),
    );
    assert.ok(!detail.includes(ID), detail);
    assert.ok(!message.includes("--reown-managed-file"), message);
  }
  // A recipe saved elsewhere is named in the dry-run command.
  assert.match(
    unrecordedFileNote(
      ID,
      { path: SKILL, comparedVersion: null, matches: null },
      { recipe, config: "c/r.json" },
    ).message,
    /Run npm create project-calavera apply -- --dry-run --config c\/r\.json to see/,
  );
});

/**
 * A registry that answers every request with 404 and counts them, so a test can tell whether a
 * doctor contacted it.
 */
async function countingRegistry() {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.statusCode = 404;
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(undefined)));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/`,
    requests: () => requests,
    [Symbol.asyncDispose]: () => new Promise((resolve) => server.close(() => resolve(undefined))),
  };
}

/** @param {string} cwd @param {string[]} args @param {string} registry */
function runCli(cwd, args, registry) {
  return /** @type {Promise<{ code: number | null, stdout: string, stderr: string }>} */ (
    new Promise((resolve) => {
      execFile(
        process.execPath,
        [cli, ...args],
        {
          cwd,
          env: {
            ...process.env,
            NO_COLOR: "1",
            npm_config_registry: registry,
            "npm_config_@schalkneethling:registry": registry,
          },
        },
        (error, stdout, stderr) =>
          resolve({
            code: error ? (typeof error.code === "number" ? error.code : null) : 0,
            stdout,
            stderr,
          }),
      );
    })
  );
}

test("both doctors print the same note for an unrecorded file, offline, and write nothing", async () => {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-unrecorded-notes-"));
  await using registry = await countingRegistry();
  const directory = await realpath(project.path);
  await writeFile(join(directory, "package.json"), `${JSON.stringify({ scripts: {} })}\n`);
  await writeFile(
    join(directory, CONFIG),
    `${JSON.stringify({ ...buildRecipe("minimal", [], "npm"), ai: [{ id: ID }] }, null, 2)}\n`,
  );
  await mkdir(join(directory, SKILL), { recursive: true });
  await writeFile(join(directory, SKILL, "SKILL.md"), "the person's own skill\n");
  // An empty cache: the real registry client reads it offline and finds nothing.
  await mkdir(join(directory, ".calavera/cache/npm"), { recursive: true });
  const before = await snapshotDirectory(directory);
  const expected = unrecordedFileNote(
    ID,
    { path: SKILL, comparedVersion: null, matches: null },
    { recipe: { packageManager: "npm" }, config: CONFIG },
  );

  const artifactsDoctor = await runCli(directory, ["artifacts", "doctor", "--json"], registry.url);
  const doctorJson = await runCli(directory, ["doctor", "--json"], registry.url);
  const artifactsText = await runCli(directory, ["artifacts", "doctor"], registry.url);
  const doctorText = await runCli(directory, ["doctor"], registry.url);

  assert.equal(registry.requests(), 0, "a doctor contacted the registry");
  assert.deepEqual(await snapshotDirectory(directory), before, "a doctor changed the project");

  // The JSON results carry the same comparison and the same words.
  const entry = { path: SKILL, comparedVersion: null, matches: null, reason: expected.detail };
  const fromArtifacts = JSON.parse(artifactsDoctor.stdout);
  assert.deepEqual(
    fromArtifacts.artifacts.find((/** @type {{ id: string }} */ { id }) => id === ID)
      ?.unrecordedFiles,
    [entry],
  );
  const fromDoctor = JSON.parse(doctorJson.stdout);
  assert.deepEqual(
    fromDoctor.artifacts.find((/** @type {{ id: string }} */ { id }) => id === ID)?.unrecordedFiles,
    [entry],
  );
  assert.deepEqual(
    fromDoctor.issues.filter(
      (/** @type {{ detail?: string }} */ { detail }) => detail === expected.detail,
    ),
    [{ level: "info", check: "artifact", artifact: ID, ...expected }],
  );
  // A note never changes a verdict: the phase is composed, a warning, in both doctors.
  assert.equal(fromArtifacts.ok, fromDoctor.ok);

  // The text outputs print the note under the artifact's line, and doctor's names the ID once.
  assert.ok(artifactsText.stdout.includes(`  ${expected.detail}\n`), artifactsText.stdout);
  assert.match(
    doctorText.stdout,
    new RegExp(
      `^Artifacts:\\n {2}The recipe selects ${ID}[^\\n]*\\n {4}${SKILL.replaceAll(".", "\\.")} already exists`,
      "m",
    ),
  );
  assert.deepEqual(listingViolations(`${doctorText.stdout}${doctorText.stderr}`, [ID]), []);
});
