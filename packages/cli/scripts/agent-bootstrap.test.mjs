import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { agentBootstrap, parseArgs } from "../src/index.js";

const binPath = fileURLToPath(new URL("../src/index.js", import.meta.url));

/**
 * Runs the real CLI in a directory.
 *
 * @param {string} cwd
 * @param {string[]} args
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runCli(cwd, args) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [binPath, ...args],
      { cwd, env: { ...process.env, NO_COLOR: "1" } },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

async function withTempProject(run) {
  const previousCwd = process.cwd();
  const projectDirectory = await mkdtemp(join(tmpdir(), "calavera-agent-bootstrap-"));

  process.chdir(projectDirectory);

  try {
    await run(projectDirectory);
  } finally {
    process.chdir(previousCwd);
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

test("parseArgs accepts an explicit AGENTS.md handling mode", () => {
  assert.equal(parseArgs(["--init", "--agents-md=append"]).agentsMd, "append");
  assert.equal(parseArgs(["--init", "--agents-md=fallback"]).agentsMd, "fallback");
  assert.throws(() => parseArgs(["--init", "--agents-md=overwrite"]), /Invalid agents-md/);
});

test("parseArgs accepts npm-create forwarded agent bootstrap flags", () => {
  assert.equal(parseArgs(["--", "--init"]).command, "agent-init");
  assert.equal(parseArgs(["--", "--init", "--dry-run", "--json"]).command, "agent-init");
});

test("parseArgs accepts conventional help commands", () => {
  assert.equal(parseArgs(["--help"]).command, "help");
  assert.equal(parseArgs(["-h"]).command, "help");
  assert.equal(parseArgs(["help"]).command, "help");
  assert.equal(parseArgs(["--", "--help"]).command, "help");
});

test("agent bootstrap keeps scripted existing AGENTS.md handling non-destructive", async () => {
  await withTempProject(async () => {
    await writeFile("AGENTS.md", "# Existing project guidance\n");

    const result = await agentBootstrap({ dryRun: true, json: true });

    assert.equal(result.dryRun, true);
    assert.ok(
      result.changes.some(
        (change) =>
          change.type === "skip" &&
          change.path === "AGENTS.md" &&
          change.reason?.includes("left unchanged"),
      ),
    );
    assert.ok(
      result.changes.some(
        (change) => change.type === "write" && change.path === "AGENTS.calavera.md",
      ),
    );
    assert.equal(await readFile("AGENTS.md", "utf8"), "# Existing project guidance\n");
    await assert.rejects(readFile("AGENTS.calavera.md", "utf8"), { code: "ENOENT" });
  });
});

test("agent bootstrap writes MCP-first guardrails", async () => {
  await withTempProject(async () => {
    const result = await agentBootstrap();
    const agentsMd = await readFile("AGENTS.md", "utf8");
    const mcpNotes = await readFile(".agents/calavera/mcp.md", "utf8");

    assert.match(result.nextPrompt, /First verify that the Calavera MCP tools are available/);
    assert.match(agentsMd, /Verify the Calavera MCP tools are available/);
    assert.match(agentsMd, /Do not inspect npm cache internals/);
    assert.match(mcpNotes, /Confirm the Calavera tools are visible before/);
    assert.match(mcpNotes, /Do not work around missing MCP tools by reading npm cache internals/);
    assert.match(mcpNotes, /Do not use it to bypass managed-file conflicts/);
    assert.match(mcpNotes, /npx --package create-project-calavera@/);
    assert.match(mcpNotes, /create-project-calavera --help/);
  });
});

test("agent bootstrap can append guidance to existing AGENTS.md", async () => {
  await withTempProject(async () => {
    await writeFile("AGENTS.md", "# Existing project guidance\n");

    const result = await agentBootstrap({ agentsMd: "append" });
    const agentsMd = await readFile("AGENTS.md", "utf8");

    assert.ok(
      result.changes.some((change) => change.type === "update" && change.path === "AGENTS.md"),
    );
    assert.match(agentsMd, /calavera-agent-bootstrap:start/);
    assert.match(agentsMd, /# Calavera Agent Guidance/);
    assert.doesNotMatch(agentsMd, /<!-- calavera-agent-bootstrap -->/);
    assert.doesNotMatch(agentsMd, /AGENTS\.calavera\.md/);
    assert.ok(result.pointers.includes("Agent guidance: AGENTS.md"));
    await assert.rejects(readFile("AGENTS.calavera.md", "utf8"), { code: "ENOENT" });
  });
});

test("agent bootstrap does not duplicate an existing Calavera guidance section", async () => {
  await withTempProject(async () => {
    await writeFile("AGENTS.md", "# Existing project guidance\n");

    await agentBootstrap({ agentsMd: "append" });
    const result = await agentBootstrap({ agentsMd: "append" });
    const agentsMd = await readFile("AGENTS.md", "utf8");
    const sectionCount = agentsMd.match(/calavera-agent-bootstrap:start/g)?.length ?? 0;

    assert.equal(sectionCount, 1);
    assert.ok(
      result.changes.some(
        (change) =>
          change.type === "skip" &&
          change.path === "AGENTS.md" &&
          change.reason?.includes("already up to date"),
      ),
    );
  });
});

test("--init prints the recipe next steps without a cd line", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile("package.json", JSON.stringify({ name: "demo", packageManager: "yarn@4.0.0" }));

    const result = await runCli(directory, ["--init", "--mcp-harness", "skip"]);

    assert.equal(result.code, 0, result.stderr);
    assert.ok(
      result.stdout.includes(
        [
          "Your project needs a recipe before Calavera changes anything.",
          `  Either: open ${directory} in your agent and use the prompt above.`,
          "  Or: compose one at https://calavera.schalkneethling.com/ and save",
          `      calavera.config.json into ${directory}, then:`,
          "        yarn dlx create-project-calavera apply --dry-run",
          "        yarn dlx create-project-calavera apply",
        ].join("\n"),
      ),
      result.stdout,
    );
    assert.doesNotMatch(result.stdout, /^\s*cd /m);
  });
});

test("--init --json carries the recipe next steps as nextSteps", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);

    const result = await runCli(directory, ["--init", "--json"]);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parsed.nextSteps, [
      "Your project needs a recipe before Calavera changes anything.",
      `  Either: open ${directory} in your agent and use the prompt above.`,
      "  Or: compose one at https://calavera.schalkneethling.com/ and save",
      `      calavera.config.json into ${directory}, then:`,
      "        npm create project-calavera apply -- --dry-run",
      "        npm create project-calavera apply",
    ]);
  });
});

test("--init names an existing recipe instead of asking for one", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile("calavera.config.json", "{}\n");

    const result = await runCli(directory, ["--init", "--json"]);
    const parsed = JSON.parse(result.stdout);

    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(parsed.nextSteps, [
      `Your project has a recipe at ${join(directory, "calavera.config.json")}. Calavera has not applied it.`,
      "  Preview it, then apply it after you approve the preview:",
      "    npm create project-calavera apply -- --dry-run",
      "    npm create project-calavera apply",
    ]);
  });
});
