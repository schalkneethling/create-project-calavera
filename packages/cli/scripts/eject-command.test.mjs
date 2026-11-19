// @ts-check
// Issue #678, layer 5 of the five-layer stack the owner approved on 2026-11-18: the `eject`
// command. Layers 1 to 4 plan and remove the footprint (ADR-0017, Decision 2); these tests cover
// what the command adds: the dry run, the interactive approval, `--yes`, `--json`, the
// `package.json` and workspace reports (Decisions 4 and 8), a second run, and the human output,
// which must pass the #918 rehearsal's listing check, as `clean`'s does (#331).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { listingViolations, namedItems } from "../../../scripts/rehearsal-checks.mjs";
import { footprintIn, scriptRunsCalavera } from "../src/eject.js";
import { ejectSummaryLines } from "../src/eject-summary.js";
import {
  agentBootstrap,
  devDependencyRemoveCommand,
  ejectProject,
  formatHelp,
  parseArgs,
} from "../src/index.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const cliPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));

/** @param {string} path */
const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** @param {string} path @param {string} text */
async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/**
 * Runs `callback` inside a new temporary project with a `package.json` of its own.
 *
 * @param {(root: string) => Promise<void>} callback
 * @param {object} [packageJSON]
 */
async function inProject(callback, packageJSON = {}) {
  await using holder = await mkdtempDisposable(join(tmpdir(), "calavera-eject-command-"));
  const root = await realpath(holder.path);
  const originalDirectory = process.cwd();
  process.chdir(root);
  try {
    await writeFile("package.json", `${JSON.stringify(packageJSON, null, 2)}\n`);
    await callback(root);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** A real `--init` with the Claude Code MCP registration, then a recipe. */
async function initProject() {
  await agentBootstrap({ mcpHarness: "claude-code", packageManager: "npm" });
  await writeFile("calavera.config.json", '{ "profile": "minimal" }\n');
}

/**
 * Runs `ejectProject` as an interactive run that approves, or declines, and returns the result
 * with the lines shown before the approval.
 *
 * @param {string[]} args The flags after `eject`.
 * @param {boolean} approve
 */
async function ejectInteractively(args, approve) {
  /** @type {string[]} */
  const shown = [];
  /** @type {string[]} */
  const asked = [];
  const result = await ejectProject(parseArgs(["eject", ...args]), {
    interactive: true,
    show: (lines) => shown.push(...lines.map(({ text }) => text)),
    confirm: async (message) => {
      asked.push(message);
      return approve;
    },
  });
  return { result, shown: shown.join("\n"), asked };
}

/** @param {string[]} [args] The flags after `eject`. */
const eject = (args = []) => ejectProject(parseArgs(["eject", ...args]), { interactive: false });

/** @param {import("../src/index.js").EjectResult} result */
const human = (result) =>
  ejectSummaryLines(result)
    .map(({ text }) => text)
    .join("\n");

/**
 * Runs the CLI without a terminal, as in CI or an agent's shell.
 *
 * @param {string} cwd
 * @param {string[]} args
 */
function runWithoutTerminal(cwd, args) {
  const result = spawnSync(process.execPath, [cliPath, ...args], {
    cwd,
    env: { ...process.env, NO_COLOR: "1" },
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 120_000,
  });
  assert.equal(result.signal, null, `eject timed out:\n${result.stdout}\n${result.stderr}`);
  return result;
}

/** The footprint paths Calavera's `--init` writes, and the recipe. */
const INIT_FOOTPRINT = [
  ".calavera",
  ".agents/skills/calavera",
  ".coderabbit.yaml",
  "AGENTS.md",
  "calavera.config.json",
];

test("eject is a command, listed in the help text", () => {
  assert.equal(parseArgs(["eject", "--dry-run"]).command, "eject");
  assert.equal(parseArgs(["eject", "--dry-run"]).dryRun, true);
  assert.match(formatHelp(), /^ {2}eject {2,}\S/m);
});

test("eject --dry-run lists every footprint item, marks what --yes leaves, and changes nothing", async () => {
  await inProject(async () => {
    await initProject();
    const before = await snapshotDirectory();
    const result = await eject(["--dry-run"]);
    assert.deepEqual(await snapshotDirectory(), before);
    assert.equal(result.status, "dry-run");
    const paths = result.items.map(({ path }) => path);
    for (const path of [
      ".calavera/state.json",
      ".agents/skills/calavera",
      ".coderabbit.yaml",
      "AGENTS.md",
      ".mcp.json",
      "calavera.config.json",
    ]) {
      assert.ok(paths.includes(path), `the dry run names ${path}: ${paths.join(", ")}`);
    }
    assert.ok(result.items.every(({ outcome }) => outcome === "planned"));
    const recipe = result.items.find(({ kind }) => kind === "recipe");
    assert.equal(recipe?.matchesRecords, false);

    const output = human(result);
    assert.match(output, /^Would remove:$/m);
    assert.match(output, /calavera\.config\.json \(edits cannot be detected; --yes leaves it\)/);
    assert.match(output, /\.calavera\/state\.json \(Calavera's own record\)/);
    assert.match(output, /AGENTS\.md \(unedited\)/);
    // An edit shows the exact text it removes and the text the file holds afterward.
    assert.match(output, /\.mcp\.json[^\n]*\n(?: {4}.*\n)* {4}Removes:/);
    assert.match(output, / {4}Afterward:/);
    // #331, #918: every item printed once, under a heading.
    assert.deepEqual(listingViolations(output, namedItems(result)), []);
  });
});

test("eject --dry-run refuses while an artifact transaction is pending, and changes nothing", async () => {
  await inProject(async (root) => {
    await initProject();
    const transactionRoot = join(root, ".calavera/.transactions/pending");
    await write(join(transactionRoot, "staged/SKILL.md"), "# New\n");
    await write(
      ".calavera/artifact-transaction.json",
      `${JSON.stringify({
        schemaVersion: 1,
        transactionRoot,
        operations: [
          {
            staged: join(transactionRoot, "staged"),
            target: join(root, ".agents/skills/new"),
            backup: join(transactionRoot, "backups/0"),
            hadTarget: false,
          },
        ],
      })}\n`,
    );
    const before = await snapshotDirectory();
    await assert.rejects(eject(["--dry-run"]), /pending artifact transaction/);
    assert.deepEqual(await snapshotDirectory(), before);

    // A real run recovers the transaction first, and then lists the footprint for approval.
    const { result } = await ejectInteractively([], false);
    assert.equal(result.status, "cancelled");
    assert.equal(await exists(".calavera/artifact-transaction.json"), false);
  });
});

test("an interactive run marks each item, shows notes and reports, and removes everything after approval", async () => {
  await inProject(async () => {
    await initProject();
    // An edited skill, a JSON harness file whose rewrite also changes its layout, and guidance the
    // person merged by hand, which eject keeps and reports.
    await writeFile(".agents/skills/calavera/SKILL.md", "# Edited\n");
    const mcp = JSON.parse(await readFile(".mcp.json", "utf8"));
    await writeFile(".mcp.json", `${JSON.stringify({ ...mcp, other: { a: 1 } })}\n`);
    await writeFile("AGENTS.calavera.md", `${await readFile("AGENTS.md", "utf8")}\nMy own line.\n`);

    const { result, shown, asked } = await ejectInteractively([], true);
    assert.equal(asked.length, 1);
    assert.match(shown, /\.agents\/skills\/calavera \(edited; --yes leaves it\)/);
    assert.match(shown, /calavera\.config\.json \(edits cannot be detected/);
    assert.match(shown, /AGENTS\.calavera\.md \(edited; --yes leaves it\)/);
    // Layer 3's note about the formatter changing the rest of the file.
    assert.match(shown, /layout/);
    assert.equal(result.status, "ejected");
    assert.ok(
      result.items.every(({ outcome }) => outcome === "removed"),
      JSON.stringify(result.items),
    );
    for (const path of [...INIT_FOOTPRINT, "AGENTS.calavera.md"]) {
      assert.equal(await exists(path), false, `${path} is gone`);
    }
    const kept = JSON.parse(await readFile(".mcp.json", "utf8"));
    assert.deepEqual(kept, { other: { a: 1 } });

    const output = human(result);
    assert.match(output, /^Removed:$/m);
    assert.deepEqual(listingViolations(output, namedItems(result)), []);
  });
});

test("an interactive run that keeps and reports guidance shows each report", async () => {
  await inProject(async () => {
    await writeFile("AGENTS.md", "# Mine\n");
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm", agentsMd: "append" });
    const text = await readFile("AGENTS.md", "utf8");
    await writeFile(
      "AGENTS.md",
      text.replace(
        "<!-- calavera-agent-bootstrap:end -->",
        "Edited.\n<!-- calavera-agent-bootstrap:end -->",
      ),
    );
    const { result, shown } = await ejectInteractively([], true);
    assert.equal(result.reported.length, 1);
    assert.match(shown, /^Left for you:$/m);
    assert.match(shown, /AGENTS\.md/);
    assert.ok((await readFile("AGENTS.md", "utf8")).includes("Edited."));
  });
});

test("declining the approval changes nothing", async () => {
  await inProject(async () => {
    await initProject();
    const before = await snapshotDirectory();
    const { result } = await ejectInteractively([], false);
    assert.equal(result.status, "cancelled");
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("--yes removes only items that match Calavera's records, lists what it left, and a second run says only approvals remain", async () => {
  await inProject(async () => {
    await initProject();
    const result = await eject(["--yes"]);
    assert.equal(result.status, "ejected");
    const left = result.items.filter(({ outcome }) => outcome === "left").map(({ path }) => path);
    assert.deepEqual(left, ["calavera.config.json"]);
    for (const path of [".calavera", ".agents/skills/calavera", ".coderabbit.yaml", "AGENTS.md"]) {
      assert.equal(await exists(path), false, `${path} is gone`);
    }
    assert.equal(await exists("calavera.config.json"), true);
    const output = human(result);
    assert.match(output, /^Left for an interactive approval:$/m);
    assert.deepEqual(listingViolations(output, namedItems(result)), []);

    const second = await eject(["--yes"]);
    assert.equal(second.status, "ejected");
    assert.deepEqual(
      second.items.map(({ outcome }) => outcome),
      ["left"],
    );
    assert.match(second.message, /only items that need your approval remain/i);
  });
});

test("a second run after an approved eject reports nothing to do", async () => {
  await inProject(async () => {
    await initProject();
    await ejectInteractively([], true);
    const before = await snapshotDirectory();
    const result = await eject(["--dry-run"]);
    assert.equal(result.status, "nothing-to-do");
    assert.deepEqual(result.items, []);
    const { result: interactive, asked } = await ejectInteractively([], true);
    assert.equal(interactive.status, "nothing-to-do");
    assert.deepEqual(asked, []);
    assert.deepEqual(await snapshotDirectory(), before);
    assert.match(human(result), /no Calavera footprint/i);
  });
});

test("without a terminal and without --yes, eject refuses, prints the list, and writes nothing", async () => {
  await inProject(async (root) => {
    await initProject();
    const before = await snapshotDirectory();
    const result = runWithoutTerminal(root, ["eject"]);
    assert.equal(result.status, 1, `${result.stdout}\n${result.stderr}`);
    const output = `${result.stdout}\n${result.stderr}`;
    assert.match(output, /cannot ask for confirmation because stdin is not a terminal/);
    assert.match(output, /--yes/);
    assert.match(output, /\.calavera\/state\.json/);
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("--json without --yes refuses with a structured result, and --json --yes ejects", async () => {
  await inProject(async (root) => {
    await initProject();
    const before = await snapshotDirectory();
    const refused = runWithoutTerminal(root, ["eject", "--json"]);
    assert.equal(refused.status, 1);
    const parsed = JSON.parse(refused.stdout);
    assert.equal(parsed.command, "eject");
    assert.equal(parsed.status, "refused");
    assert.ok(
      parsed.items.some(
        (/** @type {{ path: string }} */ { path }) => path === ".calavera/state.json",
      ),
    );
    assert.equal(parsed.items[0].seen, undefined, "the check values stay internal");
    assert.deepEqual(await snapshotDirectory(), before);

    const done = runWithoutTerminal(root, ["eject", "--json", "--yes"]);
    assert.equal(done.status, 0, done.stderr);
    const ejected = JSON.parse(done.stdout);
    assert.equal(ejected.status, "ejected");
    assert.equal(await exists(".calavera"), false);
  });
});

test("the human dry run through the CLI passes the rehearsal's listing check", async () => {
  await inProject(async (root) => {
    await initProject();
    const json = runWithoutTerminal(root, ["eject", "--dry-run", "--json"]);
    assert.equal(json.status, 0, json.stderr);
    const result = runWithoutTerminal(root, ["eject", "--dry-run"]);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(listingViolations(result.stdout, namedItems(JSON.parse(json.stdout))), []);
  });
});

test("package.json is reported, never written: scripts that run Calavera and the development dependency", async () => {
  const packageJSON = {
    packageManager: "pnpm@10.0.0",
    scripts: {
      calavera: "create-project-calavera apply",
      mcp: "pnpm dlx --package create-project-calavera@6.2.1 create-project-calavera-mcp",
      build: "vite build",
    },
    devDependencies: { "create-project-calavera": "^6.2.1" },
  };
  await inProject(async () => {
    await initProject();
    const manifest = await readFile("package.json", "utf8");
    const result = await eject(["--yes"]);
    assert.equal(await readFile("package.json", "utf8"), manifest);
    assert.deepEqual(result.packageJson.scripts, [
      { name: "calavera", value: "create-project-calavera apply" },
      {
        name: "mcp",
        value: "pnpm dlx --package create-project-calavera@6.2.1 create-project-calavera-mcp",
      },
    ]);
    assert.deepEqual(result.packageJson.devDependency, {
      name: "create-project-calavera",
      removeCommand: "pnpm remove create-project-calavera",
    });
    const output = human(result);
    assert.match(output, /^Left in package\.json:$/m);
    assert.match(output, /^ +pnpm remove create-project-calavera$/m);
    assert.match(output, /"create-project-calavera apply"/);
  }, packageJSON);
});

test("a project without a Calavera dependency or script gets no package.json report", async () => {
  await inProject(async () => {
    await initProject();
    const result = await eject(["--dry-run"]);
    assert.deepEqual(result.packageJson, { scripts: [] });
    assert.doesNotMatch(human(result), /package\.json/);
  });
});

test("scriptRunsCalavera finds both bins, directly or through a package runner, and nothing else", () => {
  for (const value of [
    "create-project-calavera apply",
    "npx create-project-calavera@6.2.1 doctor",
    "npx --package create-project-calavera@6.2.1 create-project-calavera-mcp",
    "pnpm dlx create-project-calavera --init",
    "npm create project-calavera -- --init",
    "npm init project-calavera",
    "yarn create project-calavera apply",
    "bunx create-project-calavera clean",
    "vp check && create-project-calavera doctor",
    "./node_modules/.bin/create-project-calavera doctor",
  ]) {
    assert.equal(scriptRunsCalavera(value), true, value);
  }
  for (const value of [
    "vp check",
    "knip",
    "echo project-calavera",
    "npx @someone/create-project-calavera",
    "create-project-calavera-extra run",
    "node scripts/create-project-calavera.mjs.bak",
  ]) {
    assert.equal(scriptRunsCalavera(value), false, value);
  }
});

test("devDependencyRemoveCommand gives each package manager's remove command, and vp remove under Vite+", () => {
  /** @type {import("../src/vite-plus-detection.js").VitePlusDetection} */
  const notManaged = { status: "unmanaged", corroborating: [] };
  /** @type {import("../src/vite-plus-detection.js").VitePlusDetection} */
  const managed = {
    status: "managed",
    signal: "vite-plus-dependency",
    manifestPath: "package.json",
    corroborating: [],
  };
  const name = ["create-project-calavera"];
  assert.deepEqual(devDependencyRemoveCommand("npm", notManaged, name), [
    "npm",
    ["uninstall", ...name],
  ]);
  assert.deepEqual(devDependencyRemoveCommand("pnpm", notManaged, name), [
    "pnpm",
    ["remove", ...name],
  ]);
  assert.deepEqual(devDependencyRemoveCommand("yarn", notManaged, name), [
    "yarn",
    ["remove", ...name],
  ]);
  assert.deepEqual(devDependencyRemoveCommand("bun", notManaged, name), [
    "bun",
    ["remove", ...name],
  ]);
  for (const packageManager of /** @type {const} */ (["npm", "pnpm", "yarn", "bun"])) {
    assert.deepEqual(devDependencyRemoveCommand(packageManager, managed, name), [
      "vp",
      ["remove", ...name],
    ]);
  }
});

test("run in a workspace package, eject removes only its own footprint and names the root's", async () => {
  await inProject(async (root) => {
    await mkdir(".git");
    await initProject();
    await mkdir("packages/app", { recursive: true });
    await writeFile("packages/app/package.json", '{ "name": "app" }\n');
    process.chdir("packages/app");
    await write(".calavera/state.json", '{ "aiArtifacts": [] }\n');
    const result = await eject(["--yes"]);
    assert.equal(await exists(".calavera"), false);
    assert.equal(await exists(join(root, ".calavera/state.json")), true);
    assert.deepEqual(
      result.elsewhere.map(({ directory }) => directory),
      ["../.."],
    );
    assert.ok(result.elsewhere[0]?.paths.includes(".calavera/state.json"));
    const output = human(result);
    assert.match(output, /^Elsewhere in the workspace:$/m);
    assert.match(output, /\.\.\/\.\.\/\.calavera\/state\.json/);
  });
});

test("run at a workspace root, eject names a footprint in a workspace package", async () => {
  await inProject(
    async () => {
      await initProject();
      await write("packages/app/package.json", '{ "name": "app" }\n');
      await write("packages/app/calavera.config.json", "{}\n");
      await write("packages/lib/package.json", '{ "name": "lib" }\n');
      const result = await eject(["--dry-run"]);
      assert.deepEqual(result.elsewhere, [
        { directory: "packages/app", paths: ["calavera.config.json"] },
      ]);
    },
    { workspaces: ["packages/*"] },
  );
});

test("footprintIn names every kind of footprint item in another directory", async () => {
  await inProject(async (root) => {
    await initProject();
    await write(
      ".gitignore",
      "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n",
    );
    await write("AGENTS.calavera.md", "<!-- calavera-agent-bootstrap -->\n");
    await write(".agents/calavera/mcp.md", "notes\n");
    await write(
      ".codex/config.toml",
      '[mcp_servers.calavera]\ncommand = "npx"\nargs = ["create-project-calavera-mcp"]\n',
    );
    const found = await footprintIn(root);
    for (const path of [
      ".calavera/state.json",
      ".agents/skills/calavera",
      ".coderabbit.yaml",
      "AGENTS.md",
      "AGENTS.calavera.md",
      ".agents/calavera/mcp.md",
      ".mcp.json",
      ".codex/config.toml",
      ".gitignore",
      "calavera.config.json",
    ]) {
      assert.ok(found.includes(path), `${path} in ${found.join(", ")}`);
    }
    await using empty = await mkdtempDisposable(join(tmpdir(), "calavera-eject-empty-"));
    await write(join(empty.path, "AGENTS.md"), "# Not Calavera\n");
    await write(join(empty.path, ".mcp.json"), '{ "mcpServers": {} }\n');
    assert.deepEqual(await footprintIn(empty.path), []);
  });
});

test("a removal that fails is reported with its cause and remedy, and the rest still go", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores folder permissions");
    return;
  }
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    assert.equal(await exists(".agents/calavera/mcp.md"), true);
    await chmod(".agents/calavera", 0o555);
    try {
      const result = await eject(["--yes"]);
      assert.equal(result.status, "failed");
      const failed = result.items.filter(({ outcome }) => outcome === "failed");
      assert.deepEqual(
        failed.map(({ path }) => path),
        [".agents/calavera/mcp.md"],
      );
      assert.match(failed[0]?.error ?? "", /EACCES|EPERM/);
      assert.equal(await exists("AGENTS.md"), false, "the other items were removed");
      const output = human(result);
      assert.match(output, /^Removed:$/m);
      assert.match(output, /^Failed:$/m);
      assert.match(output, /Fix the cause, then run eject again/);
    } finally {
      await chmod(".agents/calavera", 0o755);
    }
  });
});

/** @type {import("../src/index.js").EjectResultItem} */
const STATE_ITEM = {
  kind: "state",
  path: ".calavera/state.json",
  action: "delete",
  edits: "not-checked",
  matchesRecords: true,
  outcome: "planned",
};

test("the summary prints each group, label, and detail exactly", () => {
  /** @type {import("../src/index.js").EjectResult} */
  const result = {
    command: "eject",
    dryRun: true,
    status: "dry-run",
    message: "Headline.",
    items: [
      STATE_ITEM,
      { ...STATE_ITEM, kind: "lock", path: ".calavera/artifacts.lock.json" },
      { ...STATE_ITEM, kind: "cache", path: ".calavera/cache" },
      {
        kind: "mcp-entry",
        path: ".mcp.json",
        action: "edit",
        edits: "unedited",
        matchesRecords: false,
        note: "The formatter also changes the layout of .mcp.json.",
        removedLines: ['"calavera": {}'],
        contents: "{\n}\n",
        outcome: "planned",
      },
      {
        kind: "recipe",
        path: "calavera.config.json",
        action: "delete",
        edits: "cannot-detect",
        matchesRecords: false,
        reason: "The recipe at calavera.config.json; edits cannot be detected.",
        outcome: "removed",
      },
      {
        kind: "guidance-file",
        path: "AGENTS.md",
        action: "delete",
        edits: "edited",
        matchesRecords: false,
        contents: "no final line break",
        outcome: "left",
      },
      { ...STATE_ITEM, path: ".calavera/x", outcome: "failed", error: "EACCES on .calavera/x" },
      { ...STATE_ITEM, path: ".calavera/y", outcome: "skipped", error: "Kept for .calavera/x." },
    ],
    reported: [
      { path: "AGENTS.calavera.md", reason: "First reason about AGENTS.calavera.md." },
      { path: "AGENTS.calavera.md", reason: "Second reason." },
    ],
    kept: [".calavera/notes.txt"],
    packageJson: {
      scripts: [{ name: "go", value: "create-project-calavera apply" }],
      devDependency: { name: "create-project-calavera", removeCommand: "npm uninstall x" },
    },
    elsewhere: [{ directory: "../..", paths: ["AGENTS.md", ".calavera/state.json"] }],
  };
  assert.deepEqual(human(result).split("\n"), [
    "Headline.",
    "",
    "Would remove:",
    "  .calavera/state.json (Calavera's own record)",
    "  .calavera/artifacts.lock.json (Calavera's own record)",
    "  .calavera/cache (Calavera's own files)",
    "  .mcp.json (unedited; --yes leaves it)",
    "    eject removes only Calavera's text from this file and keeps the file.",
    "    The formatter also changes the layout of this item.",
    "    Removes:",
    '      "\\"calavera\\": {}"',
    "    Afterward:",
    '      "{"',
    '      "}"',
    "",
    "Removed:",
    "  calavera.config.json (edits cannot be detected)",
    "    The recipe at this item; edits cannot be detected.",
    "",
    "Left for an interactive approval:",
    "  AGENTS.md (edited)",
    "    Afterward:",
    '      "no final line break"',
    "",
    "Failed:",
    "  .calavera/x: EACCES on this item",
    "    Fix the cause, then run eject again.",
    "",
    "Skipped:",
    "  .calavera/y: Kept for .calavera/x.",
    "",
    "Kept:",
    "  .calavera/notes.txt: eject does not name it, so it keeps it and the folder that holds it.",
    "",
    "Left for you:",
    "  AGENTS.calavera.md",
    "    First reason about this item.",
    "    Second reason.",
    "",
    "Left in package.json:",
    '  The script "go" runs Calavera: "create-project-calavera apply". It stops working once Calavera is gone, so change or remove it yourself.',
    "  The development dependency create-project-calavera stays. To remove it, run:",
    "    npm uninstall x",
    "",
    "Elsewhere in the workspace:",
    "  ../.. also holds Calavera's footprint: ../../AGENTS.md, ../../.calavera/state.json. Run eject there too if you want Calavera gone from it.",
  ]);
});

test("the headline counts what a run removes and what --yes leaves", async () => {
  await inProject(async () => {
    await initProject();
    const dryRun = await eject(["--dry-run"]);
    const count = dryRun.items.length;
    assert.equal(
      dryRun.message,
      `Dry run complete. Nothing was changed. eject would remove ${count} items; --yes would leave 1 item for an interactive approval.`,
    );
    const { asked, result: cancelled } = await ejectInteractively([], false);
    assert.deepEqual(asked, [
      `Remove the ${count} items listed above, including any marked edited?`,
    ]);
    assert.equal(cancelled.message, "eject cancelled. Nothing was changed.");

    // An edited skill is left for an approval, and the state is kept because it records the skill.
    // The dry run says so before --yes runs (Decision 5).
    await writeFile(".agents/skills/calavera/SKILL.md", "# Edited\n");
    const edited = await eject(["--dry-run"]);
    assert.equal(
      edited.message,
      `Dry run complete. Nothing was changed. eject would remove ${count} items; --yes would leave 2 items for an interactive approval, and would keep 1 record that an item it leaves needs.`,
    );
    assert.match(
      human(edited),
      /^ {2}\.calavera\/state\.json \(Calavera's own record; --yes keeps it while an item it leaves needs it\)$/m,
    );
    const yes = await eject(["--yes"]);
    assert.equal(
      yes.message,
      `Removed ${count - 3} items; --yes left 2 items for an interactive approval, and kept 1 record that an item it leaves needs. Run eject in a terminal to review and approve what is left.`,
    );
    const state = yes.items.find(({ kind }) => kind === "state");
    assert.equal(state?.outcome, "left");
    assert.equal(state?.keptRecord, true);
    for (const item of yes.items) assert.equal("error" in item, false);
  });
});

test("a dry run with nothing --yes would leave says only what it would remove", async () => {
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    const result = await eject(["--dry-run"]);
    assert.equal(
      result.message,
      `Dry run complete. Nothing was changed. eject would remove ${result.items.length} items.`,
    );
    const yes = await eject(["--yes"]);
    assert.equal(yes.message, `Removed ${yes.items.length} items.`);
  });
});

test("one item left by --yes is worded in the singular", async () => {
  await inProject(async () => {
    await initProject();
    const result = await eject(["--yes"]);
    assert.match(
      result.message,
      /; --yes left 1 item for an interactive approval\. Run eject in a terminal to review and approve what is left\.$/,
    );
  });
});

test("a refused run names each reason it cannot ask, and a pending transaction in its result", async () => {
  await inProject(async (root) => {
    await initProject();
    const refused = await ejectProject(parseArgs(["eject", "--json"]), { interactive: false });
    assert.equal(refused.status, "refused");
    const reasons = process.stdin.isTTY
      ? "--json is set"
      : "--json is set and stdin is not a terminal";
    assert.equal(
      refused.message,
      `eject cannot ask for confirmation because ${reasons}, so it changed nothing. Run eject in a terminal to review and approve the list, or pass --yes to remove only the items that match Calavera's records exactly.`,
    );

    await write(
      ".calavera/artifact-transaction.json",
      `${JSON.stringify({ schemaVersion: 1, transactionRoot: join(root, ".calavera/.transactions/t"), operations: [] })}\n`,
    );
    const before = await snapshotDirectory();
    const pending = await ejectProject(parseArgs(["eject", "--json"]), { interactive: false });
    assert.equal(pending.status, "refused");
    assert.deepEqual(pending.items, []);
    assert.equal(
      pending.message,
      `${refused.message} .calavera/artifact-transaction.json also records a pending artifact transaction, which eject recovers before it lists anything; a run in a terminal or with --yes recovers it first.`,
    );
    assert.deepEqual(await snapshotDirectory(), before);
  });
});

test("an interactive run without its own printer prints the list through the logger", async (t) => {
  await inProject(async () => {
    await initProject();
    const printed = t.mock.method(console, "info", () => {});
    const result = await ejectProject(parseArgs(["eject"]), {
      interactive: true,
      confirm: async () => false,
    });
    assert.equal(result.status, "cancelled");
    const text = printed.mock.calls.map(({ arguments: [line] }) => String(line)).join("\n");
    assert.match(text, /^Would remove:$/m);
  });
});

test("a failed removal skips the items that depend on it and counts both", async (t) => {
  if (process.getuid?.() === 0) {
    t.skip("root ignores folder permissions");
    return;
  }
  await inProject(async () => {
    await initProject();
    await write(".calavera/cache/entry", "x\n");
    await write(
      ".gitignore",
      "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n",
    );
    await chmod(".calavera", 0o555);
    try {
      const { result } = await ejectInteractively([], true);
      const outcomes = Object.fromEntries(result.items.map(({ kind, outcome }) => [kind, outcome]));
      assert.equal(outcomes.cache, "failed");
      assert.equal(outcomes["artifact-cache-block"], "skipped");
      assert.equal(outcomes.state, "skipped");
      const removed = result.items.filter(({ outcome }) => outcome === "removed").length;
      assert.equal(result.status, "failed");
      assert.equal(
        result.message,
        `Removed ${removed} items. 3 items could not be removed; each one says why below. Fix the cause, then run eject again.`,
      );
    } finally {
      await chmod(".calavera", 0o755);
    }
  });
});

test("workspace patterns follow the package managers: pnpm, exclusions, and path prefixes", async () => {
  await inProject(async () => {
    await write("pnpm-workspace.yaml", 'packages:\n  - "./packages/*/"\n  - "!packages/lib"\n');
    for (const name of ["b", "a", "lib"]) {
      await write(`packages/${name}/package.json`, `{ "name": "${name}" }\n`);
      await write(`packages/${name}/calavera.config.json`, "{}\n");
    }
    await writeFile("calavera.config.json", "{}\n");
    const result = await eject(["--dry-run"]);
    assert.deepEqual(
      result.elsewhere.map(({ directory }) => directory),
      ["packages/a", "packages/b"],
    );
  });
});

test("at the repository root itself, eject names no other location", async () => {
  await inProject(async () => {
    await mkdir(".git");
    await initProject();
    const result = await eject(["--dry-run"]);
    assert.deepEqual(result.elsewhere, []);
  });
});

test("a script value that is not a string is not reported", async () => {
  await inProject(
    async () => {
      await initProject();
      const result = await eject(["--dry-run"]);
      assert.deepEqual(result.packageJson, { scripts: [] });
    },
    { scripts: { odd: ["create-project-calavera"] } },
  );
});

test("scriptRunsCalavera allows any spacing after create or init, and no file extension", () => {
  assert.equal(scriptRunsCalavera("npm create  project-calavera"), true);
  assert.equal(scriptRunsCalavera("npm init project-calavera.mjs"), false);
});

test("footprintIn needs the cache block's marker, and reads a first line with a Windows line ending", async () => {
  await using directory = await mkdtempDisposable(join(tmpdir(), "calavera-eject-footprint-"));
  await write(join(directory.path, ".gitignore"), "node_modules\n");
  assert.deepEqual(await footprintIn(directory.path), []);
  const created = await readFile(
    new URL("../fixtures/coderabbit/created-2.5.0.yaml", import.meta.url),
    "utf8",
  );
  await write(join(directory.path, ".coderabbit.yaml"), created.replaceAll("\n", "\r\n"));
  assert.deepEqual(await footprintIn(directory.path), [".coderabbit.yaml"]);
});

test("a project that names no package manager gets npm's remove command", async () => {
  await inProject(
    async () => {
      await initProject();
      const result = await eject(["--dry-run"]);
      assert.equal(
        result.packageJson.devDependency?.removeCommand,
        "npm uninstall create-project-calavera",
      );
    },
    { devDependencies: { "create-project-calavera": "^6.2.1" } },
  );
});

test("a declined run says that it recovered a pending transaction", async () => {
  await inProject(async (root) => {
    await initProject();
    await write(
      ".calavera/artifact-transaction.json",
      `${JSON.stringify({ schemaVersion: 1, transactionRoot: join(root, ".calavera/.transactions/t"), operations: [] })}\n`,
    );
    const { result } = await ejectInteractively([], false);
    assert.equal(
      result.message,
      "eject cancelled. It recovered the pending artifact transaction first, as every artifacts command does, and changed nothing else.",
    );
  });
});

test("a workspace that lists its own root among its packages names no other location", async () => {
  await inProject(async () => {
    await initProject();
    await write("pnpm-workspace.yaml", 'packages:\n  - "."\n  - "packages/*"\n');
    await write("packages/app/package.json", '{ "name": "app" }\n');
    const result = await eject(["--dry-run"]);
    assert.deepEqual(result.elsewhere, []);
    assert.deepEqual(listingViolations(human(result), namedItems(result)), []);
  });
});

test("a package.json that cannot be read stops nothing and says why it is not reported", async () => {
  /** @type {[string, RegExp][]} */
  const cases = [
    ["{bad", /^package\.json could not be read \(/],
    ["null", /^package\.json does not hold a JSON object,/],
  ];
  for (const [text, problem] of cases) {
    await inProject(async () => {
      await initProject();
      await writeFile("package.json", text);
      const result = await eject(["--yes"]);
      assert.equal(result.status, "ejected");
      assert.match(result.packageJson.problem ?? "", problem);
      assert.match(human(result), /eject never changes package\.json/);
      assert.equal(await readFile("package.json", "utf8"), text);
    });
  }
});

test("--help says what --yes means for eject", () => {
  assert.match(
    formatHelp(),
    /--yes {16}Use defaults and skip prompts; with eject, remove only the\n {23}items that match Calavera's records exactly/,
  );
});

test("scriptRunsCalavera does not count a folder of that name in a path", () => {
  assert.equal(scriptRunsCalavera("node ./create-project-calavera/build.js"), false);
  assert.equal(scriptRunsCalavera("git clone x/create-project-calavera"), true);
});

test("after an approved run, the summary lists each removed item without its text", async () => {
  await inProject(async () => {
    await initProject();
    const { result } = await ejectInteractively([], true);
    const output = human(result);
    assert.match(output, /^ {2}\.mcp\.json \(unedited\)$/m);
    assert.doesNotMatch(output, /Removes:|Afterward:/);
  });
});

test("after --init and apply, an approved eject leaves no footprint and changes nothing else", async () => {
  await inProject(
    async (root) => {
      for (const args of [
        ["--init", "--yes", "--mcp-harness", "claude-code"],
        ["init", "--yes"],
        ["apply", "--yes", "--no-install"],
      ]) {
        const run = runWithoutTerminal(root, args);
        assert.equal(run.status, 0, `${args.join(" ")}:\n${run.stdout}\n${run.stderr}`);
      }
      const scripts = JSON.parse(await readFile("package.json", "utf8")).scripts;
      assert.ok(Object.keys(scripts).length > 0, "apply generated scripts");
      // Every file outside the footprint, managed files and package.json included, which the
      // generated scripts and vp check read.
      const footprint =
        /^\.\/(?:\.calavera|\.agents\/skills\/calavera|AGENTS\.md|\.coderabbit\.yaml|calavera\.config\.json|\.mcp\.json)/;
      const outside = async () =>
        Object.fromEntries(
          Object.entries(await snapshotDirectory(".")).filter(
            ([path]) => !footprint.test(`./${path}`),
          ),
        );
      const before = await outside();
      assert.ok(Object.keys(before).includes(".editorconfig"));

      const { result } = await ejectInteractively([], true);
      assert.equal(result.status, "ejected");
      assert.deepEqual(await outside(), before);
      for (const path of INIT_FOOTPRINT) assert.equal(await exists(path), false, `${path} is gone`);
      assert.deepEqual(JSON.parse(await readFile(".mcp.json", "utf8")), {});
      assert.equal((await eject(["--dry-run"])).status, "nothing-to-do");
    },
    { name: "plain", packageManager: "npm@11.0.0" },
  );
});
