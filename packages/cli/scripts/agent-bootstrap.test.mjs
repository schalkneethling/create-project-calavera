import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listingViolations } from "../../../scripts/rehearsal-checks.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";
import { AGENT_BOOTSTRAP_SECTION_START } from "../src/agent-bootstrap-files.js";
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
 * The files a run wrote, changed, or removed, compared the way the #918 rehearsal's init-output
 * check compares its snapshots (scripts/rehearsal-checks.mjs).
 *
 * @param {string} directory
 * @param {Record<string, string>} before A `snapshotDirectory` result from before the run.
 */
async function changedFiles(directory, before) {
  const after = await snapshotDirectory(directory);
  return Object.keys({ ...before, ...after })
    .filter((path) => before[path] !== after[path] && !path.endsWith("/"))
    .map((path) => path.replace(`${directory}/`, ""));
}

/** The note that asks for the fallback guidance to be merged into AGENTS.md (#601, #1020). */
const MERGE_NOTE = "Merge the fallback guidance listed under Changes into AGENTS.md by hand.";

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
    // Appended guidance needs no merge, so no pointer asks for one (#601).
    assert.ok(!result.pointers.includes(MERGE_NOTE), JSON.stringify(result.pointers));
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
        "  Wrote .calavera/state.json",
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

    const before = await snapshotDirectory(directory);
    const result = await runCli(directory, ["--init", "--mcp-harness", "skip"]);

    assert.equal(result.code, 0, result.stderr);
    // #1020: the #918 rehearsal checks that every file --init --mcp-harness skip writes is printed
    // once, under a heading, so the note that points to the MCP setup notes does not name the file
    // the Changes group already lists. Unlike the rehearsal, this project has no AGENTS.md.
    const written = await changedFiles(directory, before);
    assert.deepEqual(listingViolations(result.stdout, written), []);
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
        "  Wrote .calavera/state.json",
        "",
        "Notes:",
        "  Installed skills are available under .agents/skills/.",
        "  Skipped project MCP auto-config. Follow the MCP setup notes listed under Changes for manual setup.",
        "",
        ...initNextSteps(directory),
        "",
        ...(await nextPromptGroup()),
        "",
      ].join("\n"),
    );
  });
});

test("--init in a project that has AGENTS.md prints every file it writes once, as the #918 rehearsal checks (#1020)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({ name: "demo", packageManager: "pnpm@10.0.0" }),
    );
    // The Vite+ library scaffold the rehearsal runs --init in already has an AGENTS.md.
    await writeFile("AGENTS.md", "# Existing project guidance\n");
    const before = await snapshotDirectory(directory);

    // The rehearsal's init-output step runs exactly these arguments (scripts/rehearsal-checks.mjs).
    const result = await runCli(directory, ["--init", "--yes", "--mcp-harness", "skip"]);

    assert.equal(result.code, 0, result.stderr);
    const written = await changedFiles(directory, before);
    assert.ok(written.includes("AGENTS.calavera.md"), JSON.stringify(written));
    assert.deepEqual(listingViolations(result.stdout, written), []);
    assert.equal(
      result.stdout,
      [
        "Calavera agent bootstrap complete.",
        "",
        "Changes:",
        "  Wrote .agents/skills/calavera",
        "  Wrote .coderabbit.yaml",
        "  Skipped AGENTS.md: Existing AGENTS.md left unchanged; Calavera guidance was written separately.",
        "  Wrote AGENTS.calavera.md",
        "  Wrote .agents/calavera/mcp.md",
        "  Wrote .calavera/state.json",
        "",
        "Notes:",
        "  Installed skills are available under .agents/skills/.",
        `  ${MERGE_NOTE}`,
        "  Skipped project MCP auto-config. Follow the MCP setup notes listed under Changes for manual setup.",
        "",
        ...initNextSteps(directory),
        "",
        ...(await nextPromptGroup()),
        "",
      ].join("\n"),
    );
  });
});

test("--init re-run lists the skill and .coderabbit.yaml it leaves unchanged as skipped (#956)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile(
      "package.json",
      JSON.stringify({ name: "demo", packageManager: "pnpm@10.0.0" }),
    );
    const first = await runCli(directory, ["--init", "--mcp-harness", "skip"]);
    assert.equal(first.code, 0, first.stderr);

    for (const dryRun of [true, false]) {
      const result = await runCli(directory, [
        "--init",
        "--mcp-harness",
        "skip",
        ...(dryRun ? ["--dry-run"] : []),
      ]);

      assert.equal(result.code, 0, result.stderr);
      // .calavera/state.json is left out when it is unchanged (#957); every other file the first
      // run wrote is named once, as the #918 rehearsal's listing check requires.
      assert.deepEqual(
        listingViolations(result.stdout, [
          ".agents/skills/calavera",
          ".coderabbit.yaml",
          "AGENTS.md",
          ".agents/calavera/mcp.md",
        ]),
        [],
      );
      const skipped = dryRun ? "Would skip" : "Skipped";
      assert.equal(
        result.stdout,
        [
          dryRun
            ? "Calavera agent bootstrap dry run complete. No files were changed."
            : "Calavera agent bootstrap complete.",
          "",
          "Changes:",
          `  ${skipped} .agents/skills/calavera: Already up to date.`,
          `  ${skipped} .coderabbit.yaml: Already up to date.`,
          `  ${skipped} AGENTS.md: Already up to date.`,
          `  ${skipped} .agents/calavera/mcp.md: Already up to date.`,
          "",
          "Notes:",
          "  Installed skills are available under .agents/skills/.",
          "  Skipped project MCP auto-config. Follow the MCP setup notes listed under Changes for manual setup.",
          "",
          ...initNextSteps(directory),
          "",
          ...(await nextPromptGroup()),
          "",
        ].join("\n"),
      );
    }
  });
});

test("--init names a .coderabbit.yaml it would add filters to without an empty reason (#956)", async () => {
  await withTempProject(async (projectDirectory) => {
    const directory = await realpath(projectDirectory);
    await writeFile(".coderabbit.yaml", "reviews:\n  profile: chill\n");

    const result = await runCli(directory, ["--init", "--dry-run", "--mcp-harness", "skip"]);

    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.includes("\n  Would update .coderabbit.yaml\n"), result.stdout);
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
        "  Would write .calavera/state.json",
        "",
        "Notes:",
        "  Installed skills are available under .agents/skills/.",
        `  ${MERGE_NOTE}`,
        "  Skipped project MCP auto-config. Follow the MCP setup notes listed under Changes for manual setup.",
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
      "Could not write project MCP config at .mcp.json: .mcp.json mcpServers must be an object. Follow the MCP setup notes listed under Changes for manual setup.",
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
    assert.ok(!result.pointers.includes(MERGE_NOTE), JSON.stringify(result.pointers));
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
    assert.ok(result.pointers.includes(MERGE_NOTE), JSON.stringify(result.pointers));
  });
});

test("--init lists .calavera/state.json once when it updates it, and not when it is unchanged (#957)", async () => {
  await withTempProject(async () => {
    const first = await agentBootstrap({ mcpHarness: "skip" });
    assert.deepEqual(
      first.changes.filter((change) => change.path === ".calavera/state.json"),
      [{ type: "write", path: ".calavera/state.json" }],
    );

    const unchanged = await agentBootstrap({ mcpHarness: "skip" });
    assert.equal(
      unchanged.changes.filter((change) => change.path === ".calavera/state.json").length,
      0,
    );

    // The same record in another layout is text the bootstrap rewrites, so it is an update.
    const written = await readFile(".calavera/state.json", "utf8");
    await writeFile(".calavera/state.json", JSON.stringify(JSON.parse(written)));

    const dryRun = await agentBootstrap({ mcpHarness: "skip", dryRun: true });
    const updated = await agentBootstrap({ mcpHarness: "skip" });
    for (const result of [dryRun, updated]) {
      assert.deepEqual(
        result.changes.filter((change) => change.path === ".calavera/state.json"),
        [
          {
            type: "update",
            path: ".calavera/state.json",
            reason: "Brought up to date.",
          },
        ],
      );
    }
    assert.equal(await readFile(".calavera/state.json", "utf8"), written);
  });
});

// #1039: Ctrl+C at a prompt ends the run through exitIfCancel's process.exit(0), so nothing after
// the prompt runs. The stand-in prompts below end the run the same way, by throwing, so a file the
// bootstrap wrote before the prompt is still there when the test looks.

const CANCELLED = new Error("the person cancelled at the prompt");

/**
 * Runs the bootstrap, in a terminal unless `terminal` is false, answering each prompt from
 * `answers`; a prompt whose answer is CANCELLED ends the run there. It returns the prompts asked,
 * in order, and the error that ended the run, if any.
 *
 * @param {{ guidanceMode?: "append" | "fallback" | Error, mcpHarness?: string | Error }} answers
 * @param {{ options?: Record<string, unknown>, terminal?: boolean }} [setup]
 */
async function bootstrapInTerminal(answers, { options = {}, terminal = true } = {}) {
  /** @type {string[]} */
  const asked = [];
  const answer = (prompt) => async () => {
    asked.push(prompt);
    if (answers[prompt] instanceof Error) throw answers[prompt];
    return answers[prompt];
  };
  const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
  Object.defineProperty(process.stdin, "isTTY", { value: terminal, configurable: true });
  try {
    const result = await agentBootstrap(options, {
      ask: { guidanceMode: answer("guidanceMode"), mcpHarness: answer("mcpHarness") },
    });
    return { asked, result };
  } catch (error) {
    return { asked, error };
  } finally {
    if (original) Object.defineProperty(process.stdin, "isTTY", original);
    else delete process.stdin.isTTY;
  }
}

test("cancelling interactive agent-init at the AGENTS.md prompt leaves the project unchanged (#1039)", async () => {
  await withTempProject(async (directory) => {
    await writeFile("AGENTS.md", "# Existing project guidance\n");
    const before = await snapshotDirectory(directory);

    const { asked, error } = await bootstrapInTerminal({ guidanceMode: CANCELLED });

    assert.equal(error, CANCELLED);
    assert.deepEqual(asked, ["guidanceMode"]);
    assert.deepEqual(await snapshotDirectory(directory), before);
  });
});

test("cancelling interactive agent-init at the MCP harness prompt leaves the project unchanged (#1039)", async () => {
  for (const agentsMd of [undefined, "# Existing project guidance\n"]) {
    await withTempProject(async (directory) => {
      if (agentsMd) await writeFile("AGENTS.md", agentsMd);
      const before = await snapshotDirectory(directory);

      const { asked, error } = await bootstrapInTerminal({
        guidanceMode: "append",
        mcpHarness: CANCELLED,
      });

      assert.equal(error, CANCELLED);
      assert.deepEqual(asked, agentsMd ? ["guidanceMode", "mcpHarness"] : ["mcpHarness"]);
      assert.deepEqual(await snapshotDirectory(directory), before, `AGENTS.md: ${agentsMd}`);
    });
  }
});

test("interactive agent-init uses the answers it asks for before writing (#1039)", async () => {
  await withTempProject(async () => {
    await writeFile("AGENTS.md", "# Existing project guidance\n");

    const { asked, result } = await bootstrapInTerminal({
      guidanceMode: "append",
      mcpHarness: "claude-code",
    });

    assert.deepEqual(asked, ["guidanceMode", "mcpHarness"]);
    assert.equal(result.mcp.action, "write");
    const agentsMd = await readFile("AGENTS.md", "utf8");
    assert.ok(agentsMd.startsWith("# Existing project guidance\n"));
    assert.ok(agentsMd.includes(AGENT_BOOTSTRAP_SECTION_START));
    assert.ok(JSON.parse(await readFile(".mcp.json", "utf8")).mcpServers);
    assert.ok(JSON.parse(await readFile(".calavera/state.json", "utf8")));
  });
});

test("interactive agent-init does not ask about an AGENTS.md that already holds Calavera guidance (#1039)", async () => {
  // A whole-file AGENTS.md holds the marker; an appended section holds only the section markers.
  for (const existing of [undefined, "# Existing project guidance\n"]) {
    await withTempProject(async () => {
      if (existing) await writeFile("AGENTS.md", existing);
      await agentBootstrap({ agentsMd: "append", mcpHarness: "skip" });

      const { asked, error } = await bootstrapInTerminal({ mcpHarness: "skip" });

      assert.equal(error, undefined);
      assert.deepEqual(asked, ["mcpHarness"], `AGENTS.md: ${existing}`);
    });
  }
});

test("agent-init asks nothing when flags answer both questions or no terminal is attached (#1039)", async () => {
  for (const setup of [
    { options: { agentsMd: "append", mcpHarness: "claude-code" } },
    { terminal: false },
  ]) {
    await withTempProject(async () => {
      await writeFile("AGENTS.md", "# Existing project guidance\n");

      const { asked, result } = await bootstrapInTerminal(
        { guidanceMode: CANCELLED, mcpHarness: CANCELLED },
        setup,
      );

      assert.deepEqual(asked, [], JSON.stringify(setup));
      assert.equal(result.mcp.harness, setup.options ? "claude-code" : "skip");
      assert.equal(
        (await readFile("AGENTS.md", "utf8")).includes(AGENT_BOOTSTRAP_SECTION_START),
        Boolean(setup.options),
        "append writes the marked section; a run without a terminal writes the fallback file",
      );
    });
  }
});
