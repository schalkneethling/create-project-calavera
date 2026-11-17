import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { agentBootstrap, parseArgs } from "../src/index.js";
import {
  NEXT_PROMPT_HEADING,
  printedNextPrompt,
  readmeAgentPrompt,
  readRepositoryFile,
} from "./readme-agent-prompt.mjs";

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

    assert.equal(result.nextPrompt, await readmeAgentPrompt());
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
    // Appended guidance needs no merge, so no pointer names the fallback file (#601).
    assert.ok(!result.pointers.some((pointer) => pointer.includes("AGENTS.calavera.md")));
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

test("--init prints the agent prompt from the README, word for word (#840)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);

    const result = await runCli(directory, ["--init", "--mcp-harness", "skip"]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(printedNextPrompt(result.stdout), await readmeAgentPrompt());
  });
});

test("the agent-first workflow guide quotes the README's agent prompt (#840)", async () => {
  const guide = await readRepositoryFile("docs/agent-first-calavera-workflow.md");

  assert.ok(guide.includes(`\n${await readmeAgentPrompt()}\n`), "the guide's prompt block differs");
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
          `  Either: open ${directory} in your agent and use the prompt below.`,
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
      `  Either: open ${directory} in your agent and use the prompt below.`,
      "  Or: compose one at https://calavera.schalkneethling.com/ and save",
      `      calavera.config.json into ${directory}, then:`,
      "        npm create project-calavera apply -- --dry-run",
      "        npm create project-calavera apply",
    ]);
  });
});

test("--init with an existing recipe prints its preview and apply commands without a cd line, before the prompt (#602)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({ name: "demo", packageManager: "pnpm@10.0.0" }),
    );
    await writeFile("calavera.config.json", "{}\n");

    const result = await runCli(directory, ["--init", "--mcp-harness", "skip"]);
    const nextSteps = result.stdout.indexOf("Next steps:");

    assert.equal(result.code, 0, result.stderr);
    assert.notEqual(nextSteps, -1, result.stdout);
    assert.equal(
      result.stdout.slice(nextSteps),
      [
        "Next steps:",
        `Your project has a recipe at ${join(directory, "calavera.config.json")}. Calavera has not applied it.`,
        "  Preview it, then apply it after you approve the preview:",
        "    pnpm dlx create-project-calavera apply --dry-run",
        "    pnpm dlx create-project-calavera apply",
        "",
        ...(await nextPromptGroup()),
        "",
      ].join("\n"),
    );
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

/**
 * The next-steps group --init prints for a pnpm project without a recipe.
 *
 * @param {string} directory
 * @returns {string[]}
 */
function initNextSteps(directory) {
  return [
    "Next steps:",
    "Your project needs a recipe before Calavera changes anything.",
    `  Either: open ${directory} in your agent and use the prompt below.`,
    "  Or: compose one at https://calavera.schalkneethling.com/ and save",
    `      calavera.config.json into ${directory}, then:`,
    "        pnpm dlx create-project-calavera apply --dry-run",
    "        pnpm dlx create-project-calavera apply",
  ];
}

/**
 * The prompt group: a heading, then the prompt alone on its own line between blank lines, so it
 * can be copied whole.
 *
 * @returns {Promise<string[]>}
 */
async function nextPromptGroup() {
  return [NEXT_PROMPT_HEADING, "", await readmeAgentPrompt(), ""];
}

test("--init groups the summary and names each file once when it writes the MCP config (#601)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({ name: "demo", packageManager: "pnpm@10.0.0" }),
    );

    const result = await runCli(directory, ["--init", "--mcp-harness", "claude-code"]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "Calavera agent bootstrap complete.",
        "",
        "Changes:",
        "  Wrote .agents/skills/calavera",
        "  Wrote .coderabbit.yaml",
        "  Wrote AGENTS.md",
        "  Wrote .mcp.json",
        "",
        "Notes:",
        "  Installed skills are available under .agents/skills/.",
        "",
        ...initNextSteps(directory),
        "",
        ...(await nextPromptGroup()),
        "",
      ].join("\n"),
    );
  });
});

test("--init groups the summary when MCP needs manual setup (#601)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({ name: "demo", packageManager: "pnpm@10.0.0" }),
    );

    const result = await runCli(directory, ["--init", "--mcp-harness", "skip"]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "Calavera agent bootstrap complete.",
        "",
        "Changes:",
        "  Wrote .agents/skills/calavera",
        "  Wrote .coderabbit.yaml",
        "  Wrote AGENTS.md",
        "  Wrote .agents/calavera/mcp.md",
        "",
        "Notes:",
        "  Installed skills are available under .agents/skills/.",
        "  Skipped project MCP auto-config. Follow .agents/calavera/mcp.md for manual setup.",
        "",
        ...initNextSteps(directory),
        "",
        ...(await nextPromptGroup()),
        "",
      ].join("\n"),
    );
  });
});

test("--init names a skipped AGENTS.md once and says to merge the fallback guidance (#601)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({ name: "demo", packageManager: "pnpm@10.0.0" }),
    );
    await writeFile("AGENTS.md", "# Existing project guidance\n");

    const result = await runCli(directory, [
      "--init",
      "--dry-run",
      "--mcp-harness",
      "skip",
      "--agents-md=fallback",
    ]);

    assert.equal(result.code, 0, result.stderr);
    assert.equal(
      result.stdout,
      [
        "Calavera agent bootstrap dry run complete. No files were changed.",
        "",
        "Changes:",
        "  Would write .agents/skills/calavera",
        "  Would write .coderabbit.yaml",
        "  Would skip AGENTS.md: Existing AGENTS.md left unchanged; Calavera guidance would be written separately.",
        "  Would write AGENTS.calavera.md",
        "  Would write .agents/calavera/mcp.md",
        "",
        "Notes:",
        "  Installed skills are available under .agents/skills/.",
        "  Merge AGENTS.calavera.md into AGENTS.md by hand.",
        "  Skipped project MCP auto-config. Follow .agents/calavera/mcp.md for manual setup.",
        "",
        ...initNextSteps(directory),
        "",
        ...(await nextPromptGroup()),
        "",
      ].join("\n"),
    );
  });
});

test("--init names an MCP config it could not write once, in a note with one period (#601)", async () => {
  await withTempProject(async () => {
    await writeFile(".mcp.json", JSON.stringify({ mcpServers: 3 }));

    const result = await agentBootstrap({ mcpHarness: "claude-code" });
    const mcpNote = result.pointers.find((pointer) => pointer.startsWith("Could not write"));

    assert.equal(result.mcp.action, "manual");
    assert.ok(mcpNote, JSON.stringify(result.pointers));
    assert.equal(
      mcpNote,
      "Could not write project MCP config at .mcp.json: .mcp.json mcpServers must be an object. Follow .agents/calavera/mcp.md for manual setup.",
    );
    assert.equal(result.changes.filter((change) => change.path === ".mcp.json").length, 0);
  });
});

test("--init does not ask for a merge of fallback guidance it left unchanged (#601)", async () => {
  await withTempProject(async () => {
    await writeFile("AGENTS.md", "# Existing project guidance\n");
    await writeFile("AGENTS.calavera.md", "# My own edits\n");

    const result = await agentBootstrap({ agentsMd: "fallback", mcpHarness: "skip" });

    assert.ok(
      result.changes.some(
        (change) => change.type === "skip" && change.path === "AGENTS.calavera.md",
      ),
    );
    assert.ok(!result.pointers.some((pointer) => pointer.includes("AGENTS.calavera.md")));
  });
});

test("--init keeps the merge note on a rerun before the generated fallback is merged (#601)", async () => {
  await withTempProject(async () => {
    await writeFile("AGENTS.md", "# Existing project guidance\n");
    await agentBootstrap({ agentsMd: "fallback", mcpHarness: "skip" });

    const result = await agentBootstrap({ agentsMd: "fallback", mcpHarness: "skip" });

    assert.ok(
      result.changes.some(
        (change) =>
          change.type === "skip" &&
          change.path === "AGENTS.calavera.md" &&
          change.reason === "Already up to date.",
      ),
      JSON.stringify(result.changes),
    );
    assert.ok(
      result.pointers.includes("Merge AGENTS.calavera.md into AGENTS.md by hand."),
      JSON.stringify(result.pointers),
    );
  });
});
