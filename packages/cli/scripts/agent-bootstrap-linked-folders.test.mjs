// #1231 (owner decision of 2026-11-23 on #1193): `agent-init`, `--init`, and `bootstrap` refuse to
// write through a symbolic link on the path of any folder the bootstrap writes into, before they
// write anything, with the message and remedy that install, update, and apply use. A dry run stops
// in the same place, so a refused run leaves the project and the link target byte-identical.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { agentBootstrap } from "../src/index.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const binPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

// The three names the CLI runs the bootstrap under (`runAgentBootstrap` in src/index.js).
const ENTRY_POINTS = [["agent-init"], ["--init"], ["bootstrap"]];

// Every folder the bootstrap writes into, each linked in turn: the base skill's folder and the
// folders above it, the folder of the manual MCP setup notes, which any harness falls back to when
// its MCP config cannot be written, and the folder of the state file.
const LINKED_FOLDERS = [
  ".agents",
  ".agents/skills",
  ".agents/skills/calavera",
  ".agents/calavera",
  ".calavera",
];

/** The message that refuses a write through the symbolic link at the project path `link`. */
function refusal(/** @type {string} */ link) {
  return `Calavera does not write artifacts through the symbolic link ${link}. Replace ${link} with a real folder, then run the command again.`;
}

/**
 * Runs the real CLI in `cwd`.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile(process.execPath, [binPath, ...args], { cwd }, (error, stdout, stderr) => {
      resolvePromise({
        code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
        stdout,
        stderr,
      });
    });
  });
}

/**
 * Runs `callback` with a new project that has a `package.json`, and a separate folder outside the
 * project for a link to point to. The outside folder holds a file, so a write into it, or its
 * removal, changes its snapshot.
 *
 * @param {(paths: { project: string, outside: string }) => Promise<void>} callback
 */
async function withProject(callback) {
  const project = await realpath(await mkdtemp(join(tmpdir(), "calavera-bootstrap-linked-")));
  const outside = await realpath(await mkdtemp(join(tmpdir(), "calavera-bootstrap-outside-")));
  try {
    await writeFile(join(project, "package.json"), '{ "name": "linked-folder-probe" }\n');
    await writeFile(join(outside, "kept.txt"), "kept\n");
    await callback({ project, outside });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
}

for (const link of LINKED_FOLDERS) {
  for (const entryPoint of ENTRY_POINTS) {
    for (const dryRun of [false, true]) {
      const args = [...entryPoint, ...(dryRun ? ["--dry-run"] : []), "--mcp-harness", "skip"];

      test(`${args.join(" ")} refuses to write through a linked ${link} and changes nothing`, async () => {
        await withProject(async ({ project, outside }) => {
          await mkdir(dirname(join(project, link)), { recursive: true });
          await symlink(outside, join(project, link));
          const projectBefore = await snapshotDirectory(project);
          const outsideBefore = await snapshotDirectory(outside);

          const result = await runCli(project, args);

          assert.notEqual(result.code, 0, result.stdout);
          assert.ok(result.stderr.includes(refusal(link)), result.stderr);
          assert.deepEqual(await snapshotDirectory(project), projectBefore);
          assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
        });
      });
    }
  }
}

// The bootstrap writes nothing into `.claude` (the Claude Code MCP config is `.mcp.json` at the
// project root), so a linked `.claude` is not refused, and its target stays byte-identical.
for (const entryPoint of ENTRY_POINTS) {
  const args = [...entryPoint, "--mcp-harness", "claude-code"];

  test(`${args.join(" ")} writes nothing through a linked .claude`, async () => {
    await withProject(async ({ project, outside }) => {
      await symlink(outside, join(project, ".claude"));
      const outsideBefore = await snapshotDirectory(outside);

      const result = await runCli(project, args);

      assert.equal(result.code, 0, result.stderr);
      assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
    });
  });
}

// The refusal comes before the prompts, so a person at a terminal is never asked a question for a
// run that is then refused. In a terminal with an AGENTS.md, both prompts would otherwise be asked.
test("agent-init in a terminal refuses a linked .agents before it asks anything", async () => {
  await withProject(async ({ project, outside }) => {
    await writeFile(join(project, "AGENTS.md"), "# Existing project guidance\n");
    await symlink(outside, join(project, ".agents"));
    const projectBefore = await snapshotDirectory(project);
    const outsideBefore = await snapshotDirectory(outside);
    /** @type {string[]} */
    const asked = [];
    const ask = (/** @type {string} */ prompt) => async () => {
      asked.push(prompt);
      throw new Error(`asked ${prompt} before the refusal`);
    };
    const previousCwd = process.cwd();
    const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    process.chdir(project);
    try {
      await assert.rejects(
        agentBootstrap(
          {},
          { ask: { guidanceMode: ask("guidanceMode"), mcpHarness: ask("mcpHarness") } },
        ),
        { message: refusal(".agents") },
      );
    } finally {
      process.chdir(previousCwd);
      if (original) Object.defineProperty(process.stdin, "isTTY", original);
      else delete process.stdin.isTTY;
    }

    assert.deepEqual(asked, []);
    assert.deepEqual(await snapshotDirectory(project), projectBefore);
    assert.deepEqual(await snapshotDirectory(outside), outsideBefore);
  });
});
