// Issue #1205: rerunning `--init` updates the `calavera` MCP entry only when it holds what a
// Calavera release wrote for that harness, with the pinned version normalized, as `eject` decides
// (ADR-0017, Decision 2). Any other entry is a local edit (brief C8): the bootstrap keeps it,
// lists the file as skipped with a remedy, and leaves the file byte for byte as it was.
//
// The entries are spelled out here, not built from the current writers, so a change to the
// writers cannot also change what counts as an earlier release's entry.
import assert from "node:assert/strict";
import { mkdir, mkdtempDisposable, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { agentBootstrap } from "../src/index.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const current = packageJson.version;

/** @param {string} version */
const pnpmLaunch = (version) => ({
  command: "pnpm",
  args: ["dlx", "--package", `create-project-calavera@${version}`, "create-project-calavera-mcp"],
});
/** @param {string} version */
const npmLaunch = (version) => ({
  command: "npx",
  args: ["--package", `create-project-calavera@${version}`, "create-project-calavera-mcp"],
});

/** @param {unknown} value */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const otherServer = { command: "node", args: ["server.js"] };

/**
 * @typedef {{ command: string, args: string[] }} Launch
 * @typedef {{ harness: "claude-code" | "cursor" | "opencode" | "codex", path: string, file: (calavera: Launch, extra?: Record<string, unknown>) => string }} Harness
 */

/** @type {Harness[]} */
const harnesses = [
  {
    harness: "claude-code",
    path: ".mcp.json",
    file: (launch, extra = {}) =>
      json({ mcpServers: { calavera: { ...launch, ...extra }, other: otherServer } }),
  },
  {
    harness: "cursor",
    path: ".cursor/mcp.json",
    file: (launch, extra = {}) =>
      json({ mcpServers: { calavera: { ...launch, ...extra }, other: otherServer } }),
  },
  {
    harness: "opencode",
    path: "opencode.json",
    file: (launch, extra = {}) =>
      json({
        $schema: "https://opencode.ai/config.json",
        mcp: {
          calavera: {
            type: "local",
            command: [launch.command, ...launch.args],
            enabled: true,
            ...extra,
          },
          other: { type: "local", command: ["node", "server.js"], enabled: true },
        },
      }),
  },
  {
    harness: "codex",
    path: ".codex/config.toml",
    file: (launch, extra = {}) =>
      [
        "[mcp_servers.calavera]",
        `command = ${JSON.stringify(launch.command)}`,
        `args = [${launch.args.map((arg) => JSON.stringify(arg)).join(", ")}]`,
        ...Object.entries(extra).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
        "",
        "[mcp_servers.other]",
        'command = "node"',
        "",
      ].join("\n"),
  },
];

/**
 * Runs `callback` inside a new temporary project.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-init-mcp-edits-"));
  const originalDirectory = process.cwd();
  process.chdir(await realpath(project.path));
  try {
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string} path @param {string} text */
async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** @param {Harness["harness"]} harness @param {boolean} [dryRun] */
const init = (harness, dryRun = false) =>
  agentBootstrap({ json: true, mcpHarness: harness, packageManager: "npm", dryRun });

/**
 * Asserts that the bootstrap kept the file as a local edit and said how to get Calavera's entry.
 *
 * @param {Awaited<ReturnType<typeof agentBootstrap>>} result
 * @param {string} path
 */
function assertKeptAsEdit(result, path) {
  assert.equal(result.mcp.action, "skip", path);
  const listed = result.changes.filter((change) => change.path === path);
  assert.equal(listed.length, 1, `${path} is listed once`);
  const [change] = listed;
  assert.equal(change?.type, "skip");
  // The reason names the entry first: "The calavera entry under …" or "The [mcp_servers.calavera] table".
  assert.match(
    change?.reason ?? "",
    /^The (calavera entry under mcp(Servers)? |\[mcp_servers\.calavera\] table )in /,
    path,
  );
  assert.match(change?.reason ?? "", /local edit/, path);
  assert.match(change?.reason ?? "", new RegExp(path.replaceAll(".", "\\.")), path);
  // The remedy: what to do to get Calavera's entry.
  assert.match(change?.reason ?? "", /remove .* then run --init again/i, path);
  assert.ok(!result.pointers.some((pointer) => pointer.includes(path)), "named once");
}

for (const { harness, path, file } of harnesses) {
  test(`${harness}: an entry an earlier release wrote for another package manager is updated`, async () => {
    await inProject(async () => {
      await write(path, file(pnpmLaunch("5.0.0")));

      const result = await init(harness);
      const text = await readFile(path, "utf8");

      assert.equal(result.mcp.action, "update");
      assert.doesNotMatch(text, /5\.0\.0|pnpm/);
      assert.ok(text.includes(`create-project-calavera@${current}`));
      assert.match(text, /"npx"/);
      assert.match(text, /other/, "the other server stays");
    });
  });

  test(`${harness}: an edited entry is kept as a local edit and reported with a remedy`, async () => {
    for (const dryRun of [true, false]) {
      await inProject(async () => {
        const before = file(npmLaunch(current), { env_note: "edited" });
        await write(path, before);

        const result = await init(harness, dryRun);

        assert.equal(await readFile(path, "utf8"), before, `${path} is unchanged`);
        assertKeptAsEdit(result, path);
      });
    }
  });

  test(`${harness}: an entry with an edited launch command is kept`, async () => {
    await inProject(async () => {
      const before = file({ command: "old-command", args: ["old-arg"] });
      await write(path, before);

      assertKeptAsEdit(await init(harness), path);
      assert.equal(await readFile(path, "utf8"), before);
    });
  });

  test(`${harness}: an entry that holds the version placeholder is kept`, async () => {
    // No release wrote the placeholder, so the entry was edited (see normalizePinnedVersion).
    await inProject(async () => {
      const before = file(npmLaunch("{{version}}"));
      await write(path, before);
      assertKeptAsEdit(await init(harness), path);
      assert.equal(await readFile(path, "utf8"), before);
    });
  });
}

test("codex: a calavera entry written as an inline table is kept, never duplicated", async () => {
  await inProject(async () => {
    const before = [
      "[mcp_servers]",
      `calavera = { command = "npx", args = ["--package", "create-project-calavera@${current}", "create-project-calavera-mcp"] }`,
      "",
    ].join("\n");
    await write(".codex/config.toml", before);

    assertKeptAsEdit(await init("codex"), ".codex/config.toml");
    assert.equal(await readFile(".codex/config.toml", "utf8"), before);
  });
});

test("codex: a subtable added under the calavera table makes the entry edited", async () => {
  await inProject(async () => {
    const before = `${harnesses[3]?.file(pnpmLaunch("5.0.0"))}\n[mcp_servers.calavera.env]\nNOTE = "kept"\n`;
    await write(".codex/config.toml", before);

    assertKeptAsEdit(await init("codex"), ".codex/config.toml");
    assert.equal(await readFile(".codex/config.toml", "utf8"), before);
  });
});

test("codex: a comment inside the calavera table makes the entry edited", async () => {
  await inProject(async () => {
    const before = [
      "[mcp_servers.calavera]",
      "# pinned on purpose",
      'command = "pnpm"',
      'args = ["dlx", "--package", "create-project-calavera@5.0.0", "create-project-calavera-mcp"]',
      "",
    ].join("\n");
    await write(".codex/config.toml", before);

    assertKeptAsEdit(await init("codex"), ".codex/config.toml");
    assert.equal(await readFile(".codex/config.toml", "utf8"), before);
  });
});

test("codex: a file that is not TOML is left alone, and the reason never quotes it", async () => {
  await inProject(async () => {
    const before = '[mcp_servers.calavera]\ncommand = "npx"\ntoken = "secret-value\n';
    await write(".codex/config.toml", before);

    const result = await init("codex");

    assert.equal(result.mcp.action, "manual");
    assert.match(
      result.mcp.reason ?? "",
      /\.codex\/config\.toml cannot be parsed as TOML at line \d+, column \d+\. /,
    );
    assert.doesNotMatch(result.mcp.reason ?? "", /secret-value/);
    assert.equal(await readFile(".codex/config.toml", "utf8"), before);
  });
});

test("codex: a comment after Calavera's lines belongs to the next table and stays on update", async () => {
  await inProject(async () => {
    const before = [
      "[mcp_servers.calavera]",
      'command = "pnpm"',
      'args = ["dlx", "--package", "create-project-calavera@5.0.0", "create-project-calavera-mcp"]',
      "",
      "# the other server",
      "[mcp_servers.other]",
      'command = "node"',
      "",
    ].join("\n");
    await write(".codex/config.toml", before);

    const result = await init("codex");
    const text = await readFile(".codex/config.toml", "utf8");

    assert.equal(result.mcp.action, "update");
    assert.ok(text.includes(`create-project-calavera@${current}`));
    assert.ok(
      text.endsWith('\n\n# the other server\n[mcp_servers.other]\ncommand = "node"\n'),
      text,
    );
  });
});

test("codex: a file without a calavera entry gets the table added after the other servers", async () => {
  await inProject(async () => {
    const before = '[mcp_servers.other]\ncommand = "node"\n';
    await write(".codex/config.toml", before);

    const result = await init("codex");
    const text = await readFile(".codex/config.toml", "utf8");

    assert.equal(result.mcp.action, "update");
    assert.ok(text.startsWith(`${before}\n[mcp_servers.calavera]\ncommand = "npx"\n`), text);
  });
});

test("codex: an mcp_servers value that is not a table is left alone", async () => {
  await inProject(async () => {
    const before = "mcp_servers = 1\n";
    await write(".codex/config.toml", before);

    const result = await init("codex");

    assert.equal(result.mcp.action, "manual");
    assert.match(result.mcp.reason ?? "", /mcp_servers must be a table/);
    assert.equal(await readFile(".codex/config.toml", "utf8"), before);
  });
});

test("codex: an earlier release's table in a file with Windows line endings is updated", async () => {
  await inProject(async () => {
    const before = [
      "[mcp_servers.calavera]",
      'command = "pnpm"',
      'args = ["dlx", "--package", "create-project-calavera@5.0.0", "create-project-calavera-mcp"]',
      "",
    ].join("\r\n");
    await write(".codex/config.toml", before);

    const result = await init("codex");
    const text = await readFile(".codex/config.toml", "utf8");

    assert.equal(result.mcp.action, "update");
    assert.doesNotMatch(text, /5\.0\.0|pnpm/);
    assert.equal(text.match(/\[mcp_servers\.calavera\]/g)?.length, 1);
  });
});

test("codex: a file without mcp_servers gets the table added", async () => {
  await inProject(async () => {
    const before = '[approval]\nmode = "manual"\n';
    await write(".codex/config.toml", before);

    const result = await init("codex");

    assert.equal(result.mcp.action, "update");
    assert.ok((await readFile(".codex/config.toml", "utf8")).startsWith(`${before}\n`));
  });
});

test("cursor: an entry with type stdio from an earlier release is updated, and an edited one is kept", async () => {
  await inProject(async () => {
    await write(
      ".cursor/mcp.json",
      json({ mcpServers: { calavera: { type: "stdio", ...pnpmLaunch("5.0.0") } } }),
    );
    const result = await init("cursor");
    const text = await readFile(".cursor/mcp.json", "utf8");
    assert.equal(result.mcp.action, "update");
    assert.deepEqual(JSON.parse(text).mcpServers.calavera, {
      type: "stdio",
      ...npmLaunch(current),
    });

    // Rerunning finds the entry up to date.
    assert.equal((await init("cursor")).mcp.action, "skip");
    assert.equal(await readFile(".cursor/mcp.json", "utf8"), text);
  });
  await inProject(async () => {
    const before = json({ mcpServers: { calavera: { type: "sse", ...npmLaunch(current) } } });
    await write(".cursor/mcp.json", before);
    assertKeptAsEdit(await init("cursor"), ".cursor/mcp.json");
    assert.equal(await readFile(".cursor/mcp.json", "utf8"), before);
  });
});
