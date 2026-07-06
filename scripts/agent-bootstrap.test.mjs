import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";

import { agentBootstrap, parseArgs } from "../src/index.js";

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
