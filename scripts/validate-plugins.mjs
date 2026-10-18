// Issue #704: runs `claude plugin validate --strict` on the marketplace and on
// each plugin in plugins/, so Claude Code reports problems that the layout tests
// in plugin-marketplace.test.mjs do not cover.
//
// Usage: node scripts/validate-plugins.mjs <Claude Code command...>
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// execa runs the npx .cmd shim on Windows, as the CLI does for its commands.
import { execa } from "execa";

const root = fileURLToPath(new URL("..", import.meta.url));
const [command, ...commandArgs] = process.argv.slice(2);

if (!command) {
  throw new Error(
    "Pass the Claude Code command, such as: npx --yes @anthropic-ai/claude-code@2.1.301",
  );
}

const plugins = (await readdir(join(root, "plugins"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(root, "plugins", entry.name))
  .sort();

for (const target of [root, ...plugins]) {
  try {
    await execa(command, [...commandArgs, "plugin", "validate", "--strict", target], {
      stdio: "inherit",
    });
  } catch (error) {
    throw new Error(`claude plugin validate --strict failed for ${target}.`, { cause: error });
  }
}
