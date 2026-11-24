// Issue #1221: in a Vite+ project, a JSON harness file that already passes the project's formatter
// still passes it after `--init` edits Calavera's entry, so `vp check` stays green. A file the
// formatter would change keeps the person's bytes, with only the entry edited, because formatting
// it would rewrite the person's lines too (brief C8). The stand-in `vp fmt` runs this repository's
// Oxfmt, which keeps a byte order mark and writes LF line endings.
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import test from "node:test";

import {
  openCodeMcpLocations,
  writeMcpServersJsonConfig,
  writeOpenCodeMcpConfig,
} from "../src/utils/mcp-config.js";
import { loadProjectFormatter } from "../src/utils/project-formatter.js";
import { createTemporaryFixture, writeVitePlusFormatter } from "./vite-plus-fixtures.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const current = packageJson.version;
const args = ["--package", `create-project-calavera@${current}`, "create-project-calavera-mcp"];
const entry = { command: "npx", args };
/** @param {string} version */
const pnpmLaunch = (version) => ({
  command: "pnpm",
  args: ["dlx", "--package", `create-project-calavera@${version}`, "create-project-calavera-mcp"],
});
const earlier = pnpmLaunch("5.0.0");
// The entries this release writes, one for each package manager tested here.
const entries = [entry, pnpmLaunch(current)];

/**
 * Runs `callback` inside a Vite+ project whose `vp fmt` is the stand-in, with the formatter
 * `--init` loads there.
 *
 * @param {(format: (path: string, text: string) => Promise<string>, load: () => Promise<import("../src/utils/project-formatter.js").ProjectFormatter>) => Promise<void>} callback
 */
async function inVitePlusProject(callback) {
  await using project = await createTemporaryFixture("mcp-formatting", {});
  await writeVitePlusFormatter(project.root);
  const formatter = await loadProjectFormatter(project.root, "managed");
  const originalDirectory = process.cwd();
  process.chdir(project.root);
  try {
    await callback(formatter.format, async () => formatter);
  } finally {
    process.chdir(originalDirectory);
  }
}

/**
 * @param {string} path
 * @param {Record<string, unknown>} calavera
 * @param {() => Promise<import("../src/utils/project-formatter.js").ProjectFormatter>} load
 */
async function writeEntry(path, calavera, load) {
  /** @type {import("../src/utils/mcp-config.js").McpConfigChange[]} */
  const changes = [];
  const action = await writeMcpServersJsonConfig(path, calavera, entries, false, changes, load);
  return { action, changes };
}

for (const bom of ["", "﻿"]) {
  const label = bom ? " with a byte order mark" : "";
  test(`a formatted .mcp.json${label} stays formatted when the entry is added or updated, and the person's lines keep their bytes`, async () => {
    await inVitePlusProject(async (format, load) => {
      for (const calavera of [undefined, earlier]) {
        const person = '    "other": { "command": "node", "args": ["server.js"] }';
        const before = await format(
          ".mcp.json",
          `${bom}{\n  "theme": "dark",\n  "1": true,\n  "mcpServers": {\n${calavera ? `    "calavera": ${JSON.stringify(calavera)},\n` : ""}${person}\n  }\n}\n`,
        );
        assert.ok(before.includes(person), "precondition: Oxfmt keeps the person's server inline");
        await writeFile(".mcp.json", before);

        const { action } = await writeEntry(".mcp.json", entry, load);
        const after = await readFile(".mcp.json", "utf8");

        assert.equal(action, "update");
        assert.equal(after, await format(".mcp.json", after), "vp fmt --check passes");
        assert.ok(after.startsWith(`${bom}{\n  "theme": "dark",\n  "1": true,\n`), after);
        assert.ok(after.includes(person), "the person's server keeps its line");
        // The formatter ran: Oxfmt puts the entry's arguments on one line.
        assert.ok(after.includes(`"args": ${JSON.stringify(args).replaceAll(",", ", ")}`), after);
        assert.deepEqual(JSON.parse(after.slice(bom.length)).mcpServers.calavera, entry);
      }
    });
  });
}

test("a .mcp.json the formatter would change keeps the person's bytes, with only the entry edited", async () => {
  await inVitePlusProject(async (format, load) => {
    const head =
      '{\r\n    "1": true,\r\n    "mcpServers": {\r\n        "other": { "command": "node" }';
    const before = `${head}\r\n    }\r\n}\r\n`;
    assert.notEqual(await format(".mcp.json", before), before, "precondition: vp fmt changes it");
    await writeFile(".mcp.json", before);

    const { action } = await writeEntry(".mcp.json", entry, load);

    assert.equal(action, "update");
    const indented = JSON.stringify(entry, null, "    ").replaceAll("\n", "\r\n        ");
    assert.equal(
      await readFile(".mcp.json", "utf8"),
      `${head},\r\n        "calavera": ${indented}\r\n    }\r\n}\r\n`,
    );
  });
});

test("a formatted opencode.json stays formatted when the entry moves from mcp to mcp.servers", async () => {
  await inVitePlusProject(async (format, load) => {
    const before = await format(
      "opencode.json",
      `${JSON.stringify(
        {
          $schema: "https://opencode.ai/config.json",
          mcp: {
            calavera: {
              type: "local",
              command: [
                "npx",
                "--package",
                "create-project-calavera@6.2.1",
                "create-project-calavera-mcp",
              ],
              enabled: true,
            },
            other: { type: "local", command: ["node", "server.js"], enabled: true },
          },
        },
        null,
        2,
      )}\n`,
    );
    await writeFile("opencode.json", before);
    const launch = { command: "npx", args };
    /** @type {import("../src/utils/mcp-config.js").McpConfigChange[]} */
    const changes = [];

    const action = await writeOpenCodeMcpConfig(
      "opencode.json",
      launch,
      openCodeMcpLocations([launch]),
      false,
      changes,
      load,
    );
    const after = await readFile("opencode.json", "utf8");

    assert.equal(action, "update");
    assert.equal(after, await format("opencode.json", after), "vp fmt --check passes");
    assert.deepEqual(JSON.parse(after), {
      $schema: "https://opencode.ai/config.json",
      mcp: {
        other: { type: "local", command: ["node", "server.js"], enabled: true },
        servers: { calavera: { type: "local", command: ["npx", ...args] } },
      },
    });
  });
});
