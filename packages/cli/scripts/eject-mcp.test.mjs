// Issue #678, layer 3 of the five-layer stack the owner approved on 2026-11-18: the MCP entries
// part of the `eject` footprint (ADR-0017, Decision 2). It covers the `calavera` entry in the four
// harness files the bootstrap writes, `.mcp.json`, `.cursor/mcp.json`, `opencode.json`, and
// `.codex/config.toml`. It also covers the owner's decision of 2026-11-19 on #678 that a
// `.gitignore` that links out of the project keeps its `artifact-cache` block and is reported,
// rather than stopping the plan. The command is registered in layer 5, so these tests call the
// planner directly.
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { TomlError } from "smol-toml";

import { executeEject, planEject, selectEjectItems } from "../src/eject.js";
import { agentBootstrap, agentBootstrapTexts } from "../src/index.js";
import { normalizePinnedVersion } from "../src/utils/earlier-guidance.js";
import {
  createCodexMcpTomlBlock,
  createMcpServersJsonConfig,
  createOpenCodeMcpJsonConfig,
} from "../src/utils/mcp-config.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

/** @type {import("../src/utils/project-formatter.js").ProjectFormatter} */
const unformatted = { description: "no formatter", format: async (_path, text) => text };
const loadFormatter = async () => unformatted;
const guidance = await agentBootstrapTexts(loadFormatter);
const launches = guidance.mcpLaunchCommands;
const npmLaunch = /** @type {{ command: string, args: string[] }} */ (launches[0]);
const SCHEMA = "https://opencode.ai/config.json";
const CACHE_BLOCK =
  "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n";

/**
 * Runs `callback` inside a new temporary project.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-eject-mcp-"));
  const originalDirectory = process.cwd();
  process.chdir(await realpath(project.path));
  try {
    await writeFile("package.json", "{}\n");
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

/** @param {unknown} value */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/** @param {{ dryRun?: boolean, format?: typeof loadFormatter }} [options] */
const plan = ({ dryRun = false, format = loadFormatter } = {}) =>
  planEject({ dryRun, guidance, loadFormatter: format });

/** @param {Awaited<ReturnType<typeof planEject>>} found @param {string} path */
function item(found, path) {
  const match = found.items.find((candidate) => candidate.path === path);
  assert.ok(match, `the plan names ${path}: ${found.items.map(({ path: p }) => p).join(", ")}`);
  return match;
}

/** @param {Awaited<ReturnType<typeof planEject>>} found @param {string} path */
const named = (found, path) => found.items.some((candidate) => candidate.path === path);

/** @param {Awaited<ReturnType<typeof planEject>>} found @param {string} path */
function report(found, path) {
  const match = found.reported.find((candidate) => candidate.path === path);
  assert.ok(match, `the plan reports ${path}: ${JSON.stringify(found.reported)}`);
  return match;
}

/** Plans, approves every item, and removes them. */
async function ejectApproved() {
  const found = await plan();
  const outcome = await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
  assert.deepEqual(outcome.failed, []);
  return { found, outcome };
}

/**
 * Asserts that the plan keeps the file at `path` and reports its entry, and that an approved run
 * leaves the file byte-identical.
 *
 * @param {string} path @param {RegExp} reason
 */
async function assertKeptAndReported(path, reason) {
  const before = await readFile(path, "utf8");
  const found = await plan();
  assert.equal(named(found, path), false);
  assert.match(report(found, path).reason, reason);
  await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
  assert.equal(await readFile(path, "utf8"), before);
}

/** @param {{ command: string, args: string[] }} launch @param {string} version */
const repinned = (launch, version) => ({
  command: launch.command,
  args: launch.args.map((arg) =>
    arg.replace(/^create-project-calavera@.+$/, `create-project-calavera@${version}`),
  ),
});

// Each harness file, with the text the bootstrap writes into an empty project for a launch command.
const HARNESSES = [
  {
    harness: /** @type {const} */ ("claude-code"),
    path: ".mcp.json",
    written: (/** @type {typeof npmLaunch} */ launch) => json(createMcpServersJsonConfig(launch)),
  },
  {
    harness: /** @type {const} */ ("cursor"),
    path: ".cursor/mcp.json",
    written: (/** @type {typeof npmLaunch} */ launch) => json(createMcpServersJsonConfig(launch)),
  },
  {
    harness: /** @type {const} */ ("opencode"),
    path: "opencode.json",
    written: (/** @type {typeof npmLaunch} */ launch) => json(createOpenCodeMcpJsonConfig(launch)),
  },
  {
    harness: /** @type {const} */ ("codex"),
    path: ".codex/config.toml",
    written: (/** @type {typeof npmLaunch} */ launch) => createCodexMcpTomlBlock(launch),
  },
];

test("agentBootstrapTexts gives the MCP launch command for each package manager, pinned to this release", () => {
  assert.deepEqual(
    launches.map(({ command }) => command),
    ["npx", "pnpm", "yarn", "bunx"],
  );
  for (const launch of launches) {
    assert.equal(normalizePinnedVersion(launch.args.join(" "))?.pin, packageJson.version);
  }
});

for (const { harness, path, written } of HARNESSES) {
  test(`${harness}: the entry a real bootstrap writes is unedited, and --yes removes it and keeps the file`, async () => {
    await inProject(async () => {
      await agentBootstrap({ json: true, assumeYes: true, mcpHarness: harness });
      const dry = await plan({ dryRun: true });
      const before = await snapshotDirectory();
      const entry = item(dry, path);
      assert.deepEqual(dry.reported, []);
      assert.equal(entry.kind, "mcp-entry");
      assert.equal(entry.action, "edit");
      assert.equal(entry.edits, "unedited");
      assert.equal(entry.matchesRecords, true);
      assert.deepEqual(await snapshotDirectory(), before);

      const found = await plan();
      const { remove } = selectEjectItems(found, { assumeYes: true });
      assert.ok(remove.some((candidate) => candidate.path === path));
      const outcome = await executeEject(remove);
      assert.deepEqual(outcome.failed, []);
      // The file stays, emptied of everything Calavera added (ADR-0017, Decision 2).
      assert.equal(await readFile(path, "utf8"), harness === "codex" ? "" : "{}\n");
      if (path.includes("/")) assert.ok((await lstat(dirname(path))).isDirectory());
    });
  });

  test(`${harness}: an entry for any package manager and any pinned version is unedited`, async () => {
    for (const launch of launches) {
      for (const version of ["5.0.0", "7.0.0-beta.1"]) {
        await inProject(async () => {
          await write(path, written(repinned(launch, version)));
          const entry = item(await plan(), path);
          assert.equal(entry.edits, "unedited", `${launch.command} ${version}`);
        });
      }
    }
  });

  test(`${harness}: an entry without a pinned version is kept and reported as edited`, async () => {
    await inProject(async () => {
      await write(
        path,
        written({
          command: "npx",
          args: ["--package", "create-project-calavera", "create-project-calavera-mcp"],
        }),
      );
      await assertKeptAndReported(path, /edited/);
    });
  });

  test(`${harness}: an entry that holds the version placeholder is kept and reported`, async () => {
    await inProject(async () => {
      await write(path, written(repinned(npmLaunch, "{{version}}")));
      await assertKeptAndReported(path, /edited/);
    });
  });

  test(`${harness}: a folder at the harness path holds no entry`, async () => {
    await inProject(async () => {
      await mkdir(path, { recursive: true });
      const found = await plan();
      assert.equal(named(found, path), false);
      assert.equal(
        found.reported.some((candidate) => candidate.path === path),
        false,
      );
    });
  });

  test(`${harness}: a harness file that links out of the project is reported, and the rest of eject goes on`, async () => {
    await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
    const target = join(outside.path, "harness");
    await writeFile(target, written(npmLaunch));
    await inProject(async () => {
      await mkdir(dirname(path), { recursive: true });
      await symlink(target, path);
      await write(".agents/calavera/mcp.md", guidance.mcp[0] ?? "");
      const found = await plan();
      assert.equal(named(found, path), false);
      assert.match(report(found, path).reason, /outside the project/);
      assert.equal(item(found, ".agents/calavera/mcp.md").edits, "unedited");
      await ejectApproved();
    });
    assert.equal(await readFile(target, "utf8"), written(npmLaunch));
  });

  test(`${harness}: a harness file with no calavera entry is neither planned nor reported`, async () => {
    await inProject(async () => {
      await write(
        path,
        harness === "codex"
          ? '[mcp_servers.other]\ncommand = "other"\n'
          : json({ mcpServers: { other: { command: "other" } }, mcp: {} }),
      );
      const found = await plan();
      assert.equal(named(found, path), false);
      assert.deepEqual(found.reported, []);
      assert.equal(found.nothingToDo, true);
    });
  });

  test(`${harness}: a second run after eject has nothing to do`, async () => {
    await inProject(async () => {
      await write(path, written(npmLaunch));
      await ejectApproved();
      const again = await plan();
      assert.equal(again.nothingToDo, true);
      assert.deepEqual(again.reported, []);
    });
  });
}

// The JSON harness files.
const JSON_HARNESSES = HARNESSES.filter(({ harness }) => harness !== "codex");

for (const { harness, path, written } of JSON_HARNESSES) {
  const key = harness === "opencode" ? "mcp" : "mcpServers";
  const entryOf = (/** @type {typeof npmLaunch} */ launch) =>
    /** @type {Record<string, Record<string, unknown>>} */ (JSON.parse(written(launch)))[key]
      ?.calavera;

  test(`${harness}: an entry with a key Calavera does not write is kept and reported as edited`, async () => {
    await inProject(async () => {
      const config = JSON.parse(written(npmLaunch));
      config[key].calavera.env = { DEBUG: "1" };
      await write(path, json(config));
      await assertKeptAndReported(path, /differs from the launch command/);
    });
  });

  test(`${harness}: an entry whose launch command differs is kept and reported as edited`, async () => {
    await inProject(async () => {
      await write(path, written({ ...npmLaunch, command: "my-npx" }));
      await assertKeptAndReported(path, /differs from the launch command/);
    });
  });

  test(`${harness}: other servers and keys stay, and only the calavera entry goes`, async () => {
    await inProject(async () => {
      const config = JSON.parse(written(npmLaunch));
      config[key] = { other: { command: "other" }, ...config[key] };
      config.theirs = true;
      await write(path, json(config));
      const { found } = await ejectApproved();
      const after = JSON.parse(await readFile(path, "utf8"));
      delete config[key].calavera;
      assert.deepEqual(after, config);
      assert.deepEqual(
        item(found, path).removedLines,
        `"calavera": ${JSON.stringify(entryOf(npmLaunch), null, 2)}`.split("\n"),
      );
    });
  });

  test(`${harness}: an emptied ${key} object is removed while other keys keep the file`, async () => {
    await inProject(async () => {
      const config = { theirs: 1, ...JSON.parse(written(npmLaunch)) };
      await write(path, json(config));
      await ejectApproved();
      const expected = /** @type {Record<string, unknown>} */ ({ theirs: 1 });
      if (harness === "opencode") expected.$schema = SCHEMA;
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), expected);
    });
  });

  test(`${harness}: a file that cannot be parsed stops eject before it writes anything`, async () => {
    await inProject(async () => {
      // Not JSON, for its comment, and not JSONC either, because it ends early.
      await write(path, `// my servers\n${written(npmLaunch).slice(0, -4)}`);
      await write(".agents/calavera/mcp.md", guidance.mcp[0] ?? "");
      const before = await snapshotDirectory();
      await assert.rejects(plan(), (error) => {
        assert.ok(error instanceof Error);
        assert.match(
          error.message,
          new RegExp(
            `eject stopped before removing anything: ${path.replaceAll(".", "\\.")} cannot be parsed as JSON, nor as JSON with comments \\(JSONC\\): CloseBraceExpected at offset \\d+`,
          ),
        );
        // The parser's own error stays as the cause, so the failure can be diagnosed.
        assert.ok(error.cause instanceof SyntaxError);
        return true;
      });
      assert.deepEqual(await snapshotDirectory(), before);
    });
  });

  test(`${harness}: a rewrite that would lose a duplicated key keeps the entry and reports it`, async () => {
    await inProject(async () => {
      const text = written(npmLaunch).replace(/^\{\n/, '{\n  "theirs": 1,\n  "theirs": 2,\n');
      await write(path, text);
      await assertKeptAndReported(path, /holds the key "theirs" more than once/);
    });
  });

  test(`${harness}: a rewrite that would change a number's spelling keeps the entry and reports it`, async () => {
    await inProject(async () => {
      await write(path, written(npmLaunch).replace(/^\{\n/, '{\n  "theirs": 1.50,\n'));
      await assertKeptAndReported(path, /holds the number 1\.50/);
    });
  });

  test(`${harness}: the dry run says when the formatter changes the layout of the rest of the file`, async () => {
    await inProject(async () => {
      await write(path, JSON.stringify(JSON.parse(written(npmLaunch)), null, 4));
      const entry = item(await plan(), path);
      assert.equal(entry.edits, "unedited");
      assert.equal(entry.reason, undefined);
      assert.match(entry.note ?? "", /formatter/);
      assert.equal(entry.contents, "{}\n");
    });
    await inProject(async () => {
      await write(path, written(npmLaunch));
      const entry = item(await plan(), path);
      assert.equal(entry.note, undefined);
      assert.equal(entry.matchesRecords, true);
    });
  });

  test(`${harness}: --yes leaves an entry whose removal would change the layout of the rest of the file`, async () => {
    await inProject(async () => {
      const text = JSON.stringify(
        { ...JSON.parse(written(npmLaunch)), theirs: { keep: [1, 2] } },
        null,
        1,
      );
      await write(path, text);
      const found = await plan();
      assert.equal(item(found, path).matchesRecords, false);
      const { remove, leave } = selectEjectItems(found, { assumeYes: true });
      assert.equal(
        remove.some((candidate) => candidate.path === path),
        false,
      );
      assert.ok(leave.some((candidate) => candidate.path === path));
      await executeEject(remove);
      assert.equal(await readFile(path, "utf8"), text);
      // An approved run, which showed the text afterward, removes it.
      await ejectApproved();
      const kept = /** @type {Record<string, unknown>} */ ({ theirs: { keep: [1, 2] } });
      if (harness === "opencode") kept.$schema = SCHEMA;
      assert.deepEqual(JSON.parse(await readFile(path, "utf8")), kept);
    });
  });

  for (const [label, text] of [
    ["a comment", `// My servers\n${written(npmLaunch)}`],
    ["a trailing comma", written(npmLaunch).replace(/\n\}\n$/, ",\n}\n")],
  ]) {
    test(`${harness}: a JSONC file with ${label} keeps its calavera entry, reported, and is never rewritten`, async () => {
      await inProject(async () => {
        await write(path, text);
        await assertKeptAndReported(path, /JSON with comments \(JSONC\)/);
      });
    });
  }

  test(`${harness}: a file with a comment and no calavera entry is neither a stop nor reported`, async () => {
    await inProject(async () => {
      await write(path, `{\n  // my servers\n  "${key}": {}\n}\n`);
      const found = await plan();
      assert.equal(found.nothingToDo, true);
      assert.deepEqual(found.reported, []);
    });
  });

  test(`${harness}: the result comes from the project's formatter`, async () => {
    await inProject(async () => {
      await write(path, json({ theirs: [1, 2], ...JSON.parse(written(npmLaunch)) }));
      /** @type {import("../src/utils/project-formatter.js").ProjectFormatter} */
      const compact = {
        description: "compact",
        format: async (_path, text) => `${JSON.stringify(JSON.parse(text))}\n`,
      };
      const entry = item(await plan({ format: async () => compact }), path);
      const expected =
        harness === "opencode" ? { theirs: [1, 2], $schema: SCHEMA } : { theirs: [1, 2] };
      assert.equal(entry.contents, `${JSON.stringify(expected)}\n`);
    });
  });
}

test("opencode: a $schema Calavera writes goes only when nothing else remains in the file", async () => {
  await inProject(async () => {
    await write("opencode.json", json(createOpenCodeMcpJsonConfig(npmLaunch)));
    const entry = item(await plan(), "opencode.json");
    const { mcp } = /** @type {{ mcp: unknown }} */ (createOpenCodeMcpJsonConfig(npmLaunch));
    assert.deepEqual(entry.removedLines, [
      `"$schema": "${SCHEMA}"`,
      ...`"mcp": ${JSON.stringify(mcp, null, 2)}`.split("\n"),
    ]);
  });
  await inProject(async () => {
    await write("opencode.json", json({ ...createOpenCodeMcpJsonConfig(npmLaunch), theme: "x" }));
    await ejectApproved();
    assert.deepEqual(JSON.parse(await readFile("opencode.json", "utf8")), {
      $schema: SCHEMA,
      theme: "x",
    });
  });
});

test("opencode: a $schema with another value stays, even when nothing else remains", async () => {
  await inProject(async () => {
    await write(
      "opencode.json",
      json({ ...createOpenCodeMcpJsonConfig(npmLaunch), $schema: "https://example.com/mine.json" }),
    );
    await ejectApproved();
    assert.deepEqual(JSON.parse(await readFile("opencode.json", "utf8")), {
      $schema: "https://example.com/mine.json",
    });
  });
});

test(".mcp.json: an mcp key and a calavera entry outside mcpServers are left alone", async () => {
  await inProject(async () => {
    await write(".mcp.json", json({ mcp: { calavera: npmLaunch }, calavera: npmLaunch }));
    const found = await plan();
    assert.equal(named(found, ".mcp.json"), false);
    assert.deepEqual(found.reported, []);
  });
});

test("a JSON harness file whose top level is not an object holds no entry", async () => {
  await inProject(async () => {
    await write(".mcp.json", "[]\n");
    await write("opencode.json", "null\n");
    await write(".cursor/mcp.json", json({ mcpServers: [npmLaunch] }));
    const found = await plan();
    assert.equal(found.nothingToDo, true);
    assert.deepEqual(found.reported, []);
  });
});

// The Codex harness file, which eject edits as text, so the person's comments and layout stay.
const CODEX = ".codex/config.toml";
const codexBlock = createCodexMcpTomlBlock(npmLaunch);
const CODEX_TABLE_LINE = "[mcp_servers.calavera]";
const MODEL = '# My settings\nmodel = "o3"\n';

test("codex: the table is removed with the blank line Calavera added, and every other line stays", async () => {
  await inProject(async () => {
    await write(CODEX, `${MODEL.trimEnd()}\n\n${codexBlock}`);
    const { found } = await ejectApproved();
    assert.equal(await readFile(CODEX, "utf8"), MODEL);
    assert.deepEqual(item(found, CODEX).removedLines, codexBlock.trimEnd().split("\n"));
  });
});

test("codex: a table between two of the person's tables keeps both and their comments", async () => {
  await inProject(async () => {
    const after = '\n# The next server\n[mcp_servers.other]\ncommand = "other"\n';
    await write(CODEX, `${MODEL}\n${codexBlock}${after}`);
    await ejectApproved();
    assert.equal(await readFile(CODEX, "utf8"), `${MODEL}${after}`);
  });
});

test("codex: a table followed directly by the person's table removes no line of theirs", async () => {
  await inProject(async () => {
    const after = '[mcp_servers.other]\ncommand = "other"\n';
    await write(CODEX, `${MODEL}\n${codexBlock}${after}`);
    await ejectApproved();
    assert.equal(await readFile(CODEX, "utf8"), `${MODEL}\n${after}`);
  });
});

test("codex: a table with Windows line endings is unedited and the rest keeps its line endings", async () => {
  await inProject(async () => {
    await write(CODEX, `${MODEL}\n${codexBlock}`.replaceAll("\n", "\r\n"));
    await ejectApproved();
    assert.equal(await readFile(CODEX, "utf8"), MODEL.replaceAll("\n", "\r\n"));
  });
});

test("codex: a table without a final line break is removed", async () => {
  await inProject(async () => {
    await write(CODEX, `${MODEL}\n${codexBlock.trimEnd()}`);
    await ejectApproved();
    assert.equal(await readFile(CODEX, "utf8"), MODEL);
  });
});

for (const [label, table] of [
  ["a comment inside the table", codexBlock.replace("\nargs", "\n# Pinned on purpose\nargs")],
  ["a key Calavera does not write", `${codexBlock}env = { DEBUG = "1" }\n`],
  ["a different layout", codexBlock.replace("command = ", "command=")],
  ["a different command", codexBlock.replace('"npx"', '"my-npx"')],
]) {
  test(`codex: a table with ${label} is kept and reported as edited`, async () => {
    await inProject(async () => {
      await write(CODEX, `${MODEL}\n${table}`);
      await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
    });
  });
}

test("codex: a subtable of the calavera table makes the entry edited", async () => {
  await inProject(async () => {
    await write(CODEX, `${codexBlock}\n[mcp_servers.calavera.env]\nDEBUG = "1"\n`);
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

/**
 * Asserts that planning stops before anything is written, because the Codex file is not TOML, and
 * that the parser's own error stays as the cause.
 */
async function assertTomlStop() {
  const before = await snapshotDirectory();
  await assert.rejects(plan(), (error) => {
    assert.ok(error instanceof Error);
    assert.match(
      error.message,
      /^eject stopped before removing anything: \.codex\/config\.toml cannot be parsed as TOML: Invalid TOML document: /,
    );
    assert.ok(error.cause instanceof TomlError);
    return true;
  });
  assert.deepEqual(await snapshotDirectory(), before);
}

test("codex: a calavera table defined twice stops eject before it writes anything", async () => {
  await inProject(async () => {
    await write(CODEX, `${codexBlock}\n${codexBlock}`);
    await assertTomlStop();
  });
});

test("codex: a file that is not TOML stops eject, even with no calavera table", async () => {
  await inProject(async () => {
    await write(CODEX, "model = \n");
    await assertTomlStop();
  });
});

test("codex: the table is found under an explicit [mcp_servers] header, which stays", async () => {
  await inProject(async () => {
    await write(CODEX, `[mcp_servers]\n\n${codexBlock}`);
    await ejectApproved();
    assert.equal(await readFile(CODEX, "utf8"), "[mcp_servers]\n");
  });
});

const INLINE_ENTRY = `[mcp_servers]\ncalavera = { command = "npx", args = ${JSON.stringify(npmLaunch.args)} }\n`;

test("codex: an inline calavera table is not the table Calavera writes, so it is kept and reported", async () => {
  await inProject(async () => {
    await write(CODEX, INLINE_ENTRY);
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

test("codex: Calavera's text inside a string, with the entry defined elsewhere, is kept and reported", async () => {
  await inProject(async () => {
    await write(CODEX, `${INLINE_ENTRY}\n[other]\ndoc = """\n${codexBlock}"""\n`);
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

// Every item `executeEject` changes is read again just before the change, and nothing is changed
// when it differs from what the plan read, in every direction of change.

/**
 * Plans with the harness file at `path` holding `text`, applies `change`, and checks that the
 * approved removal stops with nothing changed.
 *
 * @param {string} path @param {string} text @param {(path: string, text: string) => Promise<void>} change
 */
async function assertStopsAfter(path, text, change) {
  await inProject(async () => {
    await write("target/text", text);
    await write(path, text);
    const found = await plan();
    assert.ok(named(found, path));
    await change(path, text);
    const before = await snapshotDirectory();
    await assert.rejects(
      executeEject(selectEjectItems(found, { assumeYes: false }).remove),
      new RegExp(`${path.replaceAll(".", "\\.")} changed since eject listed`),
    );
    assert.deepEqual(await snapshotDirectory(), before);
  });
}

for (const { harness, path, written } of HARNESSES) {
  test(`${harness}: an edit after the plan stops the removal`, async () => {
    await assertStopsAfter(path, written(npmLaunch), (target, current) =>
      writeFile(target, harness === "codex" ? `${current}# Added\n` : `${current} `),
    );
  });

  test(`${harness}: a link to identical text in its place after the plan stops the removal`, async () => {
    await assertStopsAfter(path, written(npmLaunch), async (target) => {
      await rm(target);
      await symlink(join(process.cwd(), "target/text"), target);
    });
  });

  test(`${harness}: a folder in its place after the plan stops the removal`, async () => {
    await assertStopsAfter(path, written(npmLaunch), async (target) => {
      await rm(target);
      await mkdir(target);
    });
  });

  test(`${harness}: a file deleted after the plan counts as removed`, async () => {
    await inProject(async () => {
      await write(path, written(npmLaunch));
      const found = await plan();
      await rm(path);
      const outcome = await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
      assert.deepEqual(outcome.failed, []);
      assert.ok(outcome.removed.some((removed) => removed.path === path));
      await assert.rejects(lstat(path), { code: "ENOENT" });
    });
  });

  test(`${harness}: a link in the middle of a chain retargeted after the plan stops the edit`, async () => {
    await inProject(async () => {
      await write("one/file", written(npmLaunch));
      await write("two/file", written(npmLaunch));
      await symlink("one/file", "hop");
      await mkdir(dirname(path), { recursive: true });
      await symlink(join(process.cwd(), "hop"), path);
      const found = await plan();
      assert.equal(item(found, path).edits, "unedited");
      await rm("hop");
      await symlink("two/file", "hop");
      await assert.rejects(
        executeEject(selectEjectItems(found, { assumeYes: true }).remove),
        /changed since eject listed/,
      );
      assert.equal(await readFile("two/file", "utf8"), written(npmLaunch));
    });
  });
}

for (const { harness, path, written } of HARNESSES.filter(({ path: p }) => p.includes("/"))) {
  test(`${harness}: a linked ${dirname(path)} retargeted to an identical copy after the plan stops the edit`, async () => {
    await inProject(async () => {
      const file = path.slice(path.indexOf("/") + 1);
      await write(`shared/a/${file}`, written(npmLaunch));
      await write(`shared/b/${file}`, written(npmLaunch));
      await symlink("shared/a", dirname(path));
      const found = await plan();
      assert.equal(item(found, path).edits, "unedited");
      await rm(dirname(path));
      await symlink("shared/b", dirname(path));
      await assert.rejects(
        executeEject(selectEjectItems(found, { assumeYes: true }).remove),
        /changed since eject listed/,
      );
      assert.equal(await readFile(`shared/b/${file}`, "utf8"), written(npmLaunch));
    });
  });
}

test("a harness file that is a link inside the project is edited through the link", async () => {
  await inProject(async () => {
    await write("shared/mcp.json", json(createMcpServersJsonConfig(npmLaunch)));
    await symlink("shared/mcp.json", ".mcp.json");
    await ejectApproved();
    assert.ok((await lstat(".mcp.json")).isSymbolicLink());
    assert.equal(await readFile("shared/mcp.json", "utf8"), "{}\n");
  });
});

test("an unparseable harness file that links out of the project is reported, not a stop", async () => {
  await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
  await writeFile(join(outside.path, "mcp.json"), '{ "mcpServers": { "calavera": ');
  await inProject(async () => {
    await symlink(join(outside.path, "mcp.json"), ".mcp.json");
    const found = await plan();
    assert.match(report(found, ".mcp.json").reason, /outside the project/);
    // eject cannot read the file, so it does not claim that the entry is there.
    assert.match(report(found, ".mcp.json").reason, /may hold/);
  });
});

test("an edited entry is reported on every run, and a second run has nothing to do", async () => {
  await inProject(async () => {
    await write(".mcp.json", json(createMcpServersJsonConfig({ ...npmLaunch, command: "mine" })));
    await write(CODEX, codexBlock);
    await ejectApproved();
    const again = await plan();
    assert.equal(again.nothingToDo, true);
    assert.deepEqual(
      again.reported.map(({ path }) => path),
      [".mcp.json"],
    );
  });
});

// Owner decision of 2026-11-19 on #678: a `.gitignore` that holds the `artifact-cache` block and
// links out of the project is kept and reported, as an `AGENTS.md` that links out of it is.
test("a .gitignore that links out of the project keeps its block, is reported, and the rest of eject goes on", async () => {
  await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
  const target = join(outside.path, "gitignore");
  await writeFile(target, `node_modules/\n${CACHE_BLOCK}`);
  await inProject(async () => {
    await symlink(target, ".gitignore");
    await write(".calavera/cache/npm/index", "cache\n");
    const found = await plan();
    assert.equal(named(found, ".gitignore"), false);
    assert.match(report(found, ".gitignore").reason, /outside the project/);
    assert.match(report(found, ".gitignore").reason, /artifact-cache/);
    assert.ok(named(found, ".calavera/cache"));
    await ejectApproved();
    await assert.rejects(lstat(".calavera/cache"), { code: "ENOENT" });
  });
  assert.equal(await readFile(target, "utf8"), `node_modules/\n${CACHE_BLOCK}`);
});

test("a .gitignore that links out of the project with a broken block marker is reported, not a stop", async () => {
  await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
  const target = join(outside.path, "gitignore");
  await writeFile(target, "# calavera:artifact-cache:start\n.calavera/cache/\n");
  await inProject(async () => {
    await symlink(target, ".gitignore");
    const found = await plan();
    assert.match(report(found, ".gitignore").reason, /outside the project/);
  });
});

test("a .gitignore that links out of the project without the block is neither planned nor reported", async () => {
  await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
  await writeFile(join(outside.path, "gitignore"), "node_modules/\n");
  await inProject(async () => {
    await symlink(join(outside.path, "gitignore"), ".gitignore");
    const found = await plan();
    assert.equal(found.nothingToDo, true);
    assert.deepEqual(found.reported, []);
  });
});

test(".mcp.json: a $schema with the OpenCode value stays, because only opencode.json gets one from Calavera", async () => {
  await inProject(async () => {
    await write(".mcp.json", json({ $schema: SCHEMA, ...createMcpServersJsonConfig(npmLaunch) }));
    await ejectApproved();
    assert.deepEqual(JSON.parse(await readFile(".mcp.json", "utf8")), { $schema: SCHEMA });
  });
});

test("codex: an indented header is not the table Calavera writes, so it is kept and reported", async () => {
  await inProject(async () => {
    await write(CODEX, `${MODEL}\n  ${codexBlock}`);
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

test("codex: an array of tables under the calavera table makes the entry edited", async () => {
  await inProject(async () => {
    await write(CODEX, `${codexBlock}\n[[mcp_servers.calavera.tools]]\nname = "x"\n`);
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

test("codex: another array of tables leaves the calavera table unedited", async () => {
  await inProject(async () => {
    const theirs = '[[profiles]]\nname = "fast"\n';
    await write(CODEX, `${theirs}\n${codexBlock}`);
    const { found } = await ejectApproved();
    assert.deepEqual(found.reported, []);
    assert.equal(await readFile(CODEX, "utf8"), theirs);
  });
});

test("a .gitignore inside the project has its block planned, and nothing is reported", async () => {
  await inProject(async () => {
    await write(".gitignore", `node_modules/\n${CACHE_BLOCK}`);
    const found = await plan();
    assert.equal(item(found, ".gitignore").kind, "artifact-cache-block");
    assert.deepEqual(found.reported, []);
  });
});

for (const header of [
  "[mcp_servers.calavera] # mine",
  "[ mcp_servers.calavera ]",
  '[mcp_servers."calavera"]',
  "[mcp_servers.'calavera']",
]) {
  test(`codex: the table under ${header} is not the header Calavera writes, so it is kept and reported`, async () => {
    await inProject(async () => {
      await write(CODEX, `${MODEL}\n${codexBlock.replace(CODEX_TABLE_LINE, header)}`);
      await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
    });
  });
}

for (const subtable of ['[mcp_servers."calavera".env]', "[ mcp_servers . calavera . env ]"]) {
  test(`codex: a subtable written as ${subtable} makes the entry edited`, async () => {
    await inProject(async () => {
      await write(CODEX, `${codexBlock}\n${subtable}\nDEBUG = "1"\n`);
      await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
    });
  });
}

test("codex: a calavera table defined twice under different spellings stops eject", async () => {
  await inProject(async () => {
    await write(CODEX, `[mcp_servers."calavera"]\ncommand = "mine"\n\n${codexBlock}`);
    await assertTomlStop();
  });
});

test("codex: a next header with a comment ends the table, and the person's table stays", async () => {
  await inProject(async () => {
    const after = "[next] # mine\nx = 1\n";
    await write(CODEX, `${MODEL}\n${codexBlock}${after}`);
    const { found } = await ejectApproved();
    assert.deepEqual(found.reported, []);
    assert.equal(await readFile(CODEX, "utf8"), `${MODEL}\n${after}`);
  });
});

for (const quotes of ['"""', "'''"]) {
  test(`codex: a ${quotes} multi-line string that quotes the header stays, and --yes removes the table`, async () => {
    await inProject(async () => {
      const theirs = `[other]\nnote = ${quotes}\n${CODEX_TABLE_LINE}\n${quotes}\n`;
      await write(CODEX, `${theirs}\n${codexBlock}`);
      const found = await plan();
      const entry = item(found, CODEX);
      assert.equal(entry.edits, "unedited");
      assert.equal(entry.matchesRecords, true);
      await executeEject(selectEjectItems(found, { assumeYes: true }).remove);
      assert.equal(await readFile(CODEX, "utf8"), theirs);
    });
  });
}

test("the formatter is loaded once, however many JSON harness files hold an entry", async () => {
  await inProject(async () => {
    await write(".mcp.json", json(createMcpServersJsonConfig(npmLaunch)));
    await write(".cursor/mcp.json", json(createMcpServersJsonConfig(npmLaunch)));
    await write("opencode.json", json(createOpenCodeMcpJsonConfig(npmLaunch)));
    let loads = 0;
    await plan({
      format: async () => {
        loads += 1;
        return unformatted;
      },
    });
    assert.equal(loads, 1);
  });
});

test("codex: blank lines with spaces and an indented comment before the next header stay with it", async () => {
  await inProject(async () => {
    const after = "   \n  # The next table\n[next]\nx = 1\n";
    await write(CODEX, `${MODEL}\n${codexBlock}${after}`);
    const { found } = await ejectApproved();
    assert.deepEqual(found.reported, []);
    // The line of spaces is the person's, so the blank line Calavera added before the table stays
    // too, as it does when their text follows the table directly.
    assert.equal(await readFile(CODEX, "utf8"), `${MODEL}\n${after}`);
  });
});

test("codex: a key with an array value after the table belongs to it, so the table is edited", async () => {
  await inProject(async () => {
    await write(CODEX, `${MODEL}\n${codexBlock}tags = ["a"]\n`);
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

test("codex: a calavera table under another name is neither planned nor reported", async () => {
  await inProject(async () => {
    await write(CODEX, codexBlock.replace(CODEX_TABLE_LINE, "[other.calavera]"));
    const found = await plan();
    assert.equal(found.nothingToDo, true);
    assert.deepEqual(found.reported, []);
  });
});

test("codex: a subtable of calavera without the table itself is reported as edited", async () => {
  await inProject(async () => {
    await write(CODEX, '[mcp_servers.calavera.env]\nDEBUG = "1"\n');
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

for (const key of ['"x] #"', '"b]#c"', '"a]#"']) {
  test(`codex: a subtable whose quoted key is ${key} makes the entry edited`, async () => {
    await inProject(async () => {
      await write(CODEX, `${codexBlock}\n[other]\n\n[mcp_servers.calavera.${key}]\nFOO = "1"\n`);
      await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
    });
  });
}

// Two harness paths can lead to one file. Two edits built from the same text would each write the
// whole file, and the second would put back what the first removed, so both are kept and reported.
for (const [label, linked, config] of [
  [
    "opencode.json linked to .mcp.json",
    "opencode.json",
    () => ({ ...createMcpServersJsonConfig(npmLaunch), ...createOpenCodeMcpJsonConfig(npmLaunch) }),
  ],
  [
    ".cursor/mcp.json linked to .mcp.json",
    ".cursor/mcp.json",
    () => createMcpServersJsonConfig(npmLaunch),
  ],
]) {
  test(`${label}: both are kept and reported, naming both paths`, async () => {
    await inProject(async () => {
      await write(".mcp.json", json(config()));
      await mkdir(dirname(linked), { recursive: true });
      await symlink(join(process.cwd(), ".mcp.json"), linked);
      const before = await readFile(".mcp.json", "utf8");
      const found = await plan();
      for (const path of [".mcp.json", linked]) {
        assert.equal(named(found, path), false, path);
        assert.match(
          report(found, path).reason,
          new RegExp(`\\.mcp\\.json and ${linked.replaceAll(".", "\\.")} lead to the same file`),
        );
      }
      await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
      assert.equal(await readFile(".mcp.json", "utf8"), before);
    });
  });
}

test("a harness file linked to a file eject deletes is kept and reported with it", async () => {
  await inProject(async () => {
    // Contrived, but a delete and an edit of one file must not both run either.
    await write(".calavera/state.json", json(createMcpServersJsonConfig(npmLaunch)));
    await symlink(join(process.cwd(), ".calavera/state.json"), ".mcp.json");
    const found = await plan();
    assert.equal(named(found, ".mcp.json"), false);
    assert.equal(named(found, ".calavera/state.json"), false);
    assert.match(report(found, ".mcp.json").reason, /lead to the same file/);
  });
});

test("codex: a file that is not TOML and links out of the project is reported, not a stop", async () => {
  await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
  await writeFile(join(outside.path, "config.toml"), "model = \n");
  await inProject(async () => {
    await mkdir(".codex");
    await symlink(join(outside.path, "config.toml"), CODEX);
    const found = await plan();
    assert.match(report(found, CODEX).reason, /may hold/);
  });
});

test("three harness paths that lead to one file are all named", async () => {
  await inProject(async () => {
    await write(
      ".mcp.json",
      json({ ...createMcpServersJsonConfig(npmLaunch), ...createOpenCodeMcpJsonConfig(npmLaunch) }),
    );
    await mkdir(".cursor");
    await symlink(join(process.cwd(), ".mcp.json"), ".cursor/mcp.json");
    await symlink(join(process.cwd(), ".mcp.json"), "opencode.json");
    const found = await plan();
    assert.match(
      report(found, "opencode.json").reason,
      /^\.mcp\.json, \.cursor\/mcp\.json and opencode\.json lead to the same file/,
    );
  });
});

test("a deleted link that leads to a harness file does not stop that file's edit", async () => {
  await inProject(async () => {
    await write(".mcp.json", json(createMcpServersJsonConfig(npmLaunch)));
    // Approval removes the link itself, so it changes nothing the edit writes.
    await symlink(join(process.cwd(), ".mcp.json"), "AGENTS.calavera.md");
    const found = await plan();
    assert.equal(item(found, "AGENTS.calavera.md").action, "delete");
    assert.equal(item(found, ".mcp.json").action, "edit");
    await ejectApproved();
    await assert.rejects(lstat("AGENTS.calavera.md"), { code: "ENOENT" });
    assert.equal(await readFile(".mcp.json", "utf8"), "{}\n");
  });
});

test("two deletes of one file are not a conflict, because the second finds it gone", async () => {
  await inProject(async () => {
    await write(".calavera/state.json", "{}\n");
    const found = await planEject({
      dryRun: false,
      config: ".calavera/state.json",
      guidance,
      loadFormatter,
    });
    assert.deepEqual(found.reported, []);
    assert.deepEqual(found.items.map(({ kind }) => kind).sort(), ["recipe", "state"]);
  });
});

test("codex: the report of an edited table names the table and the file", async () => {
  await inProject(async () => {
    await write(CODEX, codexBlock.replace('"npx"', '"mine"'));
    const found = await plan();
    assert.match(
      report(found, CODEX).reason,
      /^The \[mcp_servers\.calavera\] table in \.codex\/config\.toml differs from the table Calavera writes/,
    );
  });
});

test("codex: a key the person added that would duplicate one above once Calavera's lines go is kept and reported", async () => {
  await inProject(async () => {
    // Removing Calavera's three lines would move `enabled = true` into [other], which already
    // holds `enabled`, so the result is not TOML.
    await write(CODEX, `[other]\nenabled = false\n\n${codexBlock}enabled = true\n`);
    await assertKeptAndReported(CODEX, /differs from the table Calavera writes/);
  });
});

for (const { harness, path } of HARNESSES) {
  for (const [label, text] of [
    ["an empty", ""],
    ["a whitespace-only", "  \n\t\n"],
  ]) {
    test(`${harness}: ${label} harness file holds no entry and is left untouched`, async () => {
      await inProject(async () => {
        await write(path, text);
        const found = await plan();
        assert.equal(found.nothingToDo, true);
        assert.deepEqual(found.reported, []);
        await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
        assert.equal(await readFile(path, "utf8"), text);
      });
    });
  }
}
