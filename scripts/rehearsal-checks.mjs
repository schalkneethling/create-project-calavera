// The checks of the cli-experience exit rehearsal (#918). Section 0 of
// docs/cross-repo/sequencing-map.md is the source of truth: each numbered item of its exit
// condition becomes one or more named checks here, each with the issues that deliver it. When
// Section 0 changes, change this list with it.
//
// Where an output format is not settled yet (the grouped headings from #601 and #617, the version
// notice from #675), a check asserts the property Section 0 states, not a guessed snapshot.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, lstat, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";

import semver from "semver";

import { snapshotDirectory } from "../packages/cli/scripts/project-snapshot.mjs";
import { CheckFailure, describeExit, tail } from "./rehearsal-failure.mjs";

/**
 * @typedef {import("./rehearsal-failure.mjs").CommandResult} CommandResult
 * @typedef {{
 *   mode: "pinned" | "latest",
 *   dirs: ReturnType<typeof import("./rehearse-cli-experience.mjs").runDirectories>,
 *   env: NodeJS.ProcessEnv,
 *   registry: { url: string, requests: string[] },
 *   calavera: { version: string, bin: string, mcpBin: string, packageDirectory: string },
 *   repositoryRoot: string,
 *   run: (command: string, args: string[], options?: { cwd?: string, env?: NodeJS.ProcessEnv, timeout?: number }) => Promise<CommandResult>,
 *   runOrThrow: (command: string, args: string[], options?: { cwd?: string }) => Promise<CommandResult>,
 *   freshEnvironment: (name: string) => Promise<NodeJS.ProcessEnv>,
 *   versions: Record<string, string>,
 *   recordEnvironment: (env: NodeJS.ProcessEnv, command: string) => void,
 *   vitePlusVersion: string,
 *   startRegistry: (options: { vitePlusVersion?: string, advertisedLatest?: { name: string, version: string } }) => Promise<{ url: string }>,
 *   shared?: Map<string, Promise<unknown>>,
 * }} RehearsalContext
 */

/**
 * What `vp create` is asked to scaffold in every check: a library with a Git repository, so Vite+
 * also sets up its pre-commit hook (the default without prompts), and no questions.
 */
const SCAFFOLD_ARGS = ["vite:library", "--git", "--no-interactive", "--directory", "app"];

/** @param {CommandResult} result */
function assertExitZero(result) {
  if (result.exitCode !== 0) {
    throw new CheckFailure({
      expected: "exit code 0",
      actual: `${describeExit(result)}\n${tail(result.output)}`,
      command: result.display,
    });
  }
}

/**
 * Runs `create` once per run and shares its result, or its failure, with every check that needs it.
 *
 * @template T
 * @param {RehearsalContext} context
 * @param {string} key
 * @param {() => Promise<T>} create
 * @returns {Promise<T>}
 */
function shared(context, key, create) {
  context.shared ??= new Map();
  if (!context.shared.has(key)) context.shared.set(key, create());
  return /** @type {Promise<T>} */ (context.shared.get(key));
}

/**
 * Calls one MCP tool on the packed `create-project-calavera-mcp`, speaking JSON-RPC over stdio.
 *
 * @param {RehearsalContext} context
 * @param {string} cwd
 * @param {string} name
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<Record<string, any>>}
 */
export function callPackedMcpTool(context, cwd, name, args = {}) {
  const command = `(cd ${cwd} && ${context.calavera.mcpBin}) <<< tools/call ${name}`;
  context.recordEnvironment(context.env, command);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(context.calavera.mcpBin, [], {
      cwd,
      env: context.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    let stderr = "";
    let settled = false;
    // Every way the exchange can end goes through here, so a server that crashes, closes its
    // input, or writes something other than JSON is a failed check, never an uncaught exception.
    /** @param {string} expected @param {string} actual */
    const fail = (expected, actual) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill("SIGKILL");
      reject(new CheckFailure({ expected, actual, command }));
    };
    const timer = setTimeout(
      () => fail(`${name} to answer within 60 seconds`, `no answer\n${tail(stderr)}`),
      60_000,
    );
    /** @param {Record<string, unknown>} message */
    const send = (message) =>
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.stdin.on("error", (error) => fail("the MCP server to read its input", error.message));
    child.on("error", (error) => fail("the MCP server to start", error.message));
    child.on("exit", (code, signal) =>
      fail(
        `the MCP server to answer ${name}`,
        `it exited with ${code === null ? `signal ${signal}` : `code ${code}`} first\n${tail(stderr)}`,
      ),
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newline;
      while (!settled && (newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          fail("only JSON-RPC messages on the MCP server's stdout", line.slice(0, 500));
          return;
        }
        if (message.id === 1) {
          send({ method: "notifications/initialized" });
          send({ id: 2, method: "tools/call", params: { name, arguments: args } });
        } else if (message.id === 2) {
          if (message.error || message.result?.isError) {
            fail(`${name} to succeed`, JSON.stringify(message.error ?? message.result.content));
            return;
          }
          const result = message.result;
          let payload;
          try {
            payload = result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
          } catch {
            fail(`${name} to return JSON`, String(result.content?.[0]?.text).slice(0, 500));
            return;
          }
          settled = true;
          clearTimeout(timer);
          child.kill();
          resolvePromise(payload);
        }
      }
    });
    send({
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "calavera-rehearsal", version: "1.0.0" },
      },
    });
  });
}

/**
 * Asserts that `inspect_project`, from the packed MCP server, reports `directory` as managed.
 *
 * @param {RehearsalContext} context
 * @param {string} directory
 */
async function assertManaged(context, directory) {
  const inspection = await callPackedMcpTool(context, directory, "inspect_project");
  const status = inspection.vitePlus?.status;
  if (status !== "managed") {
    throw new CheckFailure({
      expected: `inspect_project in ${directory} to report vitePlus.status "managed"`,
      actual: `vitePlus.status is ${JSON.stringify(status)}; findings: ${JSON.stringify(inspection.findings ?? [])}`,
      command: `(cd ${directory} && ${context.calavera.mcpBin}) <<< tools/call inspect_project`,
    });
  }
}

/**
 * Why a Plug'n'Play read found no version, by the exit code the read script ends with. From a
 * failed read, the report takes only the exit code and these fixed texts, never the child's
 * output, because that output can quote the files it read, such as a line of a manifest that is
 * not valid JSON. The codes start at 64, above the exit codes Node.js reserves for itself.
 */
const PNP_READ_FAILURES = {
  64: "it installed no vite-plus that Yarn's runtime resolves",
  65: "it installed a vite-plus/package.json that cannot be read",
  66: "it installed a vite-plus/package.json that is not valid JSON",
  67: "it installed a vite-plus/package.json that names no version",
};

/**
 * Prints the version of the `vite-plus` package the project folder given as the first argument
 * depends on, or exits with a code from `PNP_READ_FAILURES`. The fixed text it writes to stderr
 * is for a person who runs the script by hand; the rehearsal reads only the exit code. Yarn's `pnpapi` resolves the manifest from that folder without depending on the current
 * folder, and Yarn's runtime lets `fs` read inside the zip archive it points to.
 */
const PNP_VITE_PLUS_VERSION = `const { readFileSync } = require("node:fs");
const failures = ${JSON.stringify(PNP_READ_FAILURES)};
const fail = (code) => {
  process.stderr.write(failures[code] + "\\n");
  process.exit(code);
};
let file;
try {
  file = require("pnpapi").resolveToUnqualified("vite-plus/package.json", process.argv[1]);
} catch {
  fail(64);
}
let text;
try {
  text = readFileSync(file, "utf8");
} catch {
  fail(65);
}
let version;
try {
  version = JSON.parse(text).version;
} catch {
  fail(66);
}
if (typeof version !== "string" || version === "") fail(67);
process.stdout.write(version);`;

/**
 * The version of `vite-plus` installed in `project`, or why none could be read. A Yarn project
 * that uses Plug'n'Play has no node_modules folder: its packages stay in zip archives that only
 * Yarn's runtime, `.pnp.cjs`, resolves, so a Node.js child loads that runtime to read the version.
 * Vite+ 1.6.0 writes `nodeLinker: node-modules` for a Yarn project it creates, but a `.yarnrc.yml`
 * that already exists wins, and Yarn removes `.pnp.cjs` when it installs into node_modules, so
 * `.pnp.cjs` decides which layout the project uses.
 *
 * @param {RehearsalContext} context
 * @param {string} project
 */
async function installedVitePlus(context, project) {
  const pnp = join(project, ".pnp.cjs");
  if (existsSync(pnp)) {
    const result = await context.run(
      "node",
      // Yarn's runtime maps only real paths to the project, so a folder reached through a symbolic
      // link, as the macOS temporary folder is, would resolve nothing. A trailing slash makes the
      // folder itself the issuer, not a file named like it.
      ["--require", pnp, "--eval", PNP_VITE_PLUS_VERSION, "--", `${await realpath(project)}/`],
    );
    // A preload or runtime that prints to stdout would otherwise reach the report, so only a clean
    // version is taken from the child; anything else gets a fixed reason without its output.
    if (result.exitCode === 0 && semver.valid(result.stdout)) return { version: result.stdout };
    if (result.exitCode === 0) {
      return {
        problem: `the Plug'n'Play read printed something other than a version, and its output is left out because it can quote the files it read (${pnp} reading vite-plus/package.json)`,
      };
    }
    // A short label instead of the command, which would print the whole script.
    const label = `${pnp} reading vite-plus/package.json`;
    const reason =
      PNP_READ_FAILURES[/** @type {keyof typeof PNP_READ_FAILURES} */ (result.exitCode)] ??
      "the Plug'n'Play read ended without a version, and its output is left out because it can quote the files it read";
    return { problem: `${reason} (${label}: ${describeExit(result)})` };
  }
  const manifest = join(project, "node_modules", "vite-plus", "package.json");
  if (!existsSync(manifest)) {
    return {
      problem:
        "it installed nothing: there is no node_modules/vite-plus/package.json and no .pnp.cjs",
    };
  }
  let version;
  try {
    version = JSON.parse(await readFile(manifest, "utf8")).version;
  } catch {
    // The parser's message can quote the file, so only the file is named.
    return { problem: "it installed a node_modules/vite-plus/package.json that is not valid JSON" };
  }
  if (typeof version !== "string" || version === "") {
    return { problem: "it installed a node_modules/vite-plus/package.json that names no version" };
  }
  return { version };
}

/**
 * Throws when `project` does not have the run's Vite+ installed. A package manager that holds back
 * releases younger than its minimum release age, as pnpm and Yarn 4 do, can install an older Vite+
 * than the run asked for, and every later check would then test that release instead.
 *
 * @param {RehearsalContext} context
 * @param {string} project
 * @param {string} subject what installed Vite+, as the failure names it
 * @param {string} command
 * @param {string} [versionLabel] the row of the versions table that records what was installed
 */
async function assertVitePlusVersion(context, project, subject, command, versionLabel) {
  const installed = await installedVitePlus(context, project);
  if (versionLabel) context.versions[versionLabel] = installed.version ?? "not installed";
  if (installed.version === context.vitePlusVersion) return;
  throw new CheckFailure({
    expected: `${subject} to install Vite+ ${context.vitePlusVersion}`,
    actual: installed.problem ?? `it installed ${installed.version}`,
    command,
  });
}

/**
 * The launchers of Section 0 item 1, each with the runner it implies for `vp create` (#909: the
 * runner follows the launcher). The runner is read from the "Command:" line --new prints.
 */
const launchers = [
  {
    id: "new-npm",
    label: "npm create",
    issues: ["#909"],
    command: "npm",
    args: (/** @type {string[]} */ calavera) => ["create", "project-calavera", "--", ...calavera],
    runner: /^npm /,
    runnerLabel: "npm",
  },
  {
    id: "new-pnpm",
    label: "pnpm create",
    issues: ["#909", "#740"],
    command: "pnpm",
    args: (/** @type {string[]} */ calavera) => ["create", "project-calavera", ...calavera],
    runner: /^pnpm /,
    runnerLabel: "pnpm",
  },
  {
    id: "new-yarn",
    label: "yarn dlx (Yarn 2 or later)",
    issues: ["#909", "#740"],
    command: "yarn",
    args: (/** @type {string[]} */ calavera) => ["dlx", "create-project-calavera", ...calavera],
    runner: /^yarn /,
    runnerLabel: "yarn",
  },
  {
    id: "new-bun",
    label: "bunx",
    issues: ["#909"],
    command: "bunx",
    args: (/** @type {string[]} */ calavera) => ["create-project-calavera", ...calavera],
    runner: /^bunx? /,
    runnerLabel: "bun or bunx",
  },
  {
    id: "new-npx-package",
    label: "npx --package create-project-calavera",
    issues: ["#909", "#689", "#671"],
    command: "npx",
    args: (/** @type {string[]} */ calavera) => [
      "--package",
      "create-project-calavera",
      "create-project-calavera",
      ...calavera,
    ],
    runner: /^(npm|npx) /,
    runnerLabel: "npm or npx",
  },
];

/** @param {(typeof launchers)[number]} launcher */
function newProjectCheck(launcher) {
  return {
    id: launcher.id,
    name: `--new through ${launcher.label} produces a project inspect_project reports as managed, through the ${launcher.runnerLabel} runner`,
    issues: launcher.issues,
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const cwd = join(context.dirs.projects, launcher.id);
      await mkdir(cwd, { recursive: true });
      const requestsBefore = context.registry.requests.length;
      // A new home and caches per launcher, so each one downloads Calavera as a first-time user
      // would, and the request log shows that it came from the release candidate.
      const env = await context.freshEnvironment(launcher.id);
      const result = await context.run(
        launcher.command,
        launcher.args(["--yes", "--new", ...SCAFFOLD_ARGS]),
        { cwd, env },
      );
      assertExitZero(result);
      const servedCalavera = context.registry.requests
        .slice(requestsBefore)
        .some((request) => /\/create-project-calavera\/-\/.+\.tgz$/.test(request));
      if (!servedCalavera) {
        throw new CheckFailure({
          expected: `${launcher.label} to install create-project-calavera ${context.calavera.version} from the release candidate`,
          actual:
            "the rehearsal registry served no create-project-calavera tarball, so another copy ran",
          command: result.display,
        });
      }
      const runner = /^\s*Command: (.+)$/m.exec(result.output)?.[1] ?? "";
      if (!launcher.runner.test(runner)) {
        throw new CheckFailure({
          expected: `vp create to run through ${launcher.runnerLabel}, the runner ${launcher.label} implies`,
          actual: runner
            ? `Command: ${runner}`
            : `no "Command:" line in the output\n${tail(result.output)}`,
          command: result.display,
        });
      }
      const project = join(cwd, "app");
      await assertVitePlusVersion(context, project, launcher.label, result.display);
      await assertManaged(context, project);
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Section 0 item 2: the human output of --init, apply --dry-run, apply, a second dry run, and
// clean --dry-run.

/** Characters that can be part of a path or a package name in the output. */
const NAME_CHARACTER = /[\w./@-]/;

/**
 * How many times `name` appears in `text` as a whole word: not as part of a longer path or name.
 *
 * @param {string} text
 * @param {string} name A non-empty name. An empty name matches at the same position forever, so
 *   the search would never end; it throws a RangeError instead (#1226).
 */
export function countMentions(text, name) {
  if (name === "") {
    throw new RangeError(
      "countMentions needs a non-empty name, because the search for an empty one never ends.",
    );
  }
  let count = 0;
  let from = 0;
  for (;;) {
    const index = text.indexOf(name, from);
    if (index < 0) return count;
    const before = text[index - 1] ?? " ";
    const after = text[index + name.length] ?? " ";
    // A trailing period ends a sentence; it is not part of the name.
    const afterIsName =
      NAME_CHARACTER.test(after) &&
      !(after === "." && !NAME_CHARACTER.test(text[index + name.length + 1] ?? " "));
    if (!NAME_CHARACTER.test(before) && !afterIsName) count += 1;
    from = index + name.length;
  }
}

/** Removes the frame of a Clack box and list markers from one output line. @param {string} line */
function plainLine(line) {
  return line.replace(/[│┃├╮╯╭╰─◇◆●○■▲]/g, " ").trim();
}

/**
 * A heading is a short line that ends with a colon, such as "Files:" or "Next steps:", or the
 * title of a Clack note box, such as "◇  Next steps ──╮".
 *
 * @param {string} line
 */
export function isHeading(line) {
  if (/^\s*[◇◆]\s+\S.*─/.test(line)) return true;
  const text = plainLine(line);
  return text.length > 1 && text.length <= 60 && /^[A-Z][^:]*:$/.test(text);
}

/**
 * The name an item is printed under: the item itself, or the nearest directory above it that the
 * output names, because a command may report a directory it wrote, such as a skill folder, as one
 * line. Undefined when the output names neither. An absolute path splits into an empty first part,
 * so the empty root is never tried as a name: the path is matched by its full text, or by a
 * directory above it that the output names (#1226).
 *
 * @param {string} output
 * @param {string} item
 */
function printedName(output, item) {
  const parts = item.split("/");
  for (let length = parts.length; length > 0; length -= 1) {
    const candidate = parts.slice(0, length).join("/");
    if (candidate !== "" && countMentions(output, candidate) > 0) return candidate;
  }
  return undefined;
}

/**
 * Section 0 item 2: every item is printed once, under a heading.
 *
 * @param {string} output
 * @param {string[]} items Paths, dependency names, and artifact IDs the command handles.
 * @param {string[]} [statements] Fixed lines the result carries that state a fact about the
 *   project rather than list an item, such as the ADR-0011 Vite+ report in `vitePlus.lines`, which
 *   names the manifest that holds the Vite+ signal.
 * @returns {string[]} One line per violation.
 */
export function listingViolations(output, items, statements = []) {
  // A command, such as the "vp add -D" install command, names packages to run them, not to list
  // them, so its line does not count as a mention. #617 keeps one line per integration with the
  // package in parentheses only when the names differ, so an integration line that names its
  // package does count. A quoted value is the exact text a command writes, such as a script's
  // command or the lines of an ignore block, so a name inside it does not count either. A
  // package.json script's name is a key in the manifest, not the package it may share a name with,
  // such as the knip script that runs the knip package (#1128), so it does not count either.
  // The mask applies only to a line in the Scripts group that has one of the exact shapes
  // scriptLines in apply-summary.js prints, so other prose that mentions a script still counts
  // (#1144). A hook group line under the settings file names the artifact whose group it is,
  // because every artifact's groups sit under the file's one line (owner decision on #1145), so
  // the artifact named there does not count either. That mask applies only to a line in the
  // Artifacts group with one of the exact shapes hookGroupChangeLine in hook-group-lines.js, or
  // settingsFileLines in apply-summary.js, prints.
  const fixed = new Set(statements);
  let group = "";
  const lines = output
    .split("\n")
    .filter((line) => !isCommandLine(line) && !fixed.has(line.trim()))
    .map((line) => {
      if (isHeading(line)) group = plainLine(line);
      const masked = line.replace(QUOTED_VALUE, '""');
      if (group === "Scripts:") return withoutNamedSpans(masked, SCRIPT_LINES);
      if (group === "Artifacts:") return withoutNamedSpans(masked, HOOK_GROUP_LINES);
      return masked;
    });
  output = lines.join("\n");
  const firstHeading = lines.findIndex(isHeading);
  // An empty item names nothing the output could print, so it is reported, not looked for (#1226).
  const names = new Map(
    items.filter((item) => item !== "").map((item) => [item, printedName(output, item)]),
  );
  return [...new Set(names.values())]
    .flatMap((name) => {
      if (name === undefined) return [];
      const count = countMentions(output, name);
      if (count !== 1) return [`${name} is printed ${count} times`];
      const line = lines.findIndex((text) => countMentions(text, name) > 0);
      if (firstHeading < 0 || line <= firstHeading) return [`${name} is not under a heading`];
      return [];
    })
    .concat(
      [...names]
        .filter(([, name]) => name === undefined)
        .map(([item]) => `${item} is printed 0 times`),
    )
    .concat(
      items.includes("") ? ["an item has an empty name, so the check cannot look for it"] : [],
    );
}

// A JSON string literal, as Calavera quotes a script value or an ignore line.
const QUOTED_VALUE = /"(?:[^"\\]|\\.)*"/g;

// The lines scriptLines in apply-summary.js prints, once a quoted value is reduced to "", with the
// script names they hold in named groups, "name" and a rename's "target": "Would add script knip:
// \"\"", "Renamed script lint to lint:styles: \"\"", "Changed script knip from \"\" to \"\"", "Would
// omit script knip: <reason>", "Would omit vp check from script quality: <reason>", or "Scripts
// already set: knip, lint:styles". A name can hold colons, as lint:styles does, so only a colon
// before a space ends it.
const SCRIPT_LINES = [
  /^(?:Would add|Added|Would remove|Removed) script (?<name>\S+?): ""$/d,
  /^(?:Would omit|Omitted) script (?<name>\S+?): /d,
  /^(?:Would rename|Renamed) script (?<name>\S+?) to (?<target>\S+?): ""$/d,
  /^(?:Would change|Changed) script (?<name>\S+?) from "" to ""$/d,
  /^(?:Would omit|Omitted) \S.*? from script (?<name>\S+?): /d,
  /^Scripts already set: (?<name>.+)/d,
];

// The lines the apply summary prints under the settings file for each artifact's hook groups,
// with the artifact ID in the named group "artifact", and in "again" where a removal says the
// recipe no longer selects that same artifact. A group is printed as JSON, so once its strings are
// reduced to "" it reads as an object such as {"":[{"":""}]}: "Would add a SessionStart group for
// skill-a: {...}", "Replaced the PreToolUse group for skill-a: {...} with {...}", "Would remove
// the Stop group for skill-a, because the recipe no longer selects skill-a: {...}", or "Already
// holds the hook groups for skill-a" (#1145). An artifact ID holds no slash, so a path in its
// place is left counted.
const HOOK_GROUP_LINES = [
  /^(?:Would add|Added) a \S+ group for (?<artifact>[^\s/]+): \{.*\}$/d,
  /^(?:Would replace|Replaced) the \S+ group for (?<artifact>[^\s/]+): \{.*\} with \{.*\}$/d,
  /^(?:Would remove|Removed) the \S+ group for (?<artifact>[^\s/]+): \{.*\}$/d,
  /^(?:Would remove|Removed) the \S+ group for (?<artifact>[^\s/]+), because the recipe no longer selects (?<again>\k<artifact>): \{.*\}$/d,
  /^Already holds the hook groups for (?<artifact>[^\s/]+)$/d,
];

/**
 * A line with the names one of `shapes` holds in its named groups removed, or the line as it is
 * when it has none of the shapes: a script line of the Scripts group, whose script names are keys
 * in the manifest, not the package one may share a name with, or a hook group line of the
 * Artifacts group, whose artifact the summary lists elsewhere (#1128, #1145).
 *
 * @param {string} line
 * @param {RegExp[]} shapes
 */
function withoutNamedSpans(line, shapes) {
  const text = plainLine(line);
  for (const shape of shapes) {
    const spans = shape.exec(text)?.indices.groups;
    if (spans === undefined) continue;
    // From the last name back, so cutting one does not move the start of the one before it. The
    // match's own positions, not a search for the name, because a script can share its name with
    // a word of the line, such as a script named add.
    return Object.values(spans)
      .sort(([a], [b]) => b - a)
      .reduce((rest, [start, end]) => rest.slice(0, start) + rest.slice(end), text);
  }
  return line;
}

/**
 * Whether a line is a command, with an optional label such as "Dev dependency install command:".
 *
 * @param {string} line
 */
export function isCommandLine(line) {
  const text = plainLine(line)
    .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
    .replace(/^[A-Z][^:]{0,60}:\s+/, "")
    .replace(/^\$\s+/, "")
    .replace(/^`/, "");
  return COMMAND_WORDS.has(text.split(/\s+/)[0] ?? "");
}

const COMMAND_WORDS = new Set([
  "cd",
  "npm",
  "npx",
  "pnpm",
  "yarn",
  "bun",
  "bunx",
  "vp",
  "git",
  "create-project-calavera",
]);

/**
 * The commands the output tells a person to run: every line that, without list markers, a `$`
 * prompt, or backticks, starts with a command such as `pnpm` or `cd`. Section 0 asks that each of
 * them works when pasted, wherever the output prints it.
 *
 * @param {string} output
 */
export function nextStepCommands(output) {
  return output.split("\n").flatMap((line) => {
    const text = plainLine(line)
      .replace(/^(?:[-*•]|\d+[.)])\s+/, "")
      .replace(/^\$\s+/, "")
      .replace(/^`(.*)`$/, "$1")
      .trim();
    const word = text.split(/\s+/)[0] ?? "";
    return COMMAND_WORDS.has(word) ? [text] : [];
  });
}

/**
 * Whether a pasted command worked: it exited with code 0, or it stopped only because it asks for
 * a confirmation that a run without a terminal cannot give. A person who pastes it answers that
 * prompt; the rehearsal does not, so the confirmation itself is as far as it can go.
 *
 * @param {CommandResult} result
 */
export function pastedCommandWorked(result) {
  return result.exitCode === 0 || /cannot ask for confirmation/i.test(result.output);
}

/**
 * Runs each next-step command as pasted, in order, in a copy of `projectDirectory`, so the
 * commands cannot change the project later checks use. A `cd` moves the following commands.
 *
 * @param {RehearsalContext} context
 * @param {string} projectDirectory
 * @param {string} output
 * @param {string} label
 */
async function assertNextStepsRun(context, projectDirectory, output, label) {
  const commands = nextStepCommands(output);
  if (commands.length === 0) return;
  const copy = join(context.dirs.projects, `${label}-paste`);
  await rm(copy, { recursive: true, force: true });
  await cp(projectDirectory, copy, { recursive: true, verbatimSymlinks: true });
  const pwdFile = join(context.dirs.tmp, `${label}-pwd`);
  try {
    let cwd = copy;
    for (const command of commands) {
      // The shell runs the line as pasted, `cd` and `&&` included, and records where it ended up,
      // so the next line starts in the same directory, as it would in a terminal.
      const result = await context.run(
        "sh",
        ["-c", 'eval "$1"; status=$?; pwd > "$2"; exit $status', "sh", command, pwdFile],
        { cwd, timeout: 5 * 60_000 },
      );
      cwd = (await readFile(pwdFile, "utf8").catch(() => cwd)).trim() || cwd;
      if (!pastedCommandWorked(result)) {
        throw new CheckFailure({
          expected: `the next-step command "${command}" to work when pasted`,
          actual: `${describeExit(result)}\n${tail(result.output)}`,
          command: result.display,
        });
      }
    }
  } finally {
    await rm(copy, { recursive: true, force: true });
  }
}

/**
 * @param {CommandResult} result
 * @param {string[]} items
 * @param {string[]} [statements] See `listingViolations`.
 */
function assertListing(result, items, statements = []) {
  const violations = listingViolations(result.output, items, statements);
  if (violations.length > 0) {
    throw new CheckFailure({
      expected: "every file, dependency, and artifact printed once, under a heading",
      actual: `${violations.join("\n")}\n\nOutput:\n${tail(result.output)}`,
      command: result.display,
    });
  }
}

/**
 * The files, dependencies, and artifacts a JSON result names, wherever they sit in it: every
 * `path`, `destination`, and `file` value, the names in a dependency list or the keys of a
 * dependency map, and artifact IDs. An `integrationInputs` entry's `path` is the input's place in
 * the recipe, such as `integrationOptions.github-repository-controls.defaultBranch`, not a file,
 * and the summary prints the input by its name and value, so the entries name no item (#1143).
 *
 * @param {unknown} value
 * @returns {string[]}
 */
export function namedItems(value) {
  /** @type {string[]} */
  const items = [];
  /** @param {unknown} node @param {string} key */
  const visit = (node, key) => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, key);
      return;
    }
    if (node === null || typeof node !== "object") {
      if (typeof node === "string" && ["path", "destination", "file"].includes(key))
        items.push(node);
      return;
    }
    for (const [name, child] of Object.entries(node)) {
      if (name === "integrationInputs") continue;
      if (/dependencies$/i.test(name) && Array.isArray(child)) {
        // ApplyResult.dependencies is a list of package names.
        for (const entry of child) {
          if (typeof entry === "string") items.push(entry);
          else if (entry && typeof entry === "object" && typeof entry.name === "string")
            items.push(entry.name);
        }
      } else if (/dependencies$/i.test(name) && child && typeof child === "object") {
        items.push(...Object.keys(child));
      } else if (/artifacts$/i.test(name) && Array.isArray(child)) {
        for (const artifact of child) {
          if (artifact && typeof artifact === "object" && typeof artifact.id === "string")
            items.push(artifact.id);
        }
        visit(child, name);
      } else {
        visit(child, name);
      }
    }
  };
  visit(value, "");
  return [...new Set(items)];
}

/**
 * Why the cache is not ignored the way #841 decided, or undefined when it is: `git check-ignore -v`
 * must name a line of the project's own `.gitignore`, and that line must sit inside a block
 * Calavera marks with `# calavera:<owner>:start` and `# calavera:<owner>:end`.
 *
 * @param {string} checkIgnoreOutput `git check-ignore -v` output: `<source>:<line>:<pattern>\t<path>`.
 * @param {string} gitignore The project's `.gitignore`.
 */
export function cacheIgnoreProblem(checkIgnoreOutput, gitignore) {
  const match = /^(.*):(\d+):(.*)\t/.exec(checkIgnoreOutput.trim());
  if (!match) return ".calavera/cache is not ignored by any ignore file";
  const [, source, lineText, pattern] = match;
  if (pattern?.startsWith("!")) {
    return `.calavera/cache is re-included by the negated pattern ${pattern} on line ${lineText} of ${source}`;
  }
  if (source !== ".gitignore") {
    return `.calavera/cache is ignored by ${source}, not by the project's .gitignore`;
  }
  // Calavera's own block finder ignores trailing whitespace on a marker line, so this does too.
  const lines = gitignore.split(/\r?\n/).map((line) => line.trimEnd());
  const index = Number(lineText) - 1;
  for (let start = index - 1; start >= 0; start -= 1) {
    const owner = /^# calavera:(.+):start$/.exec(lines[start] ?? "")?.[1];
    if (owner === undefined) {
      if (/^# calavera:.+:end$/.test(lines[start] ?? "")) break;
      continue;
    }
    const end = lines.indexOf(`# calavera:${owner}:end`, index + 1);
    if (end > index) return undefined;
    break;
  }
  return `.calavera/cache is ignored by line ${lineText} of .gitignore, which is not inside a Calavera-marked block`;
}

/**
 * Whether the apply output says why the cache is not committed. #841 decided that Calavera writes
 * the ignore line in a marked `.gitignore` block and that the apply summary says so, so at least
 * one output line must name `.calavera/cache`, with or without a trailing slash, and say that it
 * is ignored or not committed. The wording is not settled, so the check asserts this property,
 * not a sentence. The line does not have to name `.gitignore`: the listing check already requires
 * `.gitignore` to be printed exactly once, and `cacheIgnoreProblem` checks the block itself.
 *
 * @param {string} output
 */
export function summaryExplainsCache(output) {
  return output
    .split("\n")
    .some(
      (line) =>
        (countMentions(line, ".calavera/cache") > 0 ||
          countMentions(line, ".calavera/cache/") > 0) &&
        /ignor|not commit/i.test(line.replaceAll(".calavera/cache", "")),
    );
}

/**
 * Whether Git ran a pre-commit hook during a commit, read from Git's own trace2 event log
 * (GIT_TRACE2_EVENT, Git 2.22 or later): a `child_start` event of class `hook` named `pre-commit`
 * from the top-level `git commit`, whose session ID has no `/`. A git the hook starts writes to the
 * same log with a nested session ID, so it cannot count as the hook. The hook's exit code is not
 * read here: the commit itself fails when the hook fails. This relies only on Git, not on how
 * Vite+ installs its hook.
 *
 * @param {string} trace One JSON event per line.
 * @returns {{ ran: boolean, argv?: string[] }}
 */
export function preCommitHookRun(trace) {
  const events = trace.split("\n").flatMap((line) => {
    try {
      return line.trim() ? [JSON.parse(line)] : [];
    } catch {
      return [];
    }
  });
  const start = events.find(
    (event) =>
      event.event === "child_start" &&
      event.child_class === "hook" &&
      event.hook_name === "pre-commit" &&
      typeof event.sid === "string" &&
      !event.sid.includes("/"),
  );
  return start ? { ran: true, argv: start.argv ?? [] } : { ran: false };
}

/** @param {CommandResult} result */
function parseJson(result) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new CheckFailure({
      expected: "JSON output",
      actual: tail(result.output),
      command: result.display,
    });
  }
}

/** @param {string} directory */
async function snapshotProject(directory) {
  const snapshot = await snapshotDirectory(directory);
  // Installed packages and Git's own files are not part of what a command must leave unchanged.
  return Object.fromEntries(
    Object.entries(snapshot).filter(
      ([path]) => !path.includes("/node_modules/") && !path.includes("/.git/"),
    ),
  );
}

/**
 * @param {RehearsalContext} context
 * @param {string} directory
 * @param {Record<string, string>} before
 * @param {string} command
 * @param {Record<string, string>} [after] A snapshot taken earlier; a new one when left out.
 */
async function assertUnchanged(context, directory, before, command, after) {
  after ??= await snapshotProject(directory);
  const changed = Object.keys({ ...before, ...after }).filter(
    (path) => before[path] !== after[path],
  );
  if (changed.length > 0) {
    throw new CheckFailure({
      expected: "a dry run to leave the project unchanged",
      actual: `changed: ${changed.map((path) => path.replace(`${directory}/`, "")).join(", ")}`,
      command,
    });
  }
}

/**
 * The project the item 2 and item 3 checks share: a Vite+ library scaffolded by Vite+ itself at the
 * run's Vite+ version, so these checks do not depend on the --new checks above.
 *
 * @param {RehearsalContext} context
 */
function flowProject(context) {
  return shared(context, "flow-project", async () => {
    const cwd = join(context.dirs.projects, "flow");
    await mkdir(cwd, { recursive: true });
    await context.runOrThrow("pnpm", ["create", "vite-plus", ...SCAFFOLD_ARGS], { cwd });
    const project = join(cwd, "app");
    await assertVitePlusVersion(
      context,
      project,
      "the flow project",
      `(cd ${cwd} && pnpm create vite-plus ${SCAFFOLD_ARGS.join(" ")})`,
      "Vite+ installed in the flow project",
    );
    return project;
  });
}

/** @param {RehearsalContext} context */
function flowInit(context) {
  return shared(context, "flow-init", async () => {
    const project = await flowProject(context);
    const before = await snapshotProject(project);
    // The scripts Vite+ scaffolded, so the eject checks can tell them from the ones Calavera adds.
    const scaffoldScripts = Object.keys(
      JSON.parse(await readFile(join(project, "package.json"), "utf8")).scripts ?? {},
    );
    const result = await context.run(
      context.calavera.bin,
      ["--init", "--yes", "--mcp-harness", "skip"],
      {
        cwd: project,
      },
    );
    return { project, before, after: await snapshotProject(project), result, scaffoldScripts };
  });
}

/**
 * What the flow recipe adds to the default profile, so the listing checks also cover output that
 * names them (#1146). Knip adds a `knip` script, which shares its name with the package, and the
 * protected-branch guard writes `.claude/settings.json` and wires `.vite-hooks` (#1128).
 * `skill-release-with-confidence` is an artifact installed from the release candidate.
 */
const FLOW_TOOLS = ["knip"];
const FLOW_AI_ARTIFACTS = ["skill-release-with-confidence", "skill-protected-branch-guard"];

/**
 * The branch the flow commit is made on. The guard protects `main`, the branch `vp create` makes,
 * and refuses a commit there, so the rehearsal does what the apply summary tells a person to do:
 * create a feature branch and commit there.
 */
export const FLOW_BRANCH = "apply-calavera";

/**
 * What a recipe is missing of the tools and artifacts the flow asked init for. A selection that
 * init drops would leave the listing checks passing without covering it.
 *
 * @param {string} text The recipe init wrote.
 * @returns {string[]}
 */
export function missingFlowSelections(text) {
  /** @type {{ integrations?: unknown, ai?: unknown }} */
  let recipe;
  try {
    recipe = JSON.parse(text);
  } catch {
    return ["calavera.config.json is not JSON"];
  }
  const integrations = Array.isArray(recipe?.integrations) ? recipe.integrations : [];
  const artifacts = Array.isArray(recipe?.ai) ? recipe.ai : [];
  return [
    ...FLOW_TOOLS.filter((id) => !integrations.includes(id)).map((id) => `integration ${id}`),
    ...FLOW_AI_ARTIFACTS.filter(
      (id) => !artifacts.some((/** @type {{ id?: unknown }} */ entry) => entry?.id === id),
    ).map((id) => `AI artifact ${id}`),
  ];
}

/** The recipe the apply checks use: written by `init --yes`, which composes the default recipe. @param {RehearsalContext} context */
function flowRecipe(context) {
  return shared(context, "flow-recipe", async () => {
    const { project } = await flowInit(context);
    // --profile is needed: without it, init asks for one even with --yes.
    const result = await context.runOrThrow(
      context.calavera.bin,
      [
        "init",
        "--yes",
        "--profile",
        "default",
        "--package-manager",
        "pnpm",
        ...FLOW_TOOLS.flatMap((id) => ["--tool", id]),
        ...FLOW_AI_ARTIFACTS.flatMap((id) => ["--ai-artifact", id]),
      ],
      { cwd: project },
    );
    const written = await readFile(join(project, "calavera.config.json"), "utf8").catch(
      () => undefined,
    );
    if (written === undefined) {
      throw new CheckFailure({
        expected: "init to write calavera.config.json",
        actual: `no calavera.config.json\n${tail(result.output)}`,
        command: result.display,
      });
    }
    const missing = missingFlowSelections(written);
    if (missing.length > 0) {
      throw new CheckFailure({
        expected: `calavera.config.json to select ${[...FLOW_TOOLS, ...FLOW_AI_ARTIFACTS].join(", ")}`,
        actual: `missing: ${missing.join(", ")}`,
        command: result.display,
      });
    }
    return project;
  });
}

/** @param {RehearsalContext} context */
function flowDryRun(context) {
  return shared(context, "flow-dry-run", async () => {
    const project = await flowRecipe(context);
    const before = await snapshotProject(project);
    const json = await context.run(context.calavera.bin, ["apply", "--dry-run", "--json"], {
      cwd: project,
    });
    const result = await context.run(context.calavera.bin, ["apply", "--dry-run"], {
      cwd: project,
    });
    return { project, before, json, result };
  });
}

/** @param {RehearsalContext} context */
function flowApply(context) {
  return shared(context, "flow-apply", async () => {
    const { project, json } = await flowDryRun(context);
    assertExitZero(json);
    const planned = namedItems(parseJson(json));
    const result = await context.run(context.calavera.bin, ["apply", "--yes"], { cwd: project });
    assertExitZero(result);
    const statePath = join(project, ".calavera", "state.json");
    const stateHash = createHash("sha256")
      .update(await readFile(statePath))
      .digest("hex");
    return { project, planned, result, stateHash };
  });
}

/** @param {RehearsalContext} context */
function flowCommit(context) {
  return shared(context, "flow-commit", async () => {
    const { project } = await flowApply(context);
    await context.runOrThrow("git", ["switch", "--create", FLOW_BRANCH], { cwd: project });
    await context.runOrThrow("git", ["add", "--all"], { cwd: project });
    // No --no-verify: the commit goes through the Vite+ pre-commit hook. Git's trace2 event log
    // records every hook it runs, which proves the hook ran rather than only that one is configured.
    const trace = join(context.dirs.tmp, "commit-trace2.json");
    const commit = await context.run("git", ["commit", "--message", "Apply Calavera"], {
      cwd: project,
      env: { ...context.env, GIT_TRACE2_EVENT: trace },
    });
    assertExitZero(commit);
    const traceText = await readFile(trace, "utf8").catch(() => "");
    if (!preCommitHookRun(traceText).ran) {
      throw new CheckFailure({
        expected: "the commit to run the Vite+ pre-commit hook",
        actual:
          traceText === ""
            ? "Git wrote no trace2 events (GIT_TRACE2_EVENT needs Git 2.22 or later), so the hook cannot be confirmed"
            : "Git's trace shows no pre-commit hook during the commit",
        command: `GIT_TRACE2_EVENT=${trace} ${commit.display}`,
      });
    }
    return project;
  });
}

const flowChecks = [
  {
    id: "init-output",
    name: "--init prints every file once, under headings, and its next-step commands work when pasted",
    issues: ["#601", "#602"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, before, after, result } = await flowInit(context);
      assertExitZero(result);
      const written = Object.keys({ ...before, ...after })
        .filter((path) => before[path] !== after[path] && !path.endsWith("/"))
        .map((path) => path.replace(`${project}/`, ""));
      assertListing(result, written);
      // #602: apply --dry-run and apply wait for a recipe, so the pasted commands run once the
      // project has one. Without a recipe, they run in the project as --init left it.
      const pasteFrom = await flowRecipe(context).catch(() => project);
      await assertNextStepsRun(context, pasteFrom, result.output, "init");
    },
  },
  {
    id: "apply-dry-run-output",
    name: "apply --dry-run changes nothing and prints every file, dependency, and artifact once, under headings",
    issues: ["#617", "#331"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, before, json, result } = await flowDryRun(context);
      assertExitZero(json);
      assertExitZero(result);
      await assertUnchanged(context, project, before, result.display);
      const report = parseJson(json);
      assertListing(result, namedItems(report), report.vitePlus?.lines);
      await assertNextStepsRun(context, project, result.output, "apply-dry-run");
    },
  },
  {
    id: "apply-output",
    name: "apply prints every file, dependency, and artifact once, under headings, and its next-step commands work",
    issues: ["#617", "#331"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, planned, result } = await flowApply(context);
      assertListing(result, planned);
      await assertNextStepsRun(context, project, result.output, "apply");
    },
  },
  {
    id: "second-dry-run-no-change",
    name: "A second apply --dry-run reports no change, prints it under headings, and its next-step commands work",
    issues: ["#617", "#331"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project } = await flowApply(context);
      const before = await snapshotProject(project);
      const json = await context.run(context.calavera.bin, ["apply", "--dry-run", "--json"], {
        cwd: project,
      });
      assertExitZero(json);
      const report = parseJson(json);
      const pending = [
        ...(report.changes ?? []).filter(
          (/** @type {{ type: string }} */ change) => change.type !== "unchanged",
        ),
        ...(report.autoInstalledArtifacts ?? []),
      ];
      if (pending.length > 0 || (report.changes ?? []).length === 0) {
        throw new CheckFailure({
          expected: 'every planned change to be "unchanged" and no artifact to install',
          actual: `${pending.length} pending: ${JSON.stringify(pending).slice(0, 2000)}`,
          command: json.display,
        });
      }
      const result = await context.run(context.calavera.bin, ["apply", "--dry-run"], {
        cwd: project,
      });
      assertExitZero(result);
      await assertUnchanged(context, project, before, result.display);
      assertListing(result, namedItems(report), report.vitePlus?.lines);
      await assertNextStepsRun(context, project, result.output, "second-dry-run");
    },
  },
  {
    id: "clean-dry-run-output",
    name: "clean --dry-run changes nothing and prints every file, dependency, and artifact once, under headings",
    issues: ["#331", "#601"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const project = await flowCommit(context).catch(
        async () => (await flowApply(context)).project,
      );
      const before = await snapshotProject(project);
      const json = await context.run(context.calavera.bin, ["clean", "--dry-run", "--json"], {
        cwd: project,
      });
      assertExitZero(json);
      const result = await context.run(context.calavera.bin, ["clean", "--dry-run"], {
        cwd: project,
      });
      assertExitZero(result);
      await assertUnchanged(context, project, before, result.display);
      assertListing(result, namedItems(parseJson(json)));
      await assertNextStepsRun(context, project, result.output, "clean-dry-run");
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Section 0 item 3: after apply and a commit through the Vite+ pre-commit hook.

const commitChecks = [
  {
    id: "hook-commit-clean",
    name: "After apply and a commit through the Vite+ pre-commit hook, git status is clean",
    issues: ["#838", "#841"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const project = await flowCommit(context);
      const status = await context.run("git", ["status", "--porcelain", "--untracked-files=all"], {
        cwd: project,
      });
      assertExitZero(status);
      if (status.stdout.trim() !== "") {
        throw new CheckFailure({
          expected: "git status to show no change",
          actual: tail(status.stdout),
          command: status.display,
        });
      }
    },
  },
  {
    id: "cache-not-committed",
    name: "The .calavera/cache folder is not committed and does not appear in git status",
    issues: ["#841"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const project = await flowCommit(context);
      const tracked = await context.run("git", ["ls-files", "--", ".calavera/cache"], {
        cwd: project,
      });
      const status = await context.run(
        "git",
        ["status", "--porcelain", "--untracked-files=all", "--", ".calavera/cache"],
        {
          cwd: project,
        },
      );
      const listed = `${tracked.stdout}${status.stdout}`.trim();
      if (listed !== "") {
        throw new CheckFailure({
          expected: "no file under .calavera/cache tracked or shown by git status",
          actual: tail(listed),
          command: `${tracked.display}; ${status.display}`,
        });
      }
    },
  },
  {
    id: "apply-summary-cache",
    name: "The apply summary says why the cache folder is not committed",
    issues: ["#841"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, result } = await flowApply(context);
      if (!summaryExplainsCache(result.output)) {
        throw new CheckFailure({
          expected:
            "an apply output line that names .calavera/cache and says it is ignored or not committed (#841)",
          actual: `${
            countMentions(result.output, ".calavera/cache") === 0 &&
            countMentions(result.output, ".calavera/cache/") === 0
              ? ".calavera/cache is not mentioned"
              : "no line that names .calavera/cache says it is ignored or not committed"
          }\n${tail(result.output)}`,
          command: result.display,
        });
      }
      const ignored = await context.run(
        "git",
        ["check-ignore", "--verbose", "--no-index", ".calavera/cache/npm/rehearsal-probe"],
        { cwd: project },
      );
      // git check-ignore exits 0 for a match, 1 for none, and 128 for an error.
      if (ignored.exitCode !== 0 && ignored.exitCode !== 1) {
        throw new CheckFailure({
          expected: "git check-ignore to run",
          actual: `${describeExit(ignored)}\n${tail(ignored.output)}`,
          command: ignored.display,
        });
      }
      const gitignore = await readFile(join(project, ".gitignore"), "utf8").catch(() => "");
      const problem = cacheIgnoreProblem(ignored.stdout, gitignore);
      if (problem) {
        throw new CheckFailure({
          expected:
            "a line in a Calavera-marked block of .gitignore to ignore .calavera/cache (#841)",
          actual: problem,
          command: ignored.display,
        });
      }
    },
  },
  {
    id: "state-committed-as-written",
    name: "The state file is committed as apply wrote it",
    issues: ["#838"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { stateHash } = await flowApply(context);
      const project = await flowCommit(context);
      const committed = await context.run("git", ["show", "HEAD:.calavera/state.json"], {
        cwd: project,
      });
      assertExitZero(committed);
      const hash = createHash("sha256").update(committed.stdout).digest("hex");
      if (hash !== stateHash) {
        throw new CheckFailure({
          expected:
            ".calavera/state.json in the commit to match what apply wrote (the hook must not reformat it)",
          actual: `apply wrote sha256 ${stateHash}; the commit holds sha256 ${hash}`,
          command: committed.display,
        });
      }
    },
  },
];

// ---------------------------------------------------------------------------------------------
// Section 0 item 4: the version notice.

const versionNoticeCheck = {
  id: "version-notice",
  name: "A Calavera older than the published latest prints the version notice",
  issues: ["#675"],
  /** @param {RehearsalContext} context */
  run: async (context) => {
    const [major] = context.calavera.version.split(".");
    const newer = `${Number(major) + 1}.0.0`;
    const registry = await context.startRegistry({
      advertisedLatest: { name: "create-project-calavera", version: newer },
    });
    const cwd = join(context.dirs.projects, "version-notice");
    await mkdir(cwd, { recursive: true });
    await writeFile(
      join(cwd, "package.json"),
      `${JSON.stringify({ name: "version-notice", private: true }, null, 2)}\n`,
    );
    await writeFile(join(context.dirs.home, ".npmrc"), `registry=${registry.url}/\n`);
    try {
      const result = await context.run(context.calavera.bin, ["--init", "--dry-run", "--yes"], {
        cwd,
        env: {
          ...context.env,
          npm_config_registry: `${registry.url}/`,
          YARN_NPM_REGISTRY_SERVER: registry.url,
          BUN_CONFIG_REGISTRY: `${registry.url}/`,
        },
      });
      if (
        countMentions(result.output, newer) === 0 ||
        countMentions(result.output, context.calavera.version) === 0
      ) {
        throw new CheckFailure({
          expected: `a notice that names the running version ${context.calavera.version} and the published latest ${newer}`,
          actual: tail(result.output),
          command: result.display,
        });
      }
    } finally {
      await writeFile(join(context.dirs.home, ".npmrc"), `registry=${context.registry.url}/\n`);
    }
  },
};

// ---------------------------------------------------------------------------------------------
// Section 0 item 5: the drift tests, run from this repository with the TAP reporter.

/**
 * @param {string} output TAP output of `node --test`.
 */
export function tapCounts(output) {
  /** @param {string} name */
  const count = (name) => Number(new RegExp(`^# ${name} (\\d+)$`, "m").exec(output)?.[1] ?? "0");
  return { pass: count("pass"), fail: count("fail") + count("cancelled") };
}

/**
 * @param {{ id: string, name: string, issues: string[], file: string, namePattern?: string }} options
 */
function driftCheck({ id, name, issues, file, namePattern }) {
  return {
    id,
    name,
    issues,
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const args = [
        "--test",
        "--test-reporter=tap",
        // In-process, so the counts are the tests themselves, not one entry for the file, and a
        // name pattern that matches nothing counts zero tests.
        "--test-isolation=none",
        ...(namePattern ? [`--test-name-pattern=${namePattern}`] : []),
        file,
      ];
      const result = await context.run(process.execPath, args, {
        cwd: context.repositoryRoot,
        env: { ...context.env, PATH: process.env.PATH },
      });
      const { pass, fail } = tapCounts(result.stdout);
      if (result.exitCode !== 0 || fail > 0 || pass === 0) {
        throw new CheckFailure({
          expected: `${file}${namePattern ? ` (tests matching ${namePattern})` : ""} to run at least one test, all passing`,
          actual: `${describeExit(result)}, ${pass} passed, ${fail} failed\n${tail(result.output)}`,
          command: result.display,
        });
      }
    },
  };
}

const driftChecks = [
  driftCheck({
    id: "drift-mcp-tool-list",
    name: "The drift test for the MCP tool list passes",
    issues: ["#839"],
    file: "packages/cli/scripts/mcp-tool-list-docs.test.mjs",
  }),
  driftCheck({
    id: "drift-agent-prompt",
    name: "The drift test for the agent prompt passes",
    issues: ["#840"],
    file: "packages/cli/scripts/agent-bootstrap.test.mjs",
    namePattern: "#840",
  }),
];

// ---------------------------------------------------------------------------------------------
// Section 0 item 6: eject on the --init project (#678, #1074, ADR-0017).

/**
 * The kinds of item that `--yes` leaves for an interactive approval in a project nobody edited:
 * the recipe and the extracted package folders, which have no check (ADR-0017, Consequences).
 */
const KINDS_YES_LEAVES = new Set(["recipe", "package-folder"]);

/**
 * The paths that may remain after `eject --yes`, read from the dry run's JSON: what ADR-0017's
 * Consequences keep, which is the recipe, the package folders, the records `--yes` keeps while one
 * of those needs it (`keptRecord`), and the footprint text eject keeps and reports. The rehearsal
 * project has no MCP harness (`--mcp-harness skip`) and nobody edits it, so any other item `--yes`
 * leaves, such as an MCP entry whose rewrite carries a note (Decision 5), fails the check.
 *
 * @param {{ items?: Array<{ kind: string, path: string, matchesRecords: boolean, keptRecord?: true }>, reported?: Array<{ path: string }> }} report
 */
function pathsYesMayLeave(report) {
  return [
    ...(report.items ?? [])
      .filter(
        (item) => item.keptRecord || (!item.matchesRecords && KINDS_YES_LEAVES.has(item.kind)),
      )
      .map(({ path }) => path),
    ...(report.reported ?? []).map(({ path }) => path),
  ];
}

/**
 * The candidate's own footprint list (ADR-0017 Decision 2), from the `eject.js` it ships, so the
 * rehearsal and `eject` cannot disagree about what counts. Each path that is a folder becomes the
 * files inside it, so a folder that may stay, such as `.calavera/packages`, cannot hide a package
 * the plan never named.
 *
 * @param {RehearsalContext} context
 * @param {string} project
 */
async function remainingFootprint(context, project) {
  const ejectModule = join(context.calavera.packageDirectory, "src", "eject.js");
  const { footprintIn } = await import(pathToFileURL(ejectModule).href);
  /** @type {string[]} */
  const remaining = [];
  for (const path of /** @type {string[]} */ (await footprintIn(project))) {
    const absolute = join(project, path);
    // lstat, not stat: a symbolic link, even a dangling one, is a footprint path of its own.
    if (!(await lstat(absolute)).isDirectory()) {
      remaining.push(path);
      continue;
    }
    const files = Object.keys(await snapshotDirectory(absolute))
      .filter((entry) => !entry.endsWith("/"))
      .map((entry) => relative(project, entry));
    remaining.push(...(files.length > 0 ? files : [path]));
  }
  return remaining;
}

/**
 * `eject --dry-run` and `eject --yes` on a copy of the flow project after apply and the commit,
 * so eject cannot change the project the other checks share.
 *
 * @param {RehearsalContext} context
 */
function flowEject(context) {
  return shared(context, "flow-eject", async () => {
    const source = await flowCommit(context).catch(async () => (await flowApply(context)).project);
    const project = join(context.dirs.projects, "eject");
    await rm(project, { recursive: true, force: true });
    await cp(source, project, { recursive: true, verbatimSymlinks: true });
    const before = await snapshotProject(project);
    const json = await context.run(context.calavera.bin, ["eject", "--dry-run", "--json"], {
      cwd: project,
    });
    const dryRun = await context.run(context.calavera.bin, ["eject", "--dry-run"], {
      cwd: project,
    });
    const afterDryRun = await snapshotProject(project);
    const yes = await context.run(context.calavera.bin, ["eject", "--yes"], { cwd: project });
    const afterYes = await snapshotProject(project);
    return { project, before, json, dryRun, afterDryRun, yes, afterYes };
  });
}

/**
 * What `eject --yes` changed beyond its dry run's plan, one line per path. ADR-0017 Decision 3
 * says eject keeps everything outside the footprint, such as managed files, kept AI artifacts,
 * hook wiring, and integration blocks in `.gitignore`, so every path that changed must be a plan
 * item's `path` or lie under one. A removed folder counts as planned when it held at least one
 * file and every file it held was planned, because eject removes a Calavera folder that its last
 * item leaves empty. An empty removed folder counts only inside Calavera's own folders. Each edit
 * `--yes` makes must leave exactly the `contents` the dry run showed. Every item `--yes` leaves
 * for an interactive run (`keptRecord`, or not `matchesRecords`), such as the recipe, the lock,
 * and the package folders, must stay as it was, down to each file below it. An MCP entry's
 * `contents` stay out of the JSON (ADR-0017, Amendment 3), so only the path rule covers it.
 *
 * @param {string} project
 * @param {{ items?: Array<{ kind: string, path: string, action?: string, matchesRecords: boolean, keptRecord?: true, contents?: string }> }} report
 * @param {Record<string, string>} before The snapshot after the dry run.
 * @param {Record<string, string>} after The snapshot after `--yes`.
 */
async function unplannedEjectChanges(project, report, before, after) {
  const items = report.items ?? [];
  /** @param {string} key A snapshot key: an absolute path, with a trailing `/` for a folder. */
  const pathOf = (key) => relative(project, key);
  /** @param {string} path @param {string} itemPath */
  const atOrUnder = (path, itemPath) => path === itemPath || path.startsWith(`${itemPath}/`);
  /** @param {string} path */
  const planned = (path) => items.some((item) => atOrUnder(path, item.path));
  /** @param {string} key */
  const removedFolderAllowed = (key) => {
    const files = Object.keys(before).filter(
      (entry) => entry.startsWith(key) && !entry.endsWith("/"),
    );
    if (files.length > 0) return files.every((entry) => planned(pathOf(entry)));
    const path = pathOf(key);
    return atOrUnder(path, ".calavera") || path === ".agents/calavera";
  };
  /** @param {string} key */
  const describe = (key) => {
    const change = !(key in after) ? "removed" : !(key in before) ? "added" : "changed";
    return { path: `${pathOf(key)}${key.endsWith("/") ? "/" : ""}`, change };
  };
  const changed = Object.keys({ ...before, ...after })
    .filter((key) => before[key] !== after[key])
    .sort();
  const problems = changed
    .filter((key) => !planned(pathOf(key)) && !(!(key in after) && removedFolderAllowed(key)))
    .map((key) => {
      const { path, change } = describe(key);
      return `${path} (${change})`;
    });
  for (const item of items) {
    if (item.keptRecord || !item.matchesRecords) {
      for (const key of changed.filter((entry) => atOrUnder(pathOf(entry), item.path))) {
        const { path, change } = describe(key);
        const left = pathOf(key) === item.path ? "it" : item.path;
        problems.push(`${path} (${change}, although --yes leaves ${left})`);
      }
    } else if (item.action === "edit" && item.kind !== "mcp-entry") {
      const text = await readFile(join(project, item.path), "utf8").catch(() => undefined);
      if (text !== item.contents) problems.push(`${item.path} (not the text the dry run planned)`);
    }
  }
  return problems;
}

/** The dry run's report, which every eject check reads. @param {RehearsalContext} context */
async function ejectPlan(context) {
  const { json } = await flowEject(context);
  assertExitZero(json);
  return parseJson(json);
}

const ejectChecks = [
  {
    id: "eject-dry-run-output",
    name: "eject --dry-run changes nothing and prints every item once, under headings",
    issues: ["#678", "#1074"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, before, dryRun, afterDryRun } = await flowEject(context);
      const report = await ejectPlan(context);
      assertExitZero(dryRun);
      await assertUnchanged(context, project, before, dryRun.display, afterDryRun);
      assertListing(dryRun, namedItems(report));
    },
  },
  {
    id: "eject-yes-footprint",
    name: "eject --yes prints every item once, under headings, and leaves only the footprint ADR-0017 keeps and reports",
    issues: ["#678", "#1074"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, yes } = await flowEject(context);
      const report = await ejectPlan(context);
      assertExitZero(yes);
      assertListing(yes, namedItems(report));
      const allowed = pathsYesMayLeave(report);
      const left = (await remainingFootprint(context, project)).filter(
        (path) => !allowed.some((keep) => path === keep || path.startsWith(`${keep}/`)),
      );
      if (left.length > 0) {
        throw new CheckFailure({
          expected: `only the footprint ADR-0017 keeps after --yes: ${allowed.join(", ") || "nothing"}`,
          actual: `still in the project:\n${left.join("\n")}`,
          command: yes.display,
        });
      }
      const { afterDryRun, afterYes } = await flowEject(context);
      const unplanned = await unplannedEjectChanges(project, report, afterDryRun, afterYes);
      if (unplanned.length > 0) {
        const outside = unplanned.filter((line) => /\((removed|added|changed)\)$/.test(line));
        const edits = unplanned.filter((line) => !outside.includes(line));
        throw new CheckFailure({
          expected:
            "eject --yes to change only the items its dry run planned, and each planned edit to leave the text the dry run showed (ADR-0017 Decisions 2 and 3)",
          actual: [
            ...(outside.length > 0 ? ["changed outside the plan:", ...outside] : []),
            ...edits,
          ].join("\n"),
          command: yes.display,
        });
      }
      // A file eject does not name in .calavera/ or .agents/calavera/ is one Calavera wrote but
      // eject does not know, so the footprint list in ADR-0017 Decision 2 is behind.
      if ((report.kept ?? []).length > 0) {
        throw new CheckFailure({
          expected: "eject to name every file in Calavera's folders that a fresh project holds",
          actual: `eject keeps files it does not name: ${report.kept.join(", ")}`,
          command: (await flowEject(context)).json.display,
        });
      }
    },
  },
  {
    id: "eject-keeps-toolchain",
    name: "After eject --yes, vp check and every script Calavera added exit 0",
    issues: ["#678", "#1074"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, yes } = await flowEject(context);
      assertExitZero(yes);
      const { scaffoldScripts } = await flowInit(context);
      const scripts = Object.keys(
        JSON.parse(await readFile(join(project, "package.json"), "utf8")).scripts ?? {},
      ).filter((name) => !scaffoldScripts.includes(name));
      for (const args of [["exec", "vp", "check"], ...scripts.map((name) => ["run", name])]) {
        const result = await context.run("pnpm", args, { cwd: project, timeout: 5 * 60_000 });
        if (result.exitCode !== 0) {
          throw new CheckFailure({
            expected: `pnpm ${args.join(" ")} to exit 0 after eject --yes`,
            actual: `${describeExit(result)}\n${tail(result.output)}`,
            command: result.display,
          });
        }
      }
    },
  },
  {
    // ADR-0017's Consequences: a second run reports nothing to do once only reported items
    // remain. `--yes` leaves the recipe and the package folders for an interactive approval,
    // which the rehearsal cannot give, so a second `--yes` may still list those, and only those.
    id: "eject-second-run",
    name: "A second eject --yes removes nothing and lists only what the first run left for an interactive approval",
    issues: ["#678", "#1074"],
    /** @param {RehearsalContext} context */
    run: async (context) => {
      const { project, yes } = await flowEject(context);
      assertExitZero(yes);
      const report = await ejectPlan(context);
      const second = await context.run(context.calavera.bin, ["eject", "--yes", "--json"], {
        cwd: project,
      });
      assertExitZero(second);
      const result = parseJson(second);
      const expected = new Set(
        (report.items ?? [])
          .filter(
            (/** @type {{ matchesRecords: boolean, keptRecord?: true }} */ item) =>
              item.keptRecord || !item.matchesRecords,
          )
          .map((/** @type {{ path: string }} */ { path }) => path),
      );
      // nothing-to-do counts only when the first run left nothing: otherwise --yes removed items
      // ADR-0017 Decision 5 says it must leave, and each one shows below as "not listed".
      /** @type {Array<{ path: string, outcome: string }>} */
      const items = result.items ?? [];
      const problems = [
        ...items
          .filter(({ path, outcome }) => outcome !== "left" || !expected.has(path))
          .map(({ path, outcome }) => `${path} (${outcome})`),
        ...[...expected]
          .filter((path) => !items.some((item) => item.path === path))
          .map((path) => `${path} (not listed)`),
      ];
      if (problems.length > 0) {
        throw new CheckFailure({
          expected: `a second eject to have nothing to remove, and to list only what the first left: ${[...expected].join(", ") || "nothing"}`,
          actual: `status ${result.status}:\n${problems.join("\n")}`,
          command: second.display,
        });
      }
    },
  },
];

export const cliExperienceChecks = [
  ...launchers.map(newProjectCheck),
  ...flowChecks,
  ...commitChecks,
  versionNoticeCheck,
  ...driftChecks,
  ...ejectChecks,
];
