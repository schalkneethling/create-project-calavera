// Issue #704: the plugins in plugins/ serve two formats from one folder. Agent
// Plugins reads plugin.json, skills/, and mcp.json; Claude Code reads the
// marketplace entry in .claude-plugin/marketplace.json. These tests keep the two
// in step, so a mismatch fails here instead of on a user's machine.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const pluginsPath = join(root, "plugins");
const schemasPath = join(root, "scripts/schemas/agent-plugins/1.0.0");

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

const marketplace = await readJson(join(root, ".claude-plugin/marketplace.json"));
const pluginNames = (await readdir(pluginsPath, { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

const ajv = new Ajv2020({ allErrors: true, strict: true });
const validatePluginManifest = ajv.compile(await readJson(join(schemasPath, "plugin.schema.json")));
const validateMcpConfig = ajv.compile(await readJson(join(schemasPath, "mcp.schema.json")));

function entryFor(name) {
  const entry = marketplace.plugins.find((plugin) => plugin.name === name);
  assert.ok(entry, `plugins/${name} has no entry in .claude-plugin/marketplace.json`);
  return entry;
}

// Returns the lines between the opening and closing `---` of a SKILL.md file.
function frontmatterLines(markdown, path) {
  const lines = markdown.replaceAll("\r\n", "\n").split("\n");
  assert.equal(lines[0], "---", `${path} must start with YAML frontmatter`);
  const closing = lines.indexOf("---", 1);
  assert.ok(closing > 0, `${path} must close its YAML frontmatter`);
  return lines.slice(1, closing);
}

// Returns the indented lines that belong to a top-level frontmatter key.
function blockUnder(lines, key) {
  const start = lines.indexOf(`${key}:`);
  if (start < 0) return [];
  // A blank line does not end the block; the next unindented line does.
  const end = lines.findIndex(
    (line, index) => index > start && line.trim() !== "" && !line.startsWith(" "),
  );
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

test("the marketplace is named calavera and has a description", () => {
  // The name is part of every install ID, such as dependency-review@calavera,
  // and of every enabledPlugins key in users' settings, so it never changes.
  assert.equal(marketplace.name, "calavera");
  assert.equal(typeof marketplace.description, "string");
  assert.ok(marketplace.description.length > 0);
});

test("the marketplace lists exactly the folders under plugins/", () => {
  const entryNames = marketplace.plugins.map((plugin) => plugin.name);

  assert.ok(pluginNames.length > 0, "plugins/ has no plugin folders");
  assert.deepEqual(entryNames.toSorted(), pluginNames);
  assert.equal(new Set(entryNames).size, entryNames.length, "Duplicate marketplace entry names");
});

test("each marketplace entry points at its own folder with a relative source", () => {
  for (const name of pluginNames) {
    assert.equal(entryFor(name).source, `./plugins/${name}`);
  }
});

test("each plugin.json matches the Agent Plugins 1.0.0 schema and its folder name", async () => {
  for (const name of pluginNames) {
    const path = join(pluginsPath, name, "plugin.json");
    const manifest = await readJson(path);

    assert.ok(
      validatePluginManifest(manifest),
      `${path}: ${ajv.errorsText(validatePluginManifest.errors)}`,
    );
    assert.equal(manifest.name, name, `${path} name must match its folder`);
  }
});

test("no plugin has its own Claude Code manifest", () => {
  for (const name of pluginNames) {
    // A Claude manifest without a version fails claude plugin validate --strict,
    // and one with a version pins users to it, so the entry is the only one.
    assert.equal(
      existsSync(join(pluginsPath, name, ".claude-plugin/plugin.json")),
      false,
      `plugins/${name}/.claude-plugin/plugin.json: move its fields into the plugin's entry in .claude-plugin/marketplace.json`,
    );
  }
});

test("no plugin sets a version, so Claude Code versions it by commit", async () => {
  for (const name of pluginNames) {
    const manifest = await readJson(join(pluginsPath, name, "plugin.json"));

    assert.equal(
      "version" in entryFor(name),
      false,
      `${name}: remove version from its marketplace entry`,
    );
    assert.equal("version" in manifest, false, `${name}: remove version from plugin.json`);
  }
});

test("hooks are only declared inline in the marketplace entry", () => {
  for (const name of pluginNames) {
    const { hooks } = entryFor(name);

    // Claude Code loads hooks from a marketplace entry only in the inline form.
    assert.equal(
      existsSync(join(pluginsPath, name, "hooks")),
      false,
      `plugins/${name}/hooks: declare hooks inline in the marketplace entry`,
    );
    if (hooks !== undefined) {
      assert.ok(
        typeof hooks === "object" && hooks !== null && !Array.isArray(hooks),
        `${name}: hooks in the marketplace entry must be an inline object`,
      );
    }
  }
});

test("each skill is at skills/<name>/SKILL.md, named after its folder, and hidden from the skills CLI", async () => {
  for (const name of pluginNames) {
    const pluginPath = join(pluginsPath, name);
    const skillFiles = (await readdir(pluginPath, { recursive: true }))
      .map((path) => path.split("\\").join("/"))
      .filter((path) => basename(path) === "SKILL.md");

    for (const relativePath of skillFiles) {
      const path = join(pluginPath, relativePath);
      const match = /^skills\/([^/]+)\/SKILL\.md$/.exec(relativePath);
      assert.ok(match, `${path}: put each skill directly in skills/<name>/SKILL.md`);

      const lines = frontmatterLines(await readFile(path, "utf8"), path);
      assert.ok(lines.includes(`name: ${match[1]}`), `${path}: name must be ${match[1]}`);
      // Without this, the skills CLI lists these skills instead of the bundled
      // ones for the whole repository, and they only work inside the plugin.
      // The skills CLI needs the YAML boolean, not the string "true".
      assert.ok(
        blockUnder(lines, "metadata").includes("  internal: true"),
        `${path}: add "metadata:" with "  internal: true" to the frontmatter`,
      );
    }
  }
});

test("MCP servers are declared only in the Agent Plugins mcp.json", () => {
  for (const name of pluginNames) {
    const { mcpServers } = entryFor(name);
    const hasMcpConfig = existsSync(join(pluginsPath, name, "mcp.json"));

    // Claude Code also loads .mcp.json from a plugin, which Agent Plugins never reads.
    assert.equal(
      existsSync(join(pluginsPath, name, ".mcp.json")),
      false,
      `plugins/${name}/.mcp.json: move its servers into mcp.json`,
    );
    assert.equal(
      mcpServers,
      hasMcpConfig ? "./mcp.json" : undefined,
      hasMcpConfig
        ? `${name}: set "mcpServers": "./mcp.json" in its marketplace entry`
        : `${name}: declare MCP servers in plugins/${name}/mcp.json, not in the marketplace entry`,
    );
  }
});

test("each mcp.json matches the Agent Plugins schema and uses only portable stdio servers", async () => {
  for (const name of pluginNames) {
    const path = join(pluginsPath, name, "mcp.json");
    if (!existsSync(path)) continue;
    const config = await readJson(path);

    assert.ok(validateMcpConfig(config), `${path}: ${ajv.errorsText(validateMcpConfig.errors)}`);

    for (const [server, definition] of Object.entries(config.mcpServers)) {
      // The remote transport is streamable-http in Agent Plugins and http in Claude Code.
      assert.equal(definition.type, "stdio", `${path}: ${server} must use the stdio transport`);
      // The plugin root is ${PLUGIN_ROOT} in Agent Plugins and ${CLAUDE_PLUGIN_ROOT}
      // in Claude Code, so a server that names it cannot share one file.
      assert.doesNotMatch(
        JSON.stringify(definition),
        /\$\{(?:CLAUDE_)?PLUGIN_(?:ROOT|DATA)\}/,
        `${path}: ${server} names a plugin path variable, which differs between the two formats`,
      );
    }
  }
});
