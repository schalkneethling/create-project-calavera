// Issue #1204 (ADR-0022): `--init` writes the `calavera` entry in `opencode.json` under
// `mcp.servers`, the layout OpenCode 2 documents, with neither `enabled` nor `disabled`. It moves an
// unedited entry that 2.2.0 through 6.2.1 wrote directly under `mcp`, and it leaves the whole file
// unchanged, with a remedy, when any entry is edited (brief C8), when `mcp.servers` is not OpenCode
// 2's object of servers, or when the file has comments and holds an entry.
//
// The entries are spelled out here, not built from the current writers, so a change to the writers
// cannot also change what counts as an earlier release's entry.
import assert from "node:assert/strict";
import { mkdtempDisposable, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { agentBootstrap } from "../src/index.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const current = packageJson.version;
const SCHEMA = "https://opencode.ai/config.json";
const PATH = "opencode.json";

/** @param {string} version @param {string} [runner] */
const command = (version, runner = "npx") => [
  ...(runner === "npx" ? ["npx"] : [runner, "dlx"]),
  "--package",
  `create-project-calavera@${version}`,
  "create-project-calavera-mcp",
];
/** The entry 7.0.0 onward writes under `mcp.servers`. @param {string} version @param {string} [runner] */
const v2Entry = (version, runner) => ({ type: "local", command: command(version, runner) });
/** The entry 2.2.0 through 6.2.1 wrote directly under `mcp`. @param {string} version @param {string} [runner] */
const v1Entry = (version, runner) => ({ ...v2Entry(version, runner), enabled: true });
const otherServer = { type: "local", command: ["node", "server.js"], enabled: true };

/** @param {unknown} value */
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;

/**
 * Runs `callback` inside a new temporary project, with no `opencode` on PATH, so the version check
 * of ADR-0022, Decision 6, gives no warning here; `opencode-version.test.mjs` covers it.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-init-opencode-v2-"));
  await using emptyBin = await mkdtempDisposable(join(tmpdir(), "calavera-init-opencode-bin-"));
  const originalDirectory = process.cwd();
  const originalPath = process.env.PATH;
  process.env.PATH = emptyBin.path;
  process.chdir(await realpath(project.path));
  try {
    await callback();
  } finally {
    process.chdir(originalDirectory);
    process.env.PATH = originalPath;
  }
}

/** @param {boolean} [dryRun] */
const init = (dryRun = false) =>
  agentBootstrap({ json: true, mcpHarness: "opencode", packageManager: "npm", dryRun });

/** @param {Awaited<ReturnType<typeof agentBootstrap>>} result */
function changeFor(result) {
  const listed = result.changes.filter((change) => change.path === PATH);
  assert.equal(listed.length, 1, `${PATH} is listed once`);
  return /** @type {(typeof listed)[number]} */ (listed[0]);
}

/**
 * Asserts that `--init` kept the file byte for byte and listed it once as skipped, under every
 * run mode, and returns the reason.
 *
 * @param {string} before
 */
async function assertKept(before) {
  /** @type {string[]} */
  const reasons = [];
  for (const dryRun of [true, false]) {
    const result = await init(dryRun);
    assert.equal(await readFile(PATH, "utf8"), before, `${PATH} is unchanged`);
    assert.equal(result.mcp.action, "skip");
    const change = changeFor(result);
    assert.equal(change.type, "skip");
    assert.ok(!result.pointers.some((pointer) => pointer.includes(PATH)), "named once");
    reasons.push(change.reason ?? "");
  }
  assert.equal(reasons[0], reasons[1]);
  return /** @type {string} */ (reasons[0]);
}

test("a new opencode.json gets the entry under mcp.servers, without enabled or disabled", async () => {
  await inProject(async () => {
    const result = await init();
    assert.equal(result.mcp.action, "write");
    assert.deepEqual(JSON.parse(await readFile(PATH, "utf8")), {
      $schema: SCHEMA,
      mcp: { servers: { calavera: v2Entry(current) } },
    });
  });
});

test("an opencode.json without a calavera entry gets one under mcp.servers, beside the person's servers", async () => {
  await inProject(async () => {
    await writeFile(PATH, json({ theme: "system", mcp: { other: otherServer } }));
    const result = await init();
    assert.equal(result.mcp.action, "update");
    assert.equal(changeFor(result).reason, "Add or update Calavera MCP server.");
    assert.deepEqual(JSON.parse(await readFile(PATH, "utf8")), {
      theme: "system",
      $schema: SCHEMA,
      mcp: { other: otherServer, servers: { calavera: v2Entry(current) } },
    });
  });
});

test("an unedited entry an earlier release wrote under mcp moves to mcp.servers in one write, and the move is reported", async () => {
  await inProject(async () => {
    // Written by 6.2.1 for pnpm, while the project now uses npm.
    const before = json({
      $schema: SCHEMA,
      mcp: { other: otherServer, calavera: v1Entry("6.2.1", "pnpm") },
    });
    await writeFile(PATH, before);

    const dryRun = await init(true);
    assert.equal(await readFile(PATH, "utf8"), before, "the dry run writes nothing");
    assert.equal(dryRun.mcp.action, "update");
    assert.match(
      changeFor(dryRun).reason ?? "",
      /^Would move the calavera entry from mcp to mcp\.servers, the layout OpenCode 2 reads\. OpenCode's migration guide says not to point OpenCode 1\.x at files in this layout: install OpenCode 2, or restore the file from version control\.$/,
    );

    const result = await init();
    assert.equal(result.mcp.action, "update");
    const change = changeFor(result);
    assert.equal(change.type, "update");
    assert.match(change.reason ?? "", /^Moved the calavera entry from mcp to mcp\.servers, /);
    assert.deepEqual(JSON.parse(await readFile(PATH, "utf8")), {
      $schema: SCHEMA,
      mcp: { other: otherServer, servers: { calavera: v2Entry(current) } },
    });

    // A second run finds the file up to date.
    const again = await init();
    assert.equal(again.mcp.action, "skip");
    assert.equal(changeFor(again).reason, "Already up to date.");
  });
});

test("an unedited entry under mcp.servers is updated to the current version", async () => {
  await inProject(async () => {
    await writeFile(
      PATH,
      json({ $schema: SCHEMA, mcp: { servers: { calavera: v2Entry("6.2.1", "pnpm") } } }),
    );
    const result = await init();
    assert.equal(result.mcp.action, "update");
    assert.equal(changeFor(result).reason, "Add or update Calavera MCP server.");
    assert.deepEqual(JSON.parse(await readFile(PATH, "utf8")).mcp, {
      servers: { calavera: v2Entry(current) },
    });
  });
});

test("unedited entries in both places become one entry under mcp.servers, and the move is reported", async () => {
  await inProject(async () => {
    await writeFile(
      PATH,
      json({
        mcp: { calavera: v1Entry("6.2.1"), servers: { calavera: v2Entry("6.2.1", "pnpm") } },
      }),
    );
    const result = await init();
    assert.match(
      changeFor(result).reason ?? "",
      /^Moved the calavera entry from mcp to mcp\.servers/,
    );
    assert.deepEqual(JSON.parse(await readFile(PATH, "utf8")).mcp, {
      servers: { calavera: v2Entry(current) },
    });
  });
});

test("C8: an edited entry under mcp is never rewritten or moved, and the remedy points to OpenCode 2", async () => {
  await inProject(async () => {
    const before = json({
      mcp: { calavera: { ...v1Entry("6.2.1"), environment: { TOKEN: "SECRET-1204" } } },
    });
    await writeFile(PATH, before);
    const reason = await assertKept(before);
    assert.equal(
      reason,
      "The calavera entry under mcp in opencode.json differs from every entry a Calavera release wrote, so it was left unchanged as a local edit. OpenCode 2 reads servers from mcp.servers: move the entry there and replace enabled with disabled, as OpenCode's migration guide describes, or remove it, then run --init again.",
    );
  });
});

test("an edited entry under mcp that holds only enabled gets the remedy for a switch", async () => {
  await inProject(async () => {
    const before = json({ mcp: { calavera: { enabled: false } } });
    await writeFile(PATH, before);
    assert.match(
      await assertKept(before),
      /That entry holds only enabled, which OpenCode 1\.x uses to switch off a server configured elsewhere: remove it, or set "disabled": true on a full calavera entry under mcp\.servers, then run --init again\.$/,
    );
  });
});

test("C8: an edited entry under mcp.servers is kept with the default remedy", async () => {
  await inProject(async () => {
    const before = json({
      mcp: { servers: { calavera: { ...v2Entry(current), disabled: true } } },
    });
    await writeFile(PATH, before);
    assert.equal(
      await assertKept(before),
      "The calavera entry under mcp.servers in opencode.json differs from every entry a Calavera release wrote, so it was left unchanged as a local edit. To use Calavera's entry instead, remove yours, then run --init again.",
    );
  });
});

test("C8: an edited entry beside an unedited one keeps the whole file, and the reason names both in file order with one remedy", async () => {
  for (const [label, mcp, expectedOrder] of /** @type {const} */ ([
    [
      "edited under mcp",
      {
        calavera: { ...v1Entry("6.2.1"), environment: { A: "1" } },
        servers: { calavera: v2Entry(current) },
      },
      [
        "The calavera entry under mcp in opencode.json differs from every entry a Calavera release wrote, so it was left unchanged as a local edit.",
        "The calavera entry under mcp.servers is one a Calavera release wrote.",
      ],
    ],
    [
      "edited under mcp.servers",
      {
        servers: { calavera: { ...v2Entry(current), cwd: "tools" } },
        calavera: v1Entry("6.2.1"),
      },
      [
        "The calavera entry under mcp.servers in opencode.json differs from every entry a Calavera release wrote, so it was left unchanged as a local edit.",
        "The calavera entry under mcp is one a Calavera release wrote.",
      ],
    ],
  ])) {
    await inProject(async () => {
      const before = json({ mcp });
      await writeFile(PATH, before);
      const reason = await assertKept(before);
      assert.ok(reason.startsWith(expectedOrder.join(" ")), `${label}: ${reason}`);
      assert.match(reason, /The file holds two calavera servers, so it was left unchanged\./);
      assert.equal(reason.match(/then run --init again|Then run --init again/g)?.length, 1);
      assert.ok(!reason.includes("SECRET"));
    });
  }
});

test("an entry pinned to a version npm does not have is kept and the reason names the pin", async () => {
  await inProject(async () => {
    const before = json({ mcp: { servers: { calavera: v2Entry("99.0.0") } } });
    await writeFile(PATH, before);
    const reason = await assertKept(before);
    assert.match(reason, /pins a version of create-project-calavera that this release/);
    assert.ok(!reason.includes("99.0.0"));
  });
});

for (const [label, servers, expected] of /** @type {const} */ ([
  [
    "an OpenCode 1.x server named servers",
    { type: "local", command: ["node", "servers.js"], enabled: true },
    "opencode.json holds a server named servers directly under mcp, a name OpenCode 2 reserves for the object that holds servers, so it was left unchanged. Rename that server, then run --init again.",
  ],
  [
    "an OpenCode 1.x switch for a server named servers",
    { enabled: false },
    "opencode.json holds an enabled switch for a server named servers directly under mcp, a name OpenCode 2 reserves for the object that holds servers, so it was left unchanged. Rename or remove it, then run --init again.",
  ],
  [
    "an array",
    ["calavera"],
    "opencode.json holds an mcp.servers member that is not an object of servers, so it was left unchanged. Correct it as OpenCode's MCP documentation describes, then run --init again.",
  ],
  [
    "an object with a member that is not an object",
    { calavera: v2Entry(current), note: "mine" },
    "opencode.json holds an mcp.servers member that is not an object of servers, so it was left unchanged. Correct it as OpenCode's MCP documentation describes, then run --init again.",
  ],
])) {
  test(`an mcp.servers that is ${label} keeps the file, and calavera is never written into it`, async () => {
    await inProject(async () => {
      // An unedited entry under mcp would otherwise move into `servers`.
      const before = json({ mcp: { calavera: v1Entry("6.2.1"), servers } });
      await writeFile(PATH, before);
      assert.equal(await assertKept(before), expected);
    });
  });
}

test("an OpenCode 2 container that holds a server named type is still the container", async () => {
  await inProject(async () => {
    const type = { type: "local", command: ["node", "type.js"] };
    await writeFile(PATH, json({ mcp: { servers: { type } } }));
    await init();
    assert.deepEqual(JSON.parse(await readFile(PATH, "utf8")).mcp, {
      servers: { type, calavera: v2Entry(current) },
    });
  });
});

for (const [label, text, sentences] of [
  [
    "an entry under mcp",
    `{\n  // mine\n  "mcp": { "calavera": ${JSON.stringify(v1Entry("6.2.1"))} }\n}\n`,
    [
      "Move the calavera entry under mcp.servers yourself, as the setup notes in .agents/calavera/mcp.md show, and remove enabled.",
    ],
  ],
  [
    "an entry under mcp.servers",
    `{ "mcp": { "servers": { "calavera": ${JSON.stringify(v2Entry("6.2.1"))}, }, }, }\n`,
    [
      "Calavera does not update the version its calavera entry pins in a file with comments. To update it, change the create-project-calavera@<version> in the entry's command to the version the setup notes in .agents/calavera/mcp.md show.",
    ],
  ],
  [
    "entries in both places",
    `{\n  /* both */\n  "mcp": {\n    "servers": { "calavera": ${JSON.stringify(v2Entry("6.2.1"))} },\n    "calavera": ${JSON.stringify(v1Entry("6.2.1"))}\n  }\n}\n`,
    [
      "Calavera does not update the version its calavera entry pins in a file with comments.",
      "Move the calavera entry under mcp.servers yourself,",
    ],
  ],
]) {
  test(`a file with comments or trailing commas and ${label} is kept, never rewritten`, async () => {
    await inProject(async () => {
      await writeFile(PATH, /** @type {string} */ (text));
      const reason = await assertKept(/** @type {string} */ (text));
      const opener =
        "opencode.json has comments or trailing commas, which Calavera would lose by rewriting it, so it was left unchanged.";
      assert.ok(reason.startsWith(`${opener} `), reason);
      // The sentences follow the order of the file.
      let from = 0;
      for (const sentence of /** @type {string[]} */ (sentences)) {
        const at = reason.indexOf(sentence, from);
        assert.ok(at !== -1 && at >= from, `${sentence} in order in ${reason}`);
        from = at + 1;
      }
    });
  });
}

test("a file with comments and an mcp.servers that is not the container gives both sentences and no entry remedy", async () => {
  await inProject(async () => {
    const text = `{\n  // mine\n  "mcp": { "servers": { "type": "local", "command": ["x"] } }\n}\n`;
    await writeFile(PATH, text);
    assert.equal(
      await assertKept(text),
      "opencode.json has comments or trailing commas, which Calavera would lose by rewriting it, so it was left unchanged. opencode.json holds a server named servers directly under mcp, a name OpenCode 2 reserves for the object that holds servers, so it was left unchanged. Rename that server, then run --init again.",
    );
  });
});

test("a file with comments and no calavera entry is a manual setup with its own reason", async () => {
  await inProject(async () => {
    const text = `{\n  // mine\n  "theme": "system",\n}\n`;
    await writeFile(PATH, text);
    const result = await init();
    assert.equal(await readFile(PATH, "utf8"), text);
    assert.equal(result.mcp.action, "manual");
    assert.match(
      result.mcp.reason ?? "",
      /^Could not write project MCP config at opencode\.json: opencode\.json has comments or trailing commas, which Calavera would lose by rewriting it, so Calavera did not add its entry\. Add the calavera entry from \.agents\/calavera\/mcp\.md under mcp\.servers yourself\. /,
    );
    assert.equal(
      result.changes.some((change) => change.path === PATH),
      false,
    );
  });
});

for (const [label, text, message] of [
  ["an empty file", "", /opencode\.json cannot be parsed as JSON: .*Correct the JSON there/],
  [
    "a whitespace-only file",
    "  \n",
    /opencode\.json cannot be parsed as JSON: .*Correct the JSON there/,
  ],
  ["text that is not JSONC either", "{ mcp: ", /opencode\.json cannot be parsed as JSON: /],
  ["a top level that is not an object", "[]\n", /opencode\.json must contain a JSON object/],
  ["an mcp that is not an object", '{ "mcp": [] }\n', /opencode\.json mcp must be an object/],
]) {
  test(`${label} is a manual setup with today's message`, async () => {
    await inProject(async () => {
      await writeFile(PATH, text);
      const result = await init();
      assert.equal(await readFile(PATH, "utf8"), text);
      assert.equal(result.mcp.action, "manual");
      assert.match(result.mcp.reason ?? "", message);
    });
  });
}

test("no writer writes the entry an earlier release wrote: neither enabled nor mcp.calavera appears", async () => {
  await inProject(async () => {
    await writeFile(PATH, json({ mcp: { calavera: v1Entry("6.2.1") } }));
    await init();
    const text = await readFile(PATH, "utf8");
    assert.doesNotMatch(text, /"enabled"/);
    assert.equal(Object.hasOwn(JSON.parse(text).mcp, "calavera"), false);
    const notes = (await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" })).changes;
    assert.ok(notes.some((change) => change.path === ".agents/calavera/mcp.md"));
    const setup = await readFile(".agents/calavera/mcp.md", "utf8");
    const opencode = setup.slice(setup.indexOf("### OpenCode"));
    assert.doesNotMatch(
      opencode.slice(0, opencode.indexOf("Project-local MCP servers")),
      /enabled/,
    );
    assert.match(setup, /Calavera requires OpenCode 2\./);
  });
});
