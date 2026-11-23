// Issue #1205: rerunning `--init` updates the `calavera` MCP entry only when it holds what a
// Calavera release wrote for that harness, with the pinned version normalized and published on
// npm (#1219), as `eject` decides (ADR-0017, Decision 2). Any other entry is a local edit (brief C8): the bootstrap keeps it,
// lists the file as skipped with a remedy, and leaves the file byte for byte as it was.
//
// The entries are spelled out here, not built from the current writers, so a change to the
// writers cannot also change what counts as an earlier release's entry.
import assert from "node:assert/strict";
import { mkdir, mkdtempDisposable, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import semver from "semver";

import { agentBootstrap } from "../src/index.js";
import { EARLIER_TEMPLATES } from "../src/utils/earlier-guidance.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const current = packageJson.version;
// #1219: a version the release list names before npm has it, such as 7.0.0 while package.json
// holds 6.2.1. Undefined right after a release, when the list names nothing newer.
const upcoming = EARLIER_TEMPLATES.mcp
  .flatMap(({ releases }) => releases)
  .find((release) => semver.gt(release, current));

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
      assert.ok(!text.includes("\uFEFF"), "no byte order mark appears");
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

  test(`${harness}: an entry pinned to a released prerelease is updated`, async () => {
    await inProject(async () => {
      await write(path, file(pnpmLaunch("2.3.0-next.2")));

      const result = await init(harness);

      assert.equal(result.mcp.action, "update");
      assert.ok((await readFile(path, "utf8")).includes(`create-project-calavera@${current}`));
    });
  });

  test(`${harness}: an entry pinned to a version npm does not have is kept`, async () => {
    // #1219: only a version npm has counts as Calavera's, not one the list names ahead of time.
    for (const version of [
      "99.0.0",
      "99.0.0-local.1",
      // Older than this checkout's version but in no release list, such as a local build of it.
      `${packageJson.version}-local.1`,
      ...(upcoming ? [upcoming] : []),
    ]) {
      await inProject(async () => {
        const before = file(npmLaunch(version));
        await write(path, before);
        const result = await init(harness);
        assertKeptAsEdit(result, path);
        // The reason names the pin, never the version text from the file.
        const reason = result.changes.find((change) => change.path === path)?.reason ?? "";
        assert.match(
          reason,
          /pins a version of create-project-calavera that this release of Calavera does not know as published/,
        );
        assert.ok(!reason.includes(version), reason);
        assert.equal(await readFile(path, "utf8"), before, `${path} ${version}`);
      });
    }
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
    assert.doesNotMatch(text, /[^\r]\n/, "every line still ends with CRLF");
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

test("codex: lines inside a multi-line string that look like the table are never rewritten", async () => {
  await inProject(async () => {
    const table = [
      "[mcp_servers.calavera]",
      'command = "pnpm"',
      'args = ["dlx", "--package", "create-project-calavera@5.0.0", "create-project-calavera-mcp"]',
    ].join("\n");
    const before = `note = """\n${table}\n"""\n\n${table}\n`;
    await write(".codex/config.toml", before);

    const result = await init("codex");

    assert.equal(result.mcp.action, "manual");
    assert.match(result.mcp.reason ?? "", /without changing other settings/);
    assert.equal(await readFile(".codex/config.toml", "utf8"), before);
  });
});

test("codex: an inline mcp_servers table is never extended into a file that does not parse", async () => {
  await inProject(async () => {
    const before = 'mcp_servers = { other = { command = "node" } }\n';
    await write(".codex/config.toml", before);

    const result = await init("codex");

    assert.equal(result.mcp.action, "manual");
    assert.equal(await readFile(".codex/config.toml", "utf8"), before);
  });
});

test("codex: a byte order mark before Calavera's table is kept, and the table is still Calavera's", async () => {
  await inProject(async () => {
    const before = `﻿${harnesses[3]?.file(pnpmLaunch("5.0.0"))}`;
    await write(".codex/config.toml", before);

    const result = await init("codex");
    const text = await readFile(".codex/config.toml", "utf8");

    assert.equal(result.mcp.action, "update");
    assert.ok(text.startsWith("﻿[mcp_servers.calavera]\n"), JSON.stringify(text.slice(0, 30)));
    assert.equal(text.match(/\[mcp_servers\.calavera\]/g)?.length, 1);
    assert.ok(text.includes(`create-project-calavera@${current}`));

    assert.equal((await init("codex")).mcp.action, "skip");
    assert.equal(await readFile(".codex/config.toml", "utf8"), text);
  });
});

test("codex: appending to a file with Windows line endings keeps them and its trailing blank lines", async () => {
  await inProject(async () => {
    const before = '[approval]\r\nmode = "manual"\r\n\r\n\r\n';
    await write(".codex/config.toml", before);

    const result = await init("codex");
    const text = await readFile(".codex/config.toml", "utf8");

    assert.equal(result.mcp.action, "update");
    assert.ok(text.startsWith(`${before}[mcp_servers.calavera]\r\n`), JSON.stringify(text));
    assert.doesNotMatch(text, /[^\r]\n/, "every line ends with CRLF");
    assert.ok(text.endsWith("\r\n"));
  });
});

test("codex: appending to a file without a final newline adds one blank line before the table", async () => {
  await inProject(async () => {
    const before = '[approval]\nmode = "manual"';
    await write(".codex/config.toml", before);

    await init("codex");

    assert.ok(
      (await readFile(".codex/config.toml", "utf8")).startsWith(
        `${before}\n\n[mcp_servers.calavera]\n`,
      ),
    );
  });
});

for (const { harness, path, file } of harnesses.filter(({ harness: name }) => name !== "codex")) {
  test(`${harness}: a calavera key repeated in the MCP container is kept and reported`, async () => {
    for (const dryRun of [true, false]) {
      await inProject(async () => {
        // The person's entry comes first; JSON.parse keeps only the last, Calavera's own.
        const calaveras = file(npmLaunch(current));
        const mine = calaveras.replace(
          '"calavera": {',
          '"calavera": { "mine": true },\n    "calavera": {',
        );
        assert.notEqual(mine, calaveras);
        await write(path, mine);

        const result = await init(harness, dryRun);

        assert.equal(await readFile(path, "utf8"), mine, `${path} is unchanged`);
        assert.equal(result.mcp.action, "skip");
        const listed = result.changes.filter((change) => change.path === path);
        assert.equal(listed.length, 1);
        assert.equal(listed[0]?.type, "skip");
        assert.match(listed[0]?.reason ?? "", /"calavera" more than once/);
        assert.match(listed[0]?.reason ?? "", /then run --init again/);
      });
    }
  });
}

test("codex: a byte order mark stays at the start when Calavera's table comes later", async () => {
  await inProject(async () => {
    const table = harnesses[3]?.file(pnpmLaunch("5.0.0"));
    await write(".codex/config.toml", `\uFEFF[approval]\nmode = "manual"\n\n${table}`);

    assert.equal((await init("codex")).mcp.action, "update");
    const text = await readFile(".codex/config.toml", "utf8");

    assert.ok(text.startsWith('\uFEFF[approval]\nmode = "manual"\n\n[mcp_servers.calavera]\n'));
    assert.equal(text.match(/\uFEFF/g)?.length, 1);
  });
});

test("codex: an empty file gets Calavera's table alone", async () => {
  await inProject(async () => {
    await write(".codex/config.toml", "");

    await init("codex");

    assert.ok(
      (await readFile(".codex/config.toml", "utf8")).startsWith("[mcp_servers.calavera]\n"),
    );
  });
});
