// Issue #830: `--init` brings a guidance file up to date when the file holds the text an earlier
// Calavera release wrote, and keeps a file the person edited. Calavera does not record these files
// in .calavera/state.json, so the only evidence that a file is an older template is that its text
// equals what a release wrote. The texts come from the committed release fixtures in
// fixtures/agent-guidance, which earlier-guidance-table.test.mjs checks against the digests the CLI
// holds.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { agentBootstrap } from "../src/index.js";
import {
  EXISTING_AGENTS,
  FALLBACK_FILE,
  MCP_FILE,
  currentText,
  epochs,
  guidanceText,
  inTemporaryProject,
  mcpText,
  olderGuidanceEpochs,
  packageManagers,
  writeFiles,
} from "./earlier-guidance-fixtures.mjs";
import { copyReleaseFixture } from "./vite-plus-fixtures.mjs";

/** The change a run reported for `path`. */
function changeFor(result, path) {
  return result.changes.find((change) => change.path === path);
}

const bootstrapOptions = { mcpHarness: /** @type {const} */ ("skip"), agentsMd: "fallback" };

test("Given an AGENTS.md that an earlier release wrote as a whole file, when --init runs, then it is replaced with the current guidance", async () => {
  const current = await currentText("pnpm");
  for (const { id, releases } of olderGuidanceEpochs) {
    await inTemporaryProject("pnpm", async (directory) => {
      await writeFiles(directory, { "AGENTS.md": await guidanceText(id) });

      const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

      assert.equal(await readFile("AGENTS.md", "utf8"), current.agents, `release ${releases[0]}`);
      const change = changeFor(result, "AGENTS.md");
      assert.equal(change?.type, "update", `release ${releases[0]}`);
      assert.match(change?.reason ?? "", /earlier Calavera release/);
      assert.equal(changeFor(result, FALLBACK_FILE), undefined);
    });
  }
});

test("Given an AGENTS.calavera.md that an earlier release wrote, when --init runs, then it is replaced with the current guidance", async () => {
  const current = await currentText("pnpm");
  for (const { id, releases } of olderGuidanceEpochs) {
    await inTemporaryProject("pnpm", async (directory) => {
      await writeFiles(directory, {
        "AGENTS.md": EXISTING_AGENTS,
        [FALLBACK_FILE]: await guidanceText(id),
      });

      const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

      assert.equal(
        await readFile(FALLBACK_FILE, "utf8"),
        current.fallback,
        `release ${releases[0]}`,
      );
      assert.equal(await readFile("AGENTS.md", "utf8"), EXISTING_AGENTS);
      const change = changeFor(result, FALLBACK_FILE);
      assert.equal(change?.type, "update", `release ${releases[0]}`);
      assert.match(change?.reason ?? "", /earlier Calavera release/);
    });
  }
});

test("Given an .agents/calavera/mcp.md that an earlier release wrote, when --init runs, then it is replaced with the current setup notes", async () => {
  for (const packageManager of packageManagers) {
    const current = await currentText(packageManager);
    for (const { id, releases } of epochs.mcp) {
      await inTemporaryProject(packageManager, async (directory) => {
        await writeFiles(directory, { [MCP_FILE]: await mcpText(id, packageManager, releases[0]) });

        const result = await agentBootstrap({ ...bootstrapOptions, packageManager });

        assert.equal(
          await readFile(MCP_FILE, "utf8"),
          current.mcp,
          `${packageManager}, release ${releases[0]}`,
        );
        const change = changeFor(result, MCP_FILE);
        assert.equal(change?.type, "update", `${packageManager}, release ${releases[0]}`);
        assert.match(change?.reason ?? "", /earlier Calavera release/);
      });
    }
  }
});

test("Given an older template with Windows line endings, when --init runs, then it is still recognized and replaced", async () => {
  const current = await currentText("pnpm");
  const { id } = olderGuidanceEpochs[2];
  const { id: mcpId, releases } = epochs.mcp[2];
  await inTemporaryProject("pnpm", async (directory) => {
    await writeFiles(directory, {
      "AGENTS.md": (await guidanceText(id)).replaceAll("\n", "\r\n"),
    });
    await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });
    assert.equal(await readFile("AGENTS.md", "utf8"), current.agents);
  });
  await inTemporaryProject("pnpm", async (directory) => {
    await writeFiles(directory, {
      "AGENTS.md": EXISTING_AGENTS,
      [MCP_FILE]: (await mcpText(mcpId, "pnpm", releases[0])).replaceAll("\n", "\r\n"),
    });
    await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });
    assert.equal(await readFile(MCP_FILE, "utf8"), current.mcp);
  });
});

test("Given a dry run, when a guidance file holds an older template, then --init reports the update and writes nothing", async () => {
  const { id } = olderGuidanceEpochs[0];
  const older = await guidanceText(id);
  await inTemporaryProject("pnpm", async (directory) => {
    await writeFiles(directory, { "AGENTS.md": older });

    const result = await agentBootstrap({
      ...bootstrapOptions,
      packageManager: "pnpm",
      dryRun: true,
    });

    assert.equal(changeFor(result, "AGENTS.md")?.type, "update");
    assert.equal(await readFile("AGENTS.md", "utf8"), older);
  });
});

test("Given an AGENTS.md written by an earlier release and then edited, when --init runs, then it is kept and reported", async () => {
  for (const { id, releases } of olderGuidanceEpochs) {
    const older = await guidanceText(id);
    for (const [label, edited] of [
      ["a line appended", `${older}\nOur own rule.\n`],
      ["a word changed", older.replace("Use Calavera", "Use calavera")],
      ["a line removed", older.replace(/^- Inspect existing.*\n/m, "")],
    ]) {
      assert.notEqual(edited, older, `${label} must edit the text`);
      await inTemporaryProject("pnpm", async (directory) => {
        await writeFiles(directory, { "AGENTS.md": edited });

        const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

        assert.equal(await readFile("AGENTS.md", "utf8"), edited, `${label}, ${releases[0]}`);
        assert.deepEqual(changeFor(result, "AGENTS.md"), {
          type: "skip",
          path: "AGENTS.md",
          reason: "Calavera guidance already present.",
        });
      });
    }
  }
});

test("Given an AGENTS.calavera.md written by an earlier release and then edited, when --init runs, then it is kept and reported", async () => {
  for (const { id, releases } of olderGuidanceEpochs) {
    const older = await guidanceText(id);
    for (const [label, edited] of [
      ["a line appended", `${older}\nOur own rule.\n`],
      ["a word changed", older.replace("Use Calavera", "Use calavera")],
    ]) {
      await inTemporaryProject("pnpm", async (directory) => {
        await writeFiles(directory, { "AGENTS.md": EXISTING_AGENTS, [FALLBACK_FILE]: edited });

        const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

        assert.equal(await readFile(FALLBACK_FILE, "utf8"), edited, `${label}, ${releases[0]}`);
        assert.deepEqual(changeFor(result, FALLBACK_FILE), {
          type: "skip",
          path: FALLBACK_FILE,
          reason: "Existing fallback Calavera guidance differs and was left unchanged.",
        });
      });
    }
  }
});

test("Given an .agents/calavera/mcp.md written by an earlier release and then edited, when --init runs, then it is kept and reported", async () => {
  for (const { id, releases } of epochs.mcp) {
    const older = await mcpText(id, "pnpm", releases[0]);
    for (const [label, edited] of [
      ["a line appended", `${older}\nOur own note.\n`],
      ["a word changed", older.replace("Calavera", "Calaveras")],
    ]) {
      await inTemporaryProject("pnpm", async (directory) => {
        await writeFiles(directory, { "AGENTS.md": EXISTING_AGENTS, [MCP_FILE]: edited });

        const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

        assert.equal(await readFile(MCP_FILE, "utf8"), edited, `${label}, ${releases[0]}`);
        assert.deepEqual(changeFor(result, MCP_FILE), {
          type: "skip",
          path: MCP_FILE,
          reason: "Existing Calavera MCP setup notes differ and were left unchanged.",
        });
      });
    }
  }
});

test("Given an .agents/calavera/mcp.md whose pinned version no release used, when --init runs, then it is kept as an edit", async () => {
  const { id } = epochs.mcp[epochs.mcp.length - 1];
  for (const version of ["6.0.5", "99.0.0", "5.0.0-next.1"]) {
    const edited = await mcpText(id, "pnpm", version);
    await inTemporaryProject("pnpm", async (directory) => {
      await writeFiles(directory, { "AGENTS.md": EXISTING_AGENTS, [MCP_FILE]: edited });

      const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

      assert.equal(await readFile(MCP_FILE, "utf8"), edited, version);
      assert.equal(changeFor(result, MCP_FILE)?.type, "skip", version);
    });
  }
});

test("Given a whole-file AGENTS.md with the marker but text no release wrote, when --init runs, then it is kept", async () => {
  await inTemporaryProject("pnpm", async (directory) => {
    const ours = "<!-- calavera-agent-bootstrap -->\n\n# Our guidance\n\nWe rewrote this.\n";
    await writeFiles(directory, { "AGENTS.md": ours });

    const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

    assert.equal(await readFile("AGENTS.md", "utf8"), ours);
    assert.equal(changeFor(result, "AGENTS.md")?.type, "skip");
  });
});

/**
 * Runs the project's own `vp fmt` with `args`, as `vp check` does.
 *
 * @param {string} root
 * @param {string[]} args
 */
function vpFmt(root, args) {
  return spawnSync(
    process.execPath,
    [join(root, "node_modules/vite-plus/bin/vp"), "fmt", ...args],
    { cwd: root, encoding: "utf8" },
  );
}

/**
 * Runs `callback` with `directory` as the working directory, as the CLI runs.
 *
 * @template T
 * @param {string} directory
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function inDirectory(directory, callback) {
  const previous = process.cwd();
  process.chdir(directory);
  try {
    return await callback();
  } finally {
    process.chdir(previous);
  }
}

test("Given a Vite+ project whose AGENTS.md is an earlier template, when --init runs, then vp fmt --check passes for it", async () => {
  // The first release wrote no blank line after the marker, so vp fmt --check rejects its text.
  const { id } = olderGuidanceEpochs[olderGuidanceEpochs.length - 1];
  await using project = await copyReleaseFixture("library");
  await writeFile(join(project.root, "AGENTS.md"), await guidanceText(id));
  assert.notEqual(
    vpFmt(project.root, ["--check", "AGENTS.md"]).status,
    0,
    "the earlier template must fail the check, or this test proves nothing",
  );

  await inDirectory(project.root, () =>
    agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm", assumeYes: true }),
  );

  const check = vpFmt(project.root, ["--check", "AGENTS.md"]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
});

test("Given a Vite+ project whose guidance files are earlier templates, when --init runs, then vp fmt --check passes for them", async () => {
  const { id } = olderGuidanceEpochs[0];
  const mcp = epochs.mcp[0];
  await using project = await copyReleaseFixture("library");
  await writeFiles(project.root, {
    "AGENTS.md": EXISTING_AGENTS,
    [FALLBACK_FILE]: await guidanceText(id),
    [MCP_FILE]: await mcpText(mcp.id, "pnpm", mcp.releases[0]),
  });

  await inDirectory(project.root, () =>
    agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm", assumeYes: true }),
  );

  const check = vpFmt(project.root, ["--check", "AGENTS.md", FALLBACK_FILE, MCP_FILE]);
  assert.equal(check.status, 0, `vp fmt --check failed:\n${check.stdout}${check.stderr}`);
  assert.notEqual(
    await readFile(join(project.root, FALLBACK_FILE), "utf8"),
    await guidanceText(id),
  );
});

test("Given a guidance file that already holds the current text, when --init runs, then it is reported as up to date and not written", async () => {
  const current = await currentText("pnpm");
  await inTemporaryProject("pnpm", async (directory) => {
    await writeFiles(directory, {
      "AGENTS.md": EXISTING_AGENTS,
      [FALLBACK_FILE]: current.fallback,
      [MCP_FILE]: current.mcp,
    });

    const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

    for (const path of [FALLBACK_FILE, MCP_FILE]) {
      assert.deepEqual(changeFor(result, path), {
        type: "skip",
        path,
        reason: "Already up to date.",
      });
    }
  });
});

test("Given a dry run, when the fallback guidance and the setup notes are earlier templates, then --init reports both updates and writes neither", async () => {
  const older = await guidanceText(olderGuidanceEpochs[0].id);
  const mcp = epochs.mcp[0];
  const olderMcp = await mcpText(mcp.id, "pnpm", mcp.releases[0]);
  await inTemporaryProject("pnpm", async (directory) => {
    await writeFiles(directory, {
      "AGENTS.md": EXISTING_AGENTS,
      [FALLBACK_FILE]: older,
      [MCP_FILE]: olderMcp,
    });

    const result = await agentBootstrap({
      ...bootstrapOptions,
      packageManager: "pnpm",
      dryRun: true,
    });

    assert.equal(changeFor(result, FALLBACK_FILE)?.type, "update");
    assert.equal(changeFor(result, MCP_FILE)?.type, "update");
    assert.equal(await readFile(FALLBACK_FILE, "utf8"), older);
    assert.equal(await readFile(MCP_FILE, "utf8"), olderMcp);
  });
});

test("Given a project that configures MCP for its harness, when .agents/calavera/mcp.md holds an earlier template, then --init leaves it alone", async () => {
  const mcp = epochs.mcp[0];
  const olderMcp = await mcpText(mcp.id, "pnpm", mcp.releases[0]);
  await inTemporaryProject("pnpm", async (directory) => {
    await writeFiles(directory, { "AGENTS.md": EXISTING_AGENTS, [MCP_FILE]: olderMcp });

    const result = await agentBootstrap({
      packageManager: "pnpm",
      agentsMd: "fallback",
      mcpHarness: "claude-code",
    });

    assert.equal(changeFor(result, MCP_FILE), undefined);
    assert.equal(await readFile(MCP_FILE, "utf8"), olderMcp);
  });
});

test("Given an .agents/calavera/mcp.md with one pin edited into the placeholder this module hashes with, when --init runs, then it is kept", async () => {
  const { id, releases } = epochs.mcp[epochs.mcp.length - 1];
  const older = await mcpText(id, "npm", releases[0]);
  const edited = older.replace(
    `create-project-calavera@${releases[0]}`,
    "create-project-calavera@{{version}}",
  );
  assert.notEqual(edited, older);
  await inTemporaryProject("npm", async (directory) => {
    await writeFiles(directory, { "AGENTS.md": EXISTING_AGENTS, [MCP_FILE]: edited });

    const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "npm" });

    assert.equal(await readFile(MCP_FILE, "utf8"), edited);
    assert.equal(changeFor(result, MCP_FILE)?.type, "skip");
  });
});

test("Given an earlier template changed only in whitespace or encoding, when --init runs, then each file is kept", async () => {
  const older = await guidanceText(olderGuidanceEpochs[0].id);
  const variants = {
    "a byte order mark": `\uFEFF${older}`,
    "trailing space": older.replace("tooling.\n", "tooling. \n"),
    "a missing final newline": older.trimEnd(),
    "an extra final newline": `${older}\n`,
    "a lone carriage return": older.replaceAll("\n", "\r"),
    "a tab": older.replace("- Use", "-\tUse"),
  };
  for (const [label, edited] of Object.entries(variants)) {
    assert.notEqual(edited, older, label);
    await inTemporaryProject("pnpm", async (directory) => {
      await writeFiles(directory, { "AGENTS.md": edited });

      const result = await agentBootstrap({ ...bootstrapOptions, packageManager: "pnpm" });

      assert.equal(await readFile("AGENTS.md", "utf8"), edited, label);
      assert.equal(changeFor(result, "AGENTS.md")?.type, "skip", label);
    });
  }
});

test("Given --agents-md=append and a whole-file AGENTS.md from an earlier release, when --init runs, then the file is replaced and no section is appended", async () => {
  const current = await currentText("pnpm");
  await inTemporaryProject("pnpm", async (directory) => {
    await writeFiles(directory, { "AGENTS.md": await guidanceText(olderGuidanceEpochs[0].id) });

    const result = await agentBootstrap({
      mcpHarness: "skip",
      packageManager: "pnpm",
      agentsMd: "append",
    });

    assert.equal(await readFile("AGENTS.md", "utf8"), current.agents);
    assert.equal(changeFor(result, "AGENTS.md")?.type, "update");
  });
});
