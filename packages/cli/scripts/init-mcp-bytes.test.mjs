// Issue #1221: when `--init` adds Calavera's MCP entry to a JSON harness file, updates the entry an
// earlier release wrote, or moves OpenCode's entry from `mcp` to `mcp.servers`, every byte outside
// that entry stays as the person wrote it: indentation, line endings, a byte order mark, and key
// order, including an integer-like key such as "1", which JSON.parse would move ahead of the
// others (brief C8).
//
// Each file is spelled out line by line, so the expected text is the person's text with only the
// entry changed. The person's other server sits on one line, which a whole-line reformat would
// expand. The project does not use Vite+, so no formatter runs; `mcp-config-formatting.test.mjs`
// covers a project that does.
import assert from "node:assert/strict";
import { mkdir, mkdtempDisposable, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { agentBootstrap } from "../src/index.js";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const current = packageJson.version;

/** @param {string} version @param {string} [runner] */
const command = (version, runner = "npx") => [
  ...(runner === "npx" ? ["npx"] : [runner, "dlx"]),
  "--package",
  `create-project-calavera@${version}`,
  "create-project-calavera-mcp",
];
/** @param {string} version @param {string} [runner] */
const launch = (version, runner) => {
  const [first, ...args] = command(version, runner);
  return { command: /** @type {string} */ (first), args };
};

/**
 * @typedef {{ label: string, unit: string, eol: string, bom: string }} Style
 * @typedef {(style: Style, value: unknown, depth: number) => string} Render
 */

/** @type {Style[]} */
const styles = [
  { label: "4-space indentation", unit: "    ", eol: "\n", bom: "" },
  { label: "tab indentation", unit: "\t", eol: "\n", bom: "" },
  { label: "CRLF line endings", unit: "  ", eol: "\r\n", bom: "" },
  { label: "a byte order mark", unit: "  ", eol: "\n", bom: "﻿" },
];

/**
 * `value` as JSON in `style`, for a value whose line is indented `depth` levels: the text this
 * change writes for Calavera's entry.
 *
 * @type {Render}
 */
const render = ({ unit, eol }, value, depth) =>
  JSON.stringify(value, null, unit).replaceAll("\n", `${eol}${unit.repeat(depth)}`);

/**
 * The file's text from its lines, each given as [depth, text].
 *
 * @param {Style} style
 * @param {[number, string][]} lines
 */
const text = ({ unit, eol, bom }, lines) =>
  `${bom}${lines.map(([depth, line]) => `${unit.repeat(depth)}${line}`).join(eol)}${eol}`;

/**
 * A `.mcp.json` or `.cursor/mcp.json` with the person's keys around `mcpServers`, and the
 * `calavera` entry before or after the person's server, or none.
 *
 * @param {Style} style
 * @param {{ first?: unknown, last?: unknown }} calavera
 */
function mcpServersFile(style, { first, last }) {
  return text(style, [
    [0, "{"],
    [1, '"theme": "dark",'],
    [1, '"1": true,'],
    [1, '"mcpServers": {'],
    ...(first === undefined
      ? []
      : /** @type {[number, string][]} */ ([[2, `"calavera": ${render(style, first, 2)},`]])),
    [2, `"other": { "command": "node", "args": ["server.js"] }${last === undefined ? "" : ","}`],
    ...(last === undefined
      ? []
      : /** @type {[number, string][]} */ ([[2, `"calavera": ${render(style, last, 2)}`]])),
    [1, "},"],
    [1, '"2": false'],
    [0, "}"],
  ]);
}

/**
 * An `opencode.json` in OpenCode 2's layout, with the `calavera` entry under `mcp.servers` before
 * or after the person's server, or none.
 *
 * @param {Style} style
 * @param {{ first?: unknown, last?: unknown }} calavera
 */
function openCodeFile(style, { first, last }) {
  return text(style, [
    [0, "{"],
    [1, '"$schema": "https://opencode.ai/config.json",'],
    [1, '"1": true,'],
    [1, '"mcp": {'],
    [2, '"servers": {'],
    ...(first === undefined
      ? []
      : /** @type {[number, string][]} */ ([[3, `"calavera": ${render(style, first, 3)},`]])),
    [
      3,
      `"other": { "type": "local", "command": ["node", "server.js"] }${last === undefined ? "" : ","}`,
    ],
    ...(last === undefined
      ? []
      : /** @type {[number, string][]} */ ([[3, `"calavera": ${render(style, last, 3)}`]])),
    [2, "}"],
    [1, "},"],
    [1, '"2": false'],
    [0, "}"],
  ]);
}

const harnesses = /** @type {const} */ ([
  {
    harness: "claude-code",
    path: ".mcp.json",
    file: mcpServersFile,
    earlier: launch("5.0.0", "pnpm"),
    written: launch(current),
  },
  {
    harness: "cursor",
    path: ".cursor/mcp.json",
    file: mcpServersFile,
    // 6.2.1 and earlier releases wrote the launch command alone, without `type` (#1089).
    earlier: launch("5.0.0", "pnpm"),
    written: { type: "stdio", ...launch(current) },
  },
  {
    harness: "opencode",
    path: "opencode.json",
    file: openCodeFile,
    earlier: { type: "local", command: command("5.0.0", "pnpm") },
    written: { type: "local", command: command(current) },
  },
]);

/**
 * Runs `callback` inside a new temporary project, with an empty PATH so no `opencode` is found and
 * its version check gives no warning.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-init-mcp-bytes-"));
  await using emptyBin = await mkdtempDisposable(join(tmpdir(), "calavera-init-mcp-bytes-bin-"));
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

/** @param {string} path @param {string} contents */
async function write(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

/** @param {(typeof harnesses)[number]["harness"]} harness @param {boolean} [dryRun] */
const init = (harness, dryRun = false) =>
  agentBootstrap({ json: true, mcpHarness: harness, packageManager: "npm", dryRun });

for (const { harness, path, file, earlier, written } of harnesses) {
  for (const style of styles) {
    test(`${path} with ${style.label}: adding the entry changes no other byte`, async () => {
      await inProject(async () => {
        const before = file(style, {});
        await write(path, before);

        const preview = await init(harness, true);
        assert.equal(preview.mcp.action, "update");
        assert.equal(await readFile(path, "utf8"), before, "the dry run writes nothing");

        const result = await init(harness);
        assert.equal(result.mcp.action, "update");
        assert.equal(await readFile(path, "utf8"), file(style, { last: written }));
      });
    });

    test(`${path} with ${style.label}: updating an earlier release's entry changes no other byte`, async () => {
      await inProject(async () => {
        await write(path, file(style, { first: earlier }));

        const result = await init(harness);
        assert.equal(result.mcp.action, "update");
        assert.equal(await readFile(path, "utf8"), file(style, { first: written }));

        const again = await init(harness);
        assert.equal(again.mcp.action, "skip", "a second run finds the entry up to date");
        assert.deepEqual(
          again.changes.filter((change) => change.path === path),
          [{ type: "skip", path, reason: "Already up to date." }],
        );
        assert.equal(await readFile(path, "utf8"), file(style, { first: written }));
      });
    });
  }
}

for (const style of styles) {
  test(`opencode.json with ${style.label}: moving the entry from mcp to mcp.servers changes no other byte`, async () => {
    await inProject(async () => {
      const other =
        '"other": { "type": "local", "command": ["node", "server.js"], "enabled": true }';
      const tail = /** @type {[number, string][]} */ ([
        [1, "},"],
        [1, '"2": false'],
        [0, "}"],
      ]);
      const head = /** @type {[number, string][]} */ ([
        [0, "{"],
        [1, '"$schema": "https://opencode.ai/config.json",'],
        [1, '"1": true,'],
        [1, '"mcp": {'],
      ]);
      const earlier = { type: "local", command: command("6.2.1", "pnpm"), enabled: true };
      await write(
        "opencode.json",
        text(style, [
          ...head,
          [2, `"calavera": ${render(style, earlier, 2)},`],
          [2, other],
          ...tail,
        ]),
      );

      const result = await init("opencode");
      assert.equal(result.mcp.action, "update");
      assert.equal(
        await readFile("opencode.json", "utf8"),
        text(style, [
          ...head,
          [2, `${other},`],
          [
            2,
            `"servers": ${render(style, { calavera: { type: "local", command: command(current) } }, 2)}`,
          ],
          ...tail,
        ]),
      );
    });
  });
}

test("opencode.json: moving the only member of mcp leaves mcp holding mcp.servers alone", async () => {
  await inProject(async () => {
    const style = /** @type {Style} */ (styles[0]);
    const earlier = { type: "local", command: command("6.2.1"), enabled: true };
    await write(
      "opencode.json",
      text(style, [
        [0, "{"],
        [1, '"1": true,'],
        [1, `"mcp": ${render(style, { calavera: earlier }, 1)}`],
        [0, "}"],
      ]),
    );

    const result = await init("opencode");
    assert.equal(result.mcp.action, "update");
    assert.equal(
      await readFile("opencode.json", "utf8"),
      text(style, [
        [0, "{"],
        [1, '"1": true,'],
        [
          1,
          `"mcp": ${render(style, { servers: { calavera: { type: "local", command: command(current) } } }, 1)},`,
        ],
        [1, `"$schema": "https://opencode.ai/config.json"`],
        [0, "}"],
      ]),
    );
  });
});

test("an empty JSON harness file object gets the entry on its own lines", async () => {
  for (const { harness, path, written } of harnesses) {
    await inProject(async () => {
      await write(path, "{}\n");
      const result = await init(harness);
      assert.equal(result.mcp.action, "update", path);
      const expected =
        harness === "opencode"
          ? {
              $schema: "https://opencode.ai/config.json",
              mcp: { servers: { calavera: written } },
            }
          : { mcpServers: { calavera: written } };
      assert.equal(await readFile(path, "utf8"), `${JSON.stringify(expected, null, 2)}\n`, path);
    });
  }
});
