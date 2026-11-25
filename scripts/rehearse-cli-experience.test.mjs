// Unit tests for the cli-experience rehearsal's own logic (#918), with stubbed checks and setup.
// The rehearsal itself needs network access and takes minutes, so it runs only through
// `pnpm release:rehearse:cli` and its workflow, never in `pnpm quality`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  rmdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";

import {
  buildEnvironment,
  compareRuns,
  formatCommand,
  formatReport,
  isolationViolations,
  parseOptions,
  prerequisiteProblems,
  runDirectories,
  runRehearsal,
  watchDeveloperState,
} from "./rehearse-cli-experience.mjs";
import {
  cacheIgnoreProblem,
  cliExperienceChecks,
  countMentions,
  isCommandLine,
  isHeading,
  listingViolations,
  namedItems,
  nextStepCommands,
  pastedCommandWorked,
  preCommitHookRun,
  summaryExplainsCache,
  tapCounts,
} from "./rehearsal-checks.mjs";
import { CheckFailure } from "./rehearsal-failure.mjs";
import {
  localPackument,
  parseRegistryPath,
  pinPackument,
  startRegistry,
  upstreamUrl,
} from "./rehearsal-registry.mjs";

const scratch = await mkdtemp(join(tmpdir(), "calavera-rehearsal-test-"));
after(() => rm(scratch, { recursive: true, force: true }));

/** A new, empty directory that stands in for the developer's HOME. */
async function fakeHome() {
  return mkdtemp(join(scratch, "home-"));
}

/** @param {string} id @param {() => Promise<void>} run */
const stubCheck = (id, run) => ({ id, name: `check ${id}`, issues: ["#1"], run });

const versions = { "create-project-calavera": "9.9.9", "Node.js": "v26.13.1", "Vite+": "1.6.0" };

test("a run reports every check, records its versions, and fails when one check fails", async () => {
  const report = await runRehearsal({
    strictDeveloperState: false,
    mode: "pinned",
    pins: {},
    tmpRoot: scratch,
    developerHome: await fakeHome(),
    prepare: async (_dirs, options) => (Object.assign(options.versions, versions), {}),
    checks: [
      stubCheck("passes", async () => {}),
      stubCheck("fails", async () => {
        throw new CheckFailure({
          expected: "exit code 0",
          actual: "exit code 1",
          command: "(cd <run> && false)",
        });
      }),
    ],
  });

  assert.equal(report.ok, false);
  assert.deepEqual(report.versions, versions);
  assert.deepEqual(
    report.results.map(({ id, status }) => [id, status]),
    [
      ["passes", "pass"],
      ["fails", "fail"],
      ["harness-cleanup", "pass"],
      ["harness-isolation", "pass"],
    ],
  );
  const failure = report.results.find(({ id }) => id === "fails");
  assert.equal(failure?.expected, "exit code 0");
  assert.equal(failure?.actual, "exit code 1");
  assert.equal(failure?.command, "(cd <run> && false)");
});

test("a run passes only when every check passes", async () => {
  const report = await runRehearsal({
    strictDeveloperState: false,
    mode: "latest",
    pins: {},
    tmpRoot: scratch,
    developerHome: await fakeHome(),
    prepare: async (_dirs, options) => (Object.assign(options.versions, versions), {}),
    checks: [stubCheck("passes", async () => {})],
  });
  assert.equal(report.ok, true);
  assert.equal(report.mode, "latest");
});

test("a run deletes its directory after a failing check, a throwing check, and a failed setup", async () => {
  const tmpRoot = await mkdtemp(join(scratch, "runs-"));
  /** @type {string[]} */
  const roots = [];
  const prepare = async (/** @type {{ root: string }} */ dirs) => {
    roots.push(dirs.root);
    await writeFile(join(dirs.root, "left-behind"), "x");
    return {};
  };
  const throwing = stubCheck("throws", async () => {
    throw new Error("boom");
  });
  const report = await runRehearsal({
    strictDeveloperState: false,
    mode: "pinned",
    pins: {},
    tmpRoot,
    developerHome: await fakeHome(),
    prepare,
    checks: [throwing],
  });
  assert.equal(report.results[0]?.status, "fail");
  assert.equal(report.results[0]?.actual, "boom");

  const failedSetup = await runRehearsal({
    strictDeveloperState: false,
    mode: "pinned",
    pins: {},
    tmpRoot,
    developerHome: await fakeHome(),
    prepare: async (dirs, options) => {
      roots.push(dirs.root);
      options.versions["Node.js"] = "v26.13.1";
      throw new CheckFailure({
        expected: "exit code 0",
        actual: "exit code 7",
        command: `(cd ${dirs.root} && npm install)`,
      });
    },
    checks: [throwing],
  });
  const setup = failedSetup.results.find(({ id }) => id === "setup");
  assert.equal(setup?.status, "fail");
  assert.equal(setup?.actual, "exit code 7");
  assert.equal(
    setup?.command,
    "(cd <run> && npm install)",
    "the run's path is replaced with <run>",
  );
  const notRun = failedSetup.results.find(({ id }) => id === "throws");
  assert.equal(notRun?.status, "fail", "every check still has a row after a failed setup");
  assert.equal(notRun?.actual, "not run: the rehearsal setup failed");
  assert.deepEqual(
    failedSetup.versions,
    { "Node.js": "v26.13.1" },
    "versions found before the failure are kept",
  );

  assert.equal(roots.length, 2);
  for (const root of roots) assert.equal(existsSync(root), false, `${root} remains`);
  assert.deepEqual(await readdir(tmpRoot), []);
});

test("a run closes what setup opened, also when a check fails", async () => {
  let closed = false;
  await runRehearsal({
    strictDeveloperState: false,
    mode: "pinned",
    pins: {},
    tmpRoot: scratch,
    developerHome: await fakeHome(),
    prepare: async () => ({
      close: async () => {
        closed = true;
      },
    }),
    checks: [stubCheck("fails", async () => Promise.reject(new Error("no")))],
  });
  assert.equal(closed, true);
});

test("a write below the developer's HOME during a run is a warning, not a failed check", async () => {
  const home = await fakeHome();
  const report = await runRehearsal({
    mode: "pinned",
    pins: {},
    tmpRoot: scratch,
    developerHome: home,
    strictDeveloperState: false,
    prepare: async (_dirs, options) => (Object.assign(options.versions, versions), {}),
    checks: [stubCheck("writes-npmrc", () => writeFile(join(home, ".npmrc"), "registry=x\n"))],
  });
  // Other sessions and tools on the same machine write to these caches too, and the rehearsal
  // cannot tell their writes from its own, so they are reported, never a failed release gate.
  assert.equal(report.ok, true);
  assert.equal(
    report.results.some(({ id }) => id === "harness-developer-state"),
    false,
  );
  assert.deepEqual(report.warnings, [
    "Files below the developer's HOME changed during the run: ~/.npmrc. Another process may have written them; the harness-isolation check shows whether the rehearsal's own commands stayed inside the run.",
  ]);
  assert.match(
    formatReport(report),
    /^### Warnings\n\n- Files below the developer's HOME changed during the run: ~\/\.npmrc\./m,
  );
});

test("the developer-state watch sees a new file and a deep cache entry, not a removed temporary one", async () => {
  const home = await fakeHome();
  await mkdir(join(home, ".npm", "_cacache", "index-v5", "ab"), { recursive: true });
  const watch = await watchDeveloperState(home, scratch, {});
  await writeFile(join(home, ".npm", "transient"), "");
  await rm(join(home, ".npm", "transient"));
  await writeFile(join(home, ".npm", "_cacache", "index-v5", "ab", "cd"), "");
  await mkdir(join(home, ".bun"));
  assert.deepEqual(await watch.changes(), ["~/.bun", "~/.npm/_cacache/index-v5/ab/cd"]);
  const quiet = await watchDeveloperState(home, scratch, {});
  assert.deepEqual(await quiet.changes(), []);
});

test("the pinned pnpm is the workspace's own, so the version table names the pnpm that packed", async () => {
  const pins = JSON.parse(
    await readFile(new URL("./rehearsal-pins.json", import.meta.url), "utf8"),
  );
  const workspace = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(workspace.packageManager, `pnpm@${pins.pnpm}`);
});

test("every home, cache, and store of a run is inside its root, and no caller setting leaks in", () => {
  const dirs = runDirectories("/run");
  const env = buildEnvironment(dirs, "http://127.0.0.1:4873", {
    nodeDirectory: "/node/bin",
    bunDirectory: "/bun/bin",
    base: {
      HOME: "/Users/dev",
      PATH: "/Users/dev/bin",
      npm_config_registry: "https://example.com/",
      COREPACK_HOME: "/Users/dev/corepack",
      PNPM_HOME: "/Users/dev/pnpm",
      YARN_CACHE_FOLDER: "/Users/dev/yarn",
      GIT_DIR: "/Users/dev/repo/.git",
      NODE_OPTIONS: "--require x",
      CI: "true",
      LANG: "en_US.UTF-8",
      HTTPS_PROXY: "http://proxy",
    },
  });
  for (const name of [
    "HOME",
    "TMPDIR",
    "XDG_CACHE_HOME",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "XDG_STATE_HOME",
    "npm_config_cache",
    "npm_config_userconfig",
    "npm_config_globalconfig",
    "npm_config_prefix",
    "COREPACK_HOME",
    "YARN_CACHE_FOLDER",
    "YARN_GLOBAL_FOLDER",
    "BUN_INSTALL_CACHE_DIR",
    "BUN_INSTALL",
  ]) {
    assert.ok(env[name]?.startsWith("/run/"), `${name} is ${env[name]}`);
  }
  assert.equal(env.npm_config_registry, "http://127.0.0.1:4873/");
  assert.equal(env.YARN_NPM_REGISTRY_SERVER, "http://127.0.0.1:4873");
  assert.equal(env.BUN_CONFIG_REGISTRY, "http://127.0.0.1:4873/");
  for (const name of ["PNPM_HOME", "GIT_DIR", "NODE_OPTIONS", "CI"]) {
    assert.equal(env[name], undefined, `${name} leaked`);
  }
  assert.equal(env.LANG, "en_US.UTF-8");
  assert.equal(env.HTTPS_PROXY, "http://proxy");
  assert.equal(env.GIT_CONFIG_NOSYSTEM, "1");
  assert.deepEqual(env.PATH?.split(":").slice(0, 3), ["/run/bin", "/node/bin", "/bun/bin"]);
  assert.equal(env.PATH?.includes("/Users/dev"), false);
});

test("Yarn's minimum package age gate is off in every run, and a caller's gate is not inherited (#970)", () => {
  // Yarn 4.18.1 holds back versions younger than npmMinimalAgeGate. On the day Vite+ releases,
  // yarn dlx create-vite-plus@latest would run the previous release while the report names the new one.
  const env = buildEnvironment(runDirectories("/run"), "http://127.0.0.1:4873", {
    nodeDirectory: "/node/bin",
    base: { YARN_NPM_MINIMAL_AGE_GATE: "1d" },
  });
  assert.equal(env.YARN_NPM_MINIMAL_AGE_GATE, "0");
});

test("the report has a versions table, a result table, and each failure's expected, actual, and command", () => {
  const text = formatReport({
    mode: "pinned",
    ok: false,
    versions: { "Vite+": "1.6.0", pnpm: "11.28.10" },
    results: [
      { id: "new-npm", name: "--new through npm create", issues: ["#909"], status: "pass" },
      {
        id: "version-notice",
        name: "the version notice",
        issues: ["#675"],
        status: "fail",
        expected: "a notice that names 7.0.0",
        actual: "no notice",
        command:
          "(cd <run>/projects/version-notice && create-project-calavera --init --dry-run --yes)",
      },
    ],
  });
  assert.match(text, /^## cli-experience rehearsal, pinned mode: FAIL \(1 of 2 checks pass\)$/m);
  assert.match(text, /^\| Vite\+ \| 1\.6\.0 \|$/m);
  assert.match(text, /^\| pass \| --new through npm create \| `new-npm` \| #909 \|$/m);
  assert.match(text, /^\| FAIL \| the version notice \| `version-notice` \| #675 \|$/m);
  assert.match(text, /^#### version-notice: the version notice$/m);
  assert.match(text, /^Expected: a notice that names 7\.0\.0$/m);
  assert.match(text, /```text\nno notice\n```/);
  assert.match(
    text,
    /^Command: `\(cd <run>\/projects\/version-notice && create-project-calavera --init --dry-run --yes\)`$/m,
  );
});

test("two runs compare by each check's outcome", () => {
  const run = (/** @type {Array<[string, "pass" | "fail"]>} */ outcomes) => ({
    results: outcomes.map(([id, status]) => ({ id, name: id, issues: [], status })),
  });
  assert.deepEqual(
    compareRuns(
      run([
        ["a", "pass"],
        ["b", "fail"],
      ]),
      run([
        ["a", "pass"],
        ["b", "fail"],
      ]),
    ),
    [],
  );
  assert.deepEqual(
    compareRuns(
      run([
        ["a", "pass"],
        ["b", "fail"],
      ]),
      run([["a", "fail"]]),
    ),
    ["a: pass then fail", "b: fail then missing"],
  );
});

test("options default to one pinned run and refuse an unknown mode or run count", () => {
  assert.deepEqual(parseOptions([]), {
    mode: "pinned",
    runs: 1,
    reportFile: undefined,
    jsonFile: undefined,
  });
  assert.equal(parseOptions(["--mode", "latest", "--runs", "2"]).runs, 2);
  assert.throws(() => parseOptions(["--mode", "newest"]), /--mode must be pinned or latest/);
  assert.throws(() => parseOptions(["--runs", "0"]), /--runs must be a whole number/);
});

test("every check has a unique ID, a name, and the issues that deliver it", async () => {
  const ids = cliExperienceChecks.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length);
  for (const check of cliExperienceChecks) {
    assert.ok(check.name.length > 0, check.id);
    assert.ok(
      check.issues.length > 0 && check.issues.every((issue) => /^#\d+$/.test(issue)),
      check.id,
    );
  }
  // Every issue the numbered exit-condition list in Section 0 names has a check, read from the
  // document itself, so a new item there fails this test until a check covers it.
  const map = await readFile(
    new URL("../docs/cross-repo/sequencing-map.md", import.meta.url),
    "utf8",
  );
  const exitList = /\*\*Exit condition:\*\*[\s\S]*?\n\n((?:\d+\. .*\n)+)/.exec(map)?.[1] ?? "";
  const named = [...new Set(exitList.match(/#\d+/g) ?? [])];
  assert.ok(named.length >= 13, `found only ${named.join(", ")} in the exit condition`);
  const covered = new Set(cliExperienceChecks.flatMap(({ issues }) => issues));
  for (const issue of named) assert.ok(covered.has(issue), `no check covers ${issue}`);
});

test("Section 0 names the rehearsal command as the exit condition's evidence", async () => {
  const map = await readFile(
    new URL("../docs/cross-repo/sequencing-map.md", import.meta.url),
    "utf8",
  );
  const exitCondition = /\*\*Exit condition:\*\*[^\n]*/.exec(map)?.[0] ?? "";
  assert.match(exitCondition, /`pnpm release:rehearse:cli`/);
});

test("a name counts once per whole-word mention, not inside a longer path", () => {
  const output =
    "Wrote .calavera/state.json.\nSkipped .calavera/state.json.bak and x.calavera/state.json";
  assert.equal(countMentions(output, ".calavera/state.json"), 1);
  assert.equal(countMentions("knip and knip-config", "knip"), 1);
});

test("headings are short lines ending in a colon, or a Clack note title", () => {
  assert.equal(isHeading("Files:"), true);
  assert.equal(isHeading("│  Next steps:"), true);
  assert.equal(isHeading("◇  Before Calavera runs vp create ─────╮"), true);
  assert.equal(isHeading("Wrote AGENTS.md: added a section"), false);
  assert.equal(isHeading("- AGENTS.md"), false);
});

test("a listing violation names an item printed twice, missing, or above every heading", () => {
  const output = [
    "Wrote AGENTS.md",
    "Files:",
    "- AGENTS.md",
    "- .editorconfig",
    "- .editorconfig",
  ].join("\n");
  assert.deepEqual(listingViolations(output, ["AGENTS.md", ".editorconfig", "knip"]), [
    "AGENTS.md is printed 2 times",
    ".editorconfig is printed 2 times",
    "knip is printed 0 times",
  ]);
  assert.deepEqual(listingViolations("Wrote x.json\nFiles:\n", ["x.json"]), [
    "x.json is not under a heading",
  ]);
  assert.deepEqual(
    listingViolations("Files:\n- x.json\nDependencies:\n- knip\n", ["x.json", "knip"]),
    [],
  );
  // A directory printed once covers the files Calavera wrote inside it.
  assert.deepEqual(
    listingViolations("Files:\n- .agents/skills/calavera\n", [
      ".agents/skills/calavera/SKILL.md",
      ".agents/skills/calavera/a.yaml",
    ]),
    [],
  );
});

/**
 * Calls an export of rehearsal-checks.mjs in a worker thread and returns its result, or throws
 * when it does not finish within `ms`. A loop that never ends blocks its own thread, so neither
 * the test's own timeout nor a timer in this thread could stop it; terminating the worker can
 * (#1226).
 *
 * @param {string} name
 * @param {unknown[]} args
 * @param {number} [ms]
 */
async function callWithin(name, args, ms = 5000) {
  const worker = new Worker(
    `const { parentPort, workerData } = require("node:worker_threads");
    import(workerData.module).then((module) => {
      try {
        parentPort.postMessage({ value: module[workerData.name](...workerData.args) });
      } catch (error) {
        parentPort.postMessage({
          error: { name: error.name, message: error.message, stack: error.stack },
        });
      }
    });`,
    {
      eval: true,
      workerData: { module: new URL("./rehearsal-checks.mjs", import.meta.url).href, name, args },
    },
  );
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  try {
    const message = await Promise.race([
      once(worker, "message").then(([data]) => data),
      once(worker, "error").then(([error]) => Promise.reject(error)),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} did not finish within ${ms} ms`)), ms);
      }),
    ]);
    if (message.error) throw Object.assign(new Error(message.error.message), message.error);
    return message.value;
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
}

test(
  "countMentions refuses an empty name, which would match forever",
  { timeout: 10_000 },
  async () => {
    await assert.rejects(callWithin("countMentions", ["Files:\n- x.json\n", ""]), {
      name: "RangeError",
      message: /non-empty name/,
    });
  },
);

test(
  "an item named by an absolute path is matched by its full text",
  { timeout: 20_000 },
  async () => {
    const output = "Files:\n  Would update /home/person/package.json\n";
    assert.deepEqual(
      await callWithin("listingViolations", [output, ["/home/person/package.json"]]),
      [],
    );
    // Printed twice, or not at all: the check reports it instead of trying the empty root as a name.
    assert.deepEqual(
      await callWithin("listingViolations", [
        `${output}  /home/person/package.json\n`,
        ["/home/person/package.json"],
      ]),
      ["/home/person/package.json is printed 2 times"],
    );
    assert.deepEqual(await callWithin("listingViolations", [output, ["/home/person/other.json"]]), [
      "/home/person/other.json is printed 0 times",
    ]);
  },
);

test("an empty item is reported, not looked for", { timeout: 10_000 }, async () => {
  assert.deepEqual(await callWithin("listingViolations", ["Files:\n- x.json\n", ["", "x.json"]]), [
    "an item has an empty name, so the check cannot look for it",
  ]);
});

test("next-step commands are every line that starts with a command, without markers", () => {
  const output = [
    "Wrote AGENTS.md",
    "Next steps:",
    "  1. cd app",
    "  2. `pnpm dlx create-project-calavera apply --dry-run`",
    "  - $ npx --package create-project-calavera create-project-calavera --help",
    "  Paste the prompt into your agent.",
    "│        npm create project-calavera apply",
    "  Command: npm create vite-plus@latest",
  ].join("\n");
  assert.deepEqual(nextStepCommands(output), [
    "cd app",
    "pnpm dlx create-project-calavera apply --dry-run",
    "npx --package create-project-calavera create-project-calavera --help",
    "npm create project-calavera apply",
  ]);
  assert.deepEqual(nextStepCommands("Done."), []);
});

test("a pasted command works when it exits 0 or stops only at a confirmation it cannot get", () => {
  const result = (/** @type {number} */ exitCode, /** @type {string} */ output) => ({
    exitCode,
    signal: null,
    timedOut: false,
    stdout: output,
    stderr: "",
    output,
    display: "",
  });
  assert.equal(pastedCommandWorked(result(0, "")), true);
  assert.equal(
    pastedCommandWorked(
      result(
        1,
        "--new refused: Calavera cannot ask for confirmation because stdin is not a terminal",
      ),
    ),
    true,
  );
  assert.equal(pastedCommandWorked(result(1, "ENOENT: calavera.config.json")), false);
});

test("named items are every path, dependency name, and artifact ID in a JSON result", () => {
  assert.deepEqual(
    namedItems({
      changes: [
        { type: "write", path: ".editorconfig" },
        { type: "unchanged", path: "AGENTS.md" },
      ],
      devDependencies: { knip: "^6.0.0" },
      autoInstalledArtifacts: [{ id: "skill-x", destination: ".claude/skills/x" }],
    }),
    [".editorconfig", "AGENTS.md", "knip", "skill-x", ".claude/skills/x"],
  );
});

test("TAP counts read the pass and fail totals", () => {
  assert.deepEqual(tapCounts("ok 1 - a\n# pass 3\n# fail 1\n# cancelled 1\n"), {
    pass: 3,
    fail: 2,
  });
  assert.deepEqual(tapCounts("Could not find file\n"), { pass: 0, fail: 0 });
});

test("a pinned packument drops newer versions and points latest and stale tags at the pin", () => {
  const pinned = pinPackument(
    {
      "dist-tags": { latest: "1.7.0", alpha: "0.1.21-alpha.7", staging: "1.7.0" },
      versions: { "0.1.21-alpha.7": {}, "1.6.0": {}, "1.7.0": {} },
      time: { created: "c", modified: "m", "1.6.0": "t6", "1.7.0": "t7" },
    },
    "1.6.0",
  );
  assert.deepEqual(Object.keys(pinned.versions), ["0.1.21-alpha.7", "1.6.0"]);
  assert.deepEqual(pinned["dist-tags"], {
    latest: "1.6.0",
    alpha: "0.1.21-alpha.7",
    staging: "1.6.0",
  });
  assert.deepEqual(pinned.time, { created: "c", modified: "m", "1.6.0": "t6" });
  assert.throws(() => pinPackument({ versions: { "1.0.0": {} } }, "1.6.0"), /no version 1\.6\.0/);
});

test("registry paths name the package and, for a tarball, its file", () => {
  assert.deepEqual(parseRegistryPath("/vite-plus"), { name: "vite-plus" });
  assert.deepEqual(parseRegistryPath("/@schalkneethling%2fcalavera-artifact-core"), {
    name: "@schalkneethling/calavera-artifact-core",
  });
  assert.deepEqual(
    parseRegistryPath("/create-project-calavera/-/create-project-calavera-6.2.1.tgz"),
    {
      name: "create-project-calavera",
      tarball: "create-project-calavera-6.2.1.tgz",
    },
  );
  assert.equal(parseRegistryPath("/-/npm/v1/security/advisories/bulk"), undefined);
});

test("the registry serves packed packages locally and holds Vite+ at the pin", async () => {
  const tarball = join(scratch, "pkg.tgz");
  await writeFile(tarball, "tarball bytes");
  const local = new Map([
    [
      "create-project-calavera",
      {
        name: "create-project-calavera",
        version: "6.3.0",
        path: tarball,
        integrity: "sha512-x",
        shasum: "abc",
        manifest: { name: "create-project-calavera", version: "6.3.0", bin: { a: "b" } },
      },
    ],
  ]);
  /** @type {string[]} */
  const upstream = [];
  const registry = await startRegistry({
    local,
    vitePlusVersion: "1.6.0",
    advertisedLatest: { name: "create-project-calavera", version: "7.0.0" },
    fetchUpstream: async (url) => {
      upstream.push(String(url));
      return Response.json({
        "dist-tags": { latest: "1.7.0" },
        versions: { "1.6.0": {}, "1.7.0": {} },
      });
    },
  });
  try {
    const packument = await (await fetch(`${registry.url}/create-project-calavera`)).json();
    assert.equal(packument["dist-tags"].latest, "7.0.0");
    assert.equal(
      packument.versions["6.3.0"].dist.tarball,
      `${registry.url}/create-project-calavera/-/create-project-calavera-6.3.0.tgz`,
    );
    assert.equal(
      await (await fetch(packument.versions["6.3.0"].dist.tarball)).text(),
      "tarball bytes",
    );
    const vitePlus = await (await fetch(`${registry.url}/vite-plus`)).json();
    assert.equal(vitePlus["dist-tags"].latest, "1.6.0");
    assert.deepEqual(Object.keys(vitePlus.versions), ["1.6.0"]);
    const other = await (await fetch(`${registry.url}/knip`)).json();
    assert.equal(other["dist-tags"].latest, "1.7.0", "other packages pass through unchanged");
    assert.deepEqual(upstream, [
      "https://registry.npmjs.org/vite-plus",
      "https://registry.npmjs.org/knip",
    ]);
    assert.ok(
      registry.requests.includes(
        "GET /create-project-calavera/-/create-project-calavera-6.3.0.tgz",
      ),
    );
  } finally {
    await registry.close();
  }
});

test("a local packument lists only the packed version as latest unless a newer one is advertised", () => {
  const local = {
    name: "@scope/pkg",
    version: "1.0.0",
    path: "/x.tgz",
    integrity: "sha512-x",
    shasum: "abc",
    manifest: { name: "@scope/pkg", version: "1.0.0" },
  };
  const packument = localPackument(local, "http://127.0.0.1:1");
  assert.equal(packument["dist-tags"].latest, "1.0.0");
  assert.deepEqual(Object.keys(packument.versions), ["1.0.0"]);
  assert.equal(
    packument.versions["1.0.0"]?.dist.tarball,
    "http://127.0.0.1:1/@scope/pkg/-/pkg-1.0.0.tgz",
  );
  assert.equal(localPackument(local, "http://127.0.0.1:1", "2.0.0")["dist-tags"].latest, "2.0.0");
});

test("prerequisites name every missing or mismatched tool with its remedy, before a run starts", async () => {
  const pins = { node: "26.13.1", bun: "1.4.4" };
  assert.deepEqual(
    await prerequisiteProblems(pins, { nodeVersion: "v26.13.1", bunVersion: async () => "1.4.4" }),
    [],
  );
  const problems = await prerequisiteProblems(pins, {
    nodeVersion: "v24.15.0",
    bunVersion: async () => undefined,
  });
  assert.equal(problems.length, 2);
  assert.match(problems[0] ?? "", /Node\.js v26\.13\.1 is required; this is v24\.15\.0\./);
  assert.match(problems[0] ?? "", /scripts\/rehearsal-pins\.json/);
  assert.match(problems[1] ?? "", /Bun 1\.4\.4 is required; bun is not on PATH\./);
  const [wrongBun] = await prerequisiteProblems(pins, {
    nodeVersion: "v26.13.1",
    bunVersion: async () => "1.3.9",
  });
  assert.match(wrongBun ?? "", /Bun 1\.4\.4 is required; bun --version prints 1\.3\.9\./);
});

test("an isolation violation names the command and every home, cache, or registry outside the run", () => {
  const dirs = runDirectories("/run");
  const env = buildEnvironment(dirs, "http://127.0.0.1:4873", { nodeDirectory: "/node/bin" });
  assert.deepEqual(isolationViolations(env, "/run", ["http://127.0.0.1:4873"]), []);
  const leaked = { ...env, HOME: "/Users/dev", npm_config_registry: "https://registry.npmjs.org/" };
  assert.deepEqual(isolationViolations(leaked, "/run", ["http://127.0.0.1:4873"]), [
    "HOME is /Users/dev",
    "npm_config_registry is https://registry.npmjs.org/",
  ]);
  // A second rehearsal registry, such as the version-notice check's, is inside the run too.
  const second = { ...env, npm_config_registry: "http://127.0.0.1:5000/" };
  assert.deepEqual(
    isolationViolations(second, "/run", ["http://127.0.0.1:4873", "http://127.0.0.1:5000"]),
    [],
  );
  const { npm_config_cache: _dropped, ...missing } = env;
  assert.deepEqual(isolationViolations(missing, "/run", ["http://127.0.0.1:4873"]), [
    "npm_config_cache is not set",
  ]);
});

test("a run fails when a command ran outside its isolated directories", async () => {
  const report = await runRehearsal({
    strictDeveloperState: false,
    mode: "pinned",
    pins: {},
    tmpRoot: scratch,
    developerHome: await fakeHome(),
    prepare: async (_dirs, options) => {
      options.isolation.push("(cd <run> && npm install): HOME is /Users/dev");
      return {};
    },
    checks: [stubCheck("passes", async () => {})],
  });
  const isolation = report.results.find(({ id }) => id === "harness-isolation");
  assert.equal(isolation?.status, "fail");
  assert.match(isolation?.actual ?? "", /HOME is \/Users\/dev/);
  assert.equal(report.ok, false);
});

test("on CI, a write below HOME during the run is a failed check, because nothing else runs there", async () => {
  const home = await fakeHome();
  const report = await runRehearsal({
    mode: "pinned",
    pins: {},
    tmpRoot: scratch,
    developerHome: home,
    strictDeveloperState: true,
    prepare: async () => ({}),
    checks: [stubCheck("writes-npmrc", () => writeFile(join(home, ".npmrc"), "registry=x\n"))],
  });
  const state = report.results.find(({ id }) => id === "harness-developer-state");
  assert.equal(state?.status, "fail");
  assert.equal(state?.actual, "changed: ~/.npmrc");
  assert.deepEqual(report.warnings, []);
});

test("isolation violations found during a failed setup still fail the run, with HOME printed as ~", async () => {
  const home = await fakeHome();
  const report = await runRehearsal({
    mode: "pinned",
    pins: {},
    tmpRoot: scratch,
    developerHome: home,
    strictDeveloperState: false,
    prepare: async (_dirs, options) => {
      options.isolation.push(`(cd <run> && npm install): HOME is ${home}`);
      throw new Error("npm install failed");
    },
    checks: [],
  });
  const isolation = report.results.find(({ id }) => id === "harness-isolation");
  assert.equal(isolation?.status, "fail");
  assert.equal(isolation?.actual, "(cd <run> && npm install): HOME is ~");
});

test("any other variable that points into the developer's HOME is a violation", () => {
  const dirs = runDirectories("/run");
  const env = buildEnvironment(dirs, "http://127.0.0.1:4873", { nodeDirectory: "/node/bin" });
  assert.deepEqual(
    isolationViolations(
      { ...env, PNPM_HOME: "/Users/dev/Library/pnpm", SSL_CERT_FILE: "/Users/dev/certs.pem" },
      "/run",
      ["http://127.0.0.1:4873"],
      "/Users/dev",
    ),
    ["PNPM_HOME is /Users/dev/Library/pnpm"],
    "inherited network settings such as SSL_CERT_FILE are allowed",
  );
});

test("a missing git or tar is a prerequisite problem", async () => {
  const problems = await prerequisiteProblems(
    { node: "26.13.1", bun: "1.4.4" },
    {
      nodeVersion: "v26.13.1",
      bunVersion: async () => "1.4.4",
      hasCommand: async (command) => command !== "tar",
    },
  );
  assert.equal(problems.length, 1);
  assert.match(
    problems[0] ?? "",
    /^tar is required and is not on the PATH the rehearsal gives its commands/,
  );
});

test("the command stops before it creates anything when a prerequisite is missing, with exit code 2", async () => {
  // A bin directory with the running Node.js and a bun that reports another version, so the
  // preflight cannot pass whatever is installed on this machine.
  const bin = await mkdtemp(join(scratch, "bin-"));
  await symlink(process.execPath, join(bin, "node"));
  await writeFile(join(bin, "bun"), "#!/bin/sh\necho 0.0.1\n");
  await chmod(join(bin, "bun"), 0o755);
  const tmp = await mkdtemp(join(scratch, "tmp-"));
  const report = join(tmp, "report.md");
  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("./rehearse-cli-experience.mjs", import.meta.url)),
      "--report-file",
      report,
    ],
    { env: { PATH: bin, HOME: await fakeHome(), TMPDIR: tmp }, encoding: "utf8" },
  );
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /^The cli-experience rehearsal cannot start; nothing was created:\n/);
  assert.match(result.stderr, /Bun 1\.4\.4 is required; bun --version prints 0\.0\.1\./);
  assert.deepEqual(await readdir(tmp), ["report.md"], "only the requested report was written");
  assert.match(
    await readFile(report, "utf8"),
    /^## cli-experience rehearsal, pinned mode: CANNOT START/,
  );
});

test("the registry proxy forwards only origin-form paths to the fixed public registry", () => {
  assert.equal(String(upstreamUrl("/knip")), "https://registry.npmjs.org/knip");
  assert.equal(
    String(upstreamUrl("/@scope%2fpkg?write=true")),
    "https://registry.npmjs.org/@scope%2fpkg?write=true",
  );
  assert.equal(upstreamUrl("//evil.example/x"), undefined);
  assert.equal(upstreamUrl("@evil.example/x"), undefined);
  assert.equal(upstreamUrl("http://evil.example/x"), undefined);
  assert.equal(new URL(String(upstreamUrl("/..//evil.example/x"))).host, "registry.npmjs.org");
});

// Greptile review of #938: four ways a check could pass while its feature is missing.

test("dependencies are named items, so a missing or repeated dependency fails the listing", () => {
  // ApplyResult.dependencies is a string[] of package names (packages/cli/src/index.js).
  const items = namedItems({
    changes: [{ type: "write", path: ".editorconfig" }],
    dependencies: ["knip", "stylelint"],
  });
  assert.deepEqual(items, [".editorconfig", "knip", "stylelint"]);
  assert.deepEqual(
    listingViolations(
      "Files:\n- .editorconfig\nDev dependencies: knip\nDev dependency install command: vp add -D knip\n",
      items,
    ),
    ["stylelint is printed 0 times"],
    "the install command names knip to run it, so only the listing line counts",
  );
  assert.deepEqual(listingViolations("Integrations: knip\nDev dependencies: knip\n", ["knip"]), [
    "knip is printed 2 times",
  ]);
  assert.equal(isCommandLine("Dev dependency install command: vp add -D knip"), true);
  assert.equal(isCommandLine("Integrations: stylelint"), false);
  assert.deepEqual(namedItems({ dependencies: [{ name: "knip" }] }), ["knip"]);
});

test("a quoted value and a fixed statement do not count as listings (#617)", () => {
  // A script's command and an ignore block's lines are the text apply writes, quoted as JSON.
  const output = [
    "Integrations:",
    "  stylelint",
    "Files:",
    "  Would update package.json",
    "Scripts:",
    '  Would add script lint:styles: "stylelint \\"**/*.css\\" --allow-empty-input"',
  ].join("\n");
  assert.deepEqual(listingViolations(output, ["stylelint", "package.json"]), []);
  // The ADR-0011 report names the manifest that holds the Vite+ signal; it lists nothing.
  const report =
    "Vite+ detection: managed. This project is vp-managed (vite-plus-dependency signal at package.json).";
  const withReport = `Project:\n  ${report}\n${output}`;
  assert.deepEqual(listingViolations(withReport, ["package.json"]), [
    "package.json is printed 2 times",
  ]);
  assert.deepEqual(listingViolations(withReport, ["package.json"], [report]), []);
  // A name outside the quotes still counts.
  assert.deepEqual(listingViolations(`${output}\n  Dev dependencies: stylelint`, ["stylelint"]), [
    "stylelint is printed 2 times",
  ]);
});

test("a package.json script name is not a listing of the package it shares a name with (#1128)", () => {
  // Knip adds a script named knip; the script line names the script, the Integrations line the
  // package.
  const output = [
    "Integrations:",
    "  knip",
    "Files:",
    "  Would update package.json",
    "Scripts:",
    '  Would add script knip: "knip"',
    '  Would add script lint:styles: "stylelint"',
    '  Would rename script knip to knip:check: "knip"',
    '  Would change script knip from "knip" to "knip --strict"',
    '  Would remove script knip: "knip"',
    "  Would omit script knip: no file to check",
    "  Scripts already set: knip, lint:styles",
  ].join("\n");
  assert.deepEqual(listingViolations(output, ["knip", "package.json"]), []);
  // A package named twice outside its script lines is still a repeat, and one named only as a
  // script is not listed at all.
  assert.deepEqual(listingViolations(`${output}\n  Dev dependencies: knip`, ["knip"]), [
    "knip is printed 2 times",
  ]);
  assert.deepEqual(listingViolations(output.replace("Integrations:\n  knip\n", ""), ["knip"]), [
    "knip is printed 0 times",
  ]);
  // The reason after a script's name is not part of the name, so a package it names still counts.
  assert.deepEqual(
    listingViolations("Scripts:\n  Would omit script lint: stylelint is not selected\n", [
      "stylelint",
    ]),
    [],
  );
  assert.deepEqual(
    listingViolations(
      "Integrations:\n  stylelint\nScripts:\n  Would omit script lint: stylelint is not selected\n",
      ["stylelint"],
    ),
    ["stylelint is printed 2 times"],
  );
});

test("the script-name mask covers only the summary's script lines, not other script prose (#1144)", () => {
  // Every shape scriptLines in apply-summary.js prints, in both tenses, each naming a script that
  // shares its name with a package the Integrations group lists once.
  const scriptGroup = [
    "Scripts:",
    '  Would add script knip: "knip"',
    '  Added script stylelint: "stylelint"',
    '  Would rename script knip to stylelint: "stylelint"',
    '  Renamed script stylelint to knip: "knip"',
    '  Would change script knip from "knip" to "knip --strict"',
    '  Changed script stylelint from "stylelint" to "stylelint --fix"',
    "  Scripts already set: knip, stylelint",
    '  Would remove script knip: "knip"',
    '  Removed script stylelint: "stylelint"',
    "  Would omit script knip: no file to check",
    "  Omitted script stylelint: no CSS files",
    "  Would omit vp check from script knip: Vite+ is not installed",
    "  Omitted vp check from script stylelint: Vite+ is not installed",
  ];
  const listed = [
    "Integrations:",
    "  knip",
    "  stylelint",
    "Files:",
    "  Would update package.json",
    "Artifacts:",
    "  Would lock skill-protected-branch-guard 1.0.0",
  ];
  const items = ["knip", "stylelint", "package.json", "skill-protected-branch-guard"];
  const run = (/** @type {string[]} */ extra, group = scriptGroup) =>
    listingViolations([...listed, ...group, ...extra].join("\n"), items);
  assert.deepEqual(run([]), []);
  // The CLI prints the summary without a Clack frame today; should it print one, the same shapes
  // inside it are still script lines.
  assert.deepEqual(
    run(
      [],
      scriptGroup.map((line) => `│  ${line.trim()}`),
    ),
    [],
  );

  // Script prose in any other shape names the package, inside the Scripts group or out of it.
  assert.deepEqual(run(["  The script knip from the old recipe stays as it is"]), [
    "knip is printed 2 times",
  ]);
  assert.deepEqual(run(["Notes:", "  Kept the script stylelint from the old recipe"]), [
    "stylelint is printed 2 times",
  ]);
  assert.deepEqual(run(["Notes:", "  Run the script knip: it checks for unused files"]), [
    "knip is printed 2 times",
  ]);
  // A shape that starts or ends inside other prose is not a script line, even in the Scripts group.
  for (const line of [
    '  Before, Would add script knip: ""',
    '  Before, Would rename script knip to lint: ""',
    '  Before, Would change script knip from "" to ""',
    "  Before, Would omit script knip: no reason",
    "  Before, Would omit vp check from script knip: no reason",
    "  Before, Scripts already set: knip",
  ]) {
    assert.deepEqual(run([line]), ["knip is printed 2 times"], line);
  }
  for (const line of [
    '  Would add script knip: "" for stylelint',
    '  Removed script knip: "" for stylelint',
    '  Would rename script knip to lint: "" for stylelint',
    '  Would change script knip from "" to "" for stylelint',
  ]) {
    assert.deepEqual(
      run([line]),
      ["knip is printed 2 times", "stylelint is printed 2 times"],
      line,
    );
  }
  // A script-line shape outside the Scripts group is not a script line, nor is one above every
  // heading.
  assert.deepEqual(
    listingViolations(['Would add script knip: ""', ...listed, ...scriptGroup].join("\n"), items),
    ["knip is printed 2 times"],
  );
  assert.deepEqual(run(["Notes:", '  Would add script knip: "knip"']), ["knip is printed 2 times"]);
  assert.deepEqual(run(["Notes:", "  Scripts already set: stylelint"]), [
    "stylelint is printed 2 times",
  ]);

  // A file, a dependency, or an artifact named twice outside the script lines is still a repeat.
  assert.deepEqual(
    run([
      "Notes:",
      "  package.json keeps its scripts",
      "  Dev dependencies: knip",
      "  skill-protected-branch-guard is locked",
    ]),
    [
      "knip is printed 2 times",
      "package.json is printed 2 times",
      "skill-protected-branch-guard is printed 2 times",
    ],
  );
  // The reason after a script line's name is not masked, so a package it names still counts.
  assert.deepEqual(run(["  Would omit script lint: knip is not selected"]), [
    "knip is printed 2 times",
  ]);
  // The mask cuts each name where the shape holds it, not the first text that matches it: here
  // that would be the "ad" inside "add" and the "d" before "ad".
  assert.deepEqual(
    listingViolations(
      [
        "Integrations:",
        "  ad",
        "  d",
        "Scripts:",
        '  Would add script ad: "ad"',
        '  Would rename script d to ad: "ad"',
      ].join("\n"),
      ["ad", "d"],
    ),
    [],
  );
});

test("an artifact named on a hook group line under the settings file is not a listing, but a real repeat still fails (#1145)", () => {
  // The apply summary prints .claude/settings.json once, under Artifacts, with each artifact's
  // hook groups under it, and each group line names its artifact (owner decision on #1145).
  const groups = [
    "  Would update .claude/settings.json",
    '    Would add a SessionStart group for skill-a: {"hooks":[]}',
    '    Would replace the PreToolUse group for skill-a: {"hooks":[]} with {"hooks":[1]}',
    '    Would remove the Stop group for skill-a: {"hooks":[]}',
    '    Would remove the Stop group for skill-b, because the recipe no longer selects skill-b: {"hooks":[]}',
    "    Already holds the hook groups for skill-c",
    '    Added a SessionStart group for skill-a: {"hooks":[]}',
    '    Replaced the PreToolUse group for skill-a: {"hooks":[]} with {"hooks":[1]}',
    '    Removed the Stop group for skill-b, because the recipe no longer selects skill-b: {"hooks":[]}',
  ];
  const output = [
    "Artifacts:",
    "  Would write skill-a to .agents/skills/a",
    "  skill-b, which the recipe no longer selects",
    "  Unchanged skill-c at .agents/skills/c",
    ...groups,
  ].join("\n");
  const items = ["skill-a", "skill-b", "skill-c", ".claude/settings.json"];
  assert.deepEqual(listingViolations(output, items), []);

  // An artifact named twice outside the group lines is still a repeat.
  assert.deepEqual(listingViolations(`${output}\n  Unchanged skill-a at .agents/skills/a`, items), [
    "skill-a is printed 2 times",
  ]);
  // So is an artifact named only on group lines: they do not list it.
  assert.deepEqual(listingViolations(["Artifacts:", ...groups].join("\n"), ["skill-a"]), [
    "skill-a is printed 0 times",
  ]);
  // A path in the artifact's place is not an artifact ID, so the mask leaves it counted.
  assert.deepEqual(
    listingViolations(
      "Artifacts:\n  Wrote .agents/x.md\n    Already holds the hook groups for .agents/x.md\n",
      [".agents/x.md"],
    ),
    [".agents/x.md is printed 2 times"],
  );
  // A group line outside Artifacts, or of another shape, still counts.
  for (const line of [
    'Notes:\n  Would add a SessionStart group for skill-a: {"hooks":[]}',
    "Artifacts:\n    Would add a SessionStart group for skill-a: unquoted",
    'Artifacts:\n    Would remove the Stop group for skill-a, because the recipe no longer selects skill-z: {"hooks":[]}',
    "Artifacts:\n    Already holds the hook groups for skill-a, and more",
  ]) {
    assert.deepEqual(
      listingViolations(`${output}\n${line}`, ["skill-a"]),
      ["skill-a is printed 2 times"],
      line,
    );
  }
});

test("an integration input's recipe path is not a listed file, but a real file named twice still fails (#1143)", () => {
  // The apply --dry-run output and the integrationInputs entry --json reports for a recipe that
  // selects github-repository-controls and records its defaultBranch, trimmed from a real run.
  const output = [
    "Calavera apply dry run complete. No files were changed.",
    "",
    "Integrations:",
    "  editorconfig",
    "  github-repository-controls",
    "    defaultBranch = main (recorded in the recipe)",
    "",
    "Files:",
    "  Would update package.json",
    "  Would write and own .editorconfig",
    "  Would write and own .github/repository-controls.json",
    "  Would write and own scripts/repository-controls.mjs",
    "",
    "Scripts:",
    '  Would add script repo:controls:check: "node scripts/repository-controls.mjs"',
  ].join("\n");
  const report = {
    changes: [
      { type: "update", path: "package.json" },
      { type: "write", path: ".editorconfig" },
      { type: "write", path: ".github/repository-controls.json" },
      { type: "write", path: "scripts/repository-controls.mjs" },
    ],
    integrationInputs: [
      {
        integration: "github-repository-controls",
        name: "defaultBranch",
        path: "integrationOptions.github-repository-controls.defaultBranch",
        value: "main",
        source: "recorded",
      },
    ],
  };
  const items = namedItems(report);
  assert.deepEqual(items, [
    "package.json",
    ".editorconfig",
    ".github/repository-controls.json",
    "scripts/repository-controls.mjs",
  ]);
  assert.deepEqual(listingViolations(output, items), []);
  assert.deepEqual(
    listingViolations(`${output}\n  Would write and own .editorconfig`, items),
    [".editorconfig is printed 2 times"],
    "a real file the output names twice is still a repeat",
  );
});

test("the cache must be ignored by a line inside a Calavera-marked block of the root .gitignore", () => {
  const gitignore = [
    "node_modules",
    "# calavera:calavera-cache:start",
    ".calavera/cache/",
    "# calavera:calavera-cache:end",
    "",
  ].join("\n");
  assert.equal(
    cacheIgnoreProblem(".gitignore:3:.calavera/cache/\t.calavera/cache/npm/x", gitignore),
    undefined,
  );
  assert.match(cacheIgnoreProblem("", gitignore) ?? "", /is not ignored/);
  assert.match(
    cacheIgnoreProblem(
      ".gitignore:1:.calavera/cache/\t.calavera/cache/npm/x",
      ".calavera/cache/\n",
    ) ?? "",
    /line 1 of \.gitignore, which is not inside a Calavera-marked block/,
  );
  assert.match(
    cacheIgnoreProblem(".git/info/exclude:1:.calavera/\t.calavera/cache/npm/x", gitignore) ?? "",
    /ignored by \.git\/info\/exclude, not by the project's \.gitignore/,
  );
  // git check-ignore --verbose also prints a matching negated pattern, which re-includes the path.
  assert.match(
    cacheIgnoreProblem(".gitignore:3:!.calavera/cache/npm/x\t.calavera/cache/npm/x", gitignore) ??
      "",
    /re-included by the negated pattern/,
  );
  // Calavera's block finder ignores trailing whitespace on a marker line.
  assert.equal(
    cacheIgnoreProblem(
      ".gitignore:2:.calavera/cache/\t.calavera/cache/npm/x",
      "# calavera:calavera-cache:start  \r\n.calavera/cache/\r\n# calavera:calavera-cache:end\r\n",
    ),
    undefined,
  );
});

test("the apply summary explains the cache only when a line names it and says it is ignored or not committed", () => {
  assert.equal(summaryExplainsCache("Wrote .calavera/cache/npm"), false);
  assert.equal(summaryExplainsCache("Wrote .calavera/cache\nWrote .gitignore"), false);
  assert.equal(summaryExplainsCache(".calavera/cache is not committed."), true);
  assert.equal(
    summaryExplainsCache(
      "Cache: .calavera/cache is not committed; a marked block in .gitignore ignores it.",
    ),
    true,
  );
  // The line apply prints today for a catalog ignore entry, with the trailing slash.
  assert.equal(
    summaryExplainsCache(
      'Ignore: Would add the calavera-cache block to .gitignore: ".calavera/cache/"',
    ),
    true,
  );
});

test("a pre-commit hook counts as run only when the top-level git commit started it", () => {
  const event = (/** @type {Record<string, unknown>} */ fields) => JSON.stringify(fields);
  const sid = "20261115T232322.955909Z-H828a8b6e-P00001518";
  const ran = [
    event({
      event: "child_start",
      sid,
      child_id: 0,
      child_class: "hook",
      hook_name: "pre-commit",
      argv: [".vite-hooks/_/pre-commit"],
    }),
    // A git the hook starts logs to the same file with a nested session ID and reuses child_id 0.
    event({ event: "child_exit", sid: `${sid}/20261115T232323.1Z-H1-P2`, child_id: 0, code: -1 }),
    event({ event: "child_exit", sid, child_id: 0, code: 0 }),
  ].join("\n");
  assert.deepEqual(preCommitHookRun(ran), { ran: true, argv: [".vite-hooks/_/pre-commit"] });
  // A pre-commit hook of a nested git commit, started by something else, is not this commit's hook.
  assert.deepEqual(
    preCommitHookRun(
      event({
        event: "child_start",
        sid: `${sid}/x`,
        child_id: 0,
        child_class: "hook",
        hook_name: "pre-commit",
      }),
    ),
    { ran: false },
  );
  // core.hooksPath set but no hook started: the commit ran no hook.
  assert.deepEqual(
    preCommitHookRun(
      event({
        event: "child_start",
        sid,
        child_id: 1,
        child_class: "?",
        argv: ["git", "maintenance"],
      }),
    ),
    { ran: false },
  );
  assert.deepEqual(preCommitHookRun(""), { ran: false });
});

test("the second dry run fails when a next-step command it prints does not work when pasted", async () => {
  const check = cliExperienceChecks.find(({ id }) => id === "second-dry-run-no-change");
  assert.ok(check);
  const root = await mkdtemp(join(scratch, "second-dry-run-"));
  const project = join(root, "project");
  await mkdir(project);
  await writeFile(join(project, "package.json"), "{}\n");
  for (const dir of ["projects", "tmp"]) await mkdir(join(root, dir));
  /** @type {string[]} */
  const pasted = [];
  const context = {
    dirs: { projects: join(root, "projects"), tmp: join(root, "tmp") },
    shared: new Map([["flow-apply", Promise.resolve({ project, planned: [], stateHash: "" })]]),
    run: async (/** @type {string} */ command, /** @type {string[]} */ args) => {
      const result = (/** @type {number} */ exitCode, /** @type {string} */ stdout) => ({
        exitCode,
        signal: null,
        timedOut: false,
        stdout,
        stderr: "",
        output: stdout,
        display: `${command} ${args.join(" ")}`,
      });
      if (command === "sh") {
        pasted.push(args[3] ?? "");
        return result(1, "pnpm: command broken");
      }
      if (args.includes("--json")) {
        return result(
          0,
          JSON.stringify({
            changes: [{ type: "unchanged", path: "package.json" }],
            autoInstalledArtifacts: [],
          }),
        );
      }
      return result(
        0,
        "Files:\n- package.json\nNothing to change.\nNext steps:\n  pnpm dlx create-project-calavera doctor\n",
      );
    },
    calavera: { bin: "create-project-calavera" },
  };
  await assert.rejects(check.run(context), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.match(
      error.expected,
      /the next-step command "pnpm dlx create-project-calavera doctor" to work when pasted/,
    );
    return true;
  });
  assert.deepEqual(pasted, ["pnpm dlx create-project-calavera doctor"]);
});

test("apply-summary-cache reports a git check-ignore error as an error, with its output", async () => {
  const check = cliExperienceChecks.find(({ id }) => id === "apply-summary-cache");
  assert.ok(check);
  const context = {
    shared: new Map([
      [
        "flow-apply",
        Promise.resolve({
          project: scratch,
          result: { output: "Cache: .calavera/cache is not committed.", display: "apply" },
        }),
      ],
    ]),
    run: async () => ({
      exitCode: 128,
      signal: null,
      timedOut: false,
      stdout: "",
      stderr: "fatal: not a git repository",
      output: "fatal: not a git repository",
      display: "git check-ignore --verbose --no-index .calavera/cache/npm/rehearsal-probe",
    }),
  };
  await assert.rejects(check.run(context), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.equal(error.expected, "git check-ignore to run");
    assert.match(error.actual, /exit code 128\nfatal: not a git repository/);
    return true;
  });
});

// ---------------------------------------------------------------------------------------------
// The eject checks (#1074): a stubbed CLI over a real project directory, so the footprint that
// remains is read by the same `footprintIn` the release candidate ships.

// The .gitignore holds an integration block eject keeps (ADR-0017 Decision 3) and the
// artifact-cache block it removes.
const GITIGNORE_KEPT =
  "node_modules\n# calavera:stylelint:start\n.stylelintcache\n# calavera:stylelint:end\n";
const GITIGNORE_BEFORE = `${GITIGNORE_KEPT}# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n`;

const EJECT_PLAN = [
  { kind: "state", path: ".calavera/state.json", matchesRecords: true },
  { kind: "cache", path: ".calavera/cache", matchesRecords: true },
  { kind: "lock", path: ".calavera/artifacts.lock.json", matchesRecords: true, keptRecord: true },
  { kind: "recipe", path: "calavera.config.json", matchesRecords: false },
  { kind: "package-folder", path: ".calavera/packages/skill-x/1.0.0", matchesRecords: false },
  { kind: "mcp-notes", path: ".agents/calavera/mcp.md", matchesRecords: true },
  {
    kind: "artifact-cache-block",
    path: ".gitignore",
    action: "edit",
    matchesRecords: true,
    contents: GITIGNORE_KEPT,
  },
];
const EJECT_REMOVES = EJECT_PLAN.filter((item) => item.matchesRecords && !item.keptRecord);
const EJECT_LEAVES = EJECT_PLAN.filter((item) => !EJECT_REMOVES.includes(item));

const ejectDryRunOutput = [
  "Dry run complete. Nothing was changed. eject would remove 7 items.",
  "",
  "Would remove:",
  ...EJECT_PLAN.map(({ path }) => `  ${path} (unedited)`),
].join("\n");
const ejectYesOutput = [
  "Removed 4 items; --yes left 2 items for an interactive approval.",
  "",
  "Removed:",
  ...EJECT_REMOVES.map(({ path }) => `  ${path} (unedited)`),
  "",
  "Left for an interactive run:",
  ...EJECT_LEAVES.map(({ path }) => `  ${path} (edits cannot be detected)`),
].join("\n");

/**
 * A copy of the flow project with a Calavera footprint, and a context whose CLI answers like
 * `eject` does. Each option breaks one thing the eject checks must notice.
 *
 * @param {{
 *   yesKeeps?: string[],
 *   extraFiles?: string[],
 *   dryRunOutput?: string,
 *   yesOutput?: string,
 *   dryRunWrites?: string[],
 *   failing?: string,
 *   exitCodes?: Record<string, number>,
 *   extraDirectories?: string[],
 *   plan?: typeof EJECT_PLAN,
 *   reported?: string[],
 *   commitFails?: boolean,
 *   secondRun?: Record<string, unknown>,
 *   kept?: string[],
 *   yesDeletes?: string[],
 *   yesWrites?: Record<string, string>,
 *   yesModes?: Record<string, number>,
 *   omit?: string[],
 * }} [options]
 */
async function ejectFixture(options = {}) {
  const root = await mkdtemp(join(scratch, "eject-"));
  const source = join(root, "source");
  for (const dir of ["projects", "tmp"]) await mkdir(join(root, dir));
  const files = {
    "package.json": JSON.stringify({ scripts: { build: "vp pack", quality: "vp check" } }),
    ".calavera/state.json": "{}\n",
    ".calavera/cache/npm/entry": "cached\n",
    ".calavera/artifacts.lock.json": "{}\n",
    ".calavera/packages/skill-x/1.0.0/package.json": "{}\n",
    ".calavera/packages/skill-x/1.0.0/payload/SKILL.md": "# Skill\n",
    "calavera.config.json": "{}\n",
    ".agents/calavera/mcp.md": "# MCP\n",
    ".gitignore": GITIGNORE_BEFORE,
    // Outside the footprint: a managed file and a kept AI artifact (ADR-0017 Decision 3).
    "docs/repository-controls.md": "# Repository controls\n",
    ".agents/skills/release/SKILL.md": "# Release\n",
    ".vite-hooks/pre-commit": "#!/bin/sh\nvp check\n",
  };
  for (const path of [...Object.keys(files), ...(options.extraFiles ?? [])].filter(
    (path) => !(options.omit ?? []).includes(path),
  )) {
    await mkdir(join(source, path, ".."), { recursive: true });
    await writeFile(join(source, path), files[/** @type {keyof typeof files} */ (path)] ?? "x\n");
  }
  await chmod(join(source, ".vite-hooks/pre-commit"), 0o755);
  for (const path of options.extraDirectories ?? [])
    await mkdir(join(source, path), { recursive: true });
  const plan = options.plan ?? EJECT_PLAN;
  /** @type {string[]} */
  const calls = [];
  /** @type {Array<{ cwd: string, timeout?: number }>} */
  const pnpmOptions = [];
  const result = (
    /** @type {string} */ display,
    /** @type {number} */ exitCode,
    /** @type {string} */ stdout,
  ) => ({ exitCode, signal: null, timedOut: false, stdout, stderr: "", output: stdout, display });
  const context = {
    dirs: { projects: join(root, "projects"), tmp: join(root, "tmp") },
    shared: new Map([
      [
        "flow-commit",
        options.commitFails ? Promise.reject(new Error("commit failed")) : Promise.resolve(source),
      ],
      ["flow-apply", Promise.resolve({ project: source })],
      ["flow-init", Promise.resolve({ scaffoldScripts: ["build"] })],
    ]),
    calavera: {
      bin: "create-project-calavera",
      packageDirectory: fileURLToPath(new URL("../packages/cli", import.meta.url)),
    },
    run: async (
      /** @type {string} */ command,
      /** @type {string[]} */ args,
      /** @type {{ cwd: string, timeout?: number }} */ { cwd, timeout },
    ) => {
      const display = `${command} ${args.join(" ")}`;
      calls.push(display);
      // Every command runs in the copy, never in the project the other checks share.
      if (cwd !== join(root, "projects", "eject")) return result(display, 126, `ran in ${cwd}`);
      const exitCode = options.exitCodes?.[args.join(" ")] ?? 0;
      if (command === "pnpm") {
        pnpmOptions.push({ cwd, timeout });
        return result(display, display.endsWith(options.failing ?? "\0") ? 1 : 0, "ran");
      }
      if (args.join(" ") === "eject --dry-run --json") {
        const report = {
          status: "dry-run",
          items: plan,
          reported: (options.reported ?? []).map((path) => ({ path, reason: "edited" })),
          kept: options.kept ?? [],
        };
        return result(display, exitCode, JSON.stringify(report));
      }
      if (args.join(" ") === "eject --dry-run") {
        for (const path of options.dryRunWrites ?? [])
          await writeFile(join(cwd, path), "changed\n");
        return result(display, exitCode, options.dryRunOutput ?? ejectDryRunOutput);
      }
      if (args.join(" ") === "eject --yes") {
        for (const item of plan.filter(
          ({ matchesRecords, keptRecord }) => matchesRecords && !keptRecord,
        )) {
          if ((options.yesKeeps ?? []).includes(item.path)) continue;
          if (item.action === "edit") await writeFile(join(cwd, item.path), item.contents ?? "");
          else await rm(join(cwd, item.path), { recursive: true, force: true });
        }
        // Like eject, remove a Calavera folder its last item leaves empty.
        await rmdir(join(cwd, ".agents/calavera")).catch(() => {});
        for (const path of options.yesDeletes ?? []) {
          await rm(join(cwd, path), { recursive: true, force: true });
        }
        for (const [path, text] of Object.entries(options.yesWrites ?? {})) {
          await writeFile(join(cwd, path), text);
        }
        for (const [path, mode] of Object.entries(options.yesModes ?? {})) {
          await chmod(join(cwd, path), mode);
        }
        return result(display, exitCode, options.yesOutput ?? ejectYesOutput);
      }
      if (args.join(" ") === "eject --yes --json") {
        const report = options.secondRun ?? {
          status: "ejected",
          items: EJECT_LEAVES.map((item) => ({ ...item, outcome: "left" })),
          reported: [],
          kept: [],
        };
        return result(display, exitCode, JSON.stringify(report));
      }
      return result(display, 127, `unexpected command ${display}`);
    },
  };
  return { context, calls, pnpmOptions, source };
}

/** @param {string} id */
function ejectCheck(id) {
  const check = cliExperienceChecks.find((candidate) => candidate.id === id);
  assert.ok(check, `no check ${id}`);
  return check;
}

/** @param {Promise<unknown>} promise @param {RegExp} expected @param {RegExp} actual */
async function assertCheckFails(promise, expected, actual) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof CheckFailure, String(error));
    assert.match(error.expected, expected);
    assert.match(error.actual, actual);
    return true;
  });
}

const EJECT_CHECK_IDS = [
  "eject-dry-run-output",
  "eject-yes-footprint",
  "eject-keeps-toolchain",
  "eject-second-run",
];

test("the eject checks pass when eject leaves only what ADR-0017 keeps and the toolchain runs (#1074)", async () => {
  const { context, calls, pnpmOptions, source } = await ejectFixture();
  for (const id of EJECT_CHECK_IDS) await ejectCheck(id).run(context);
  // vp check and the scripts run in the ejected copy, with the five-minute limit the pasted
  // next-step commands get.
  assert.deepEqual(pnpmOptions, [
    { cwd: join(context.dirs.projects, "eject"), timeout: 5 * 60_000 },
    { cwd: join(context.dirs.projects, "eject"), timeout: 5 * 60_000 },
  ]);
  assert.deepEqual(calls, [
    "create-project-calavera eject --dry-run --json",
    "create-project-calavera eject --dry-run",
    "create-project-calavera eject --yes",
    "pnpm exec vp check",
    "pnpm run quality",
    "create-project-calavera eject --yes --json",
  ]);
  // eject runs on a copy, so it cannot change the project the other checks share.
  assert.ok(existsSync(join(source, ".calavera/state.json")));
});

test("the eject checks fail when a footprint item remains that --yes must remove (#1074)", async () => {
  const kept = await ejectFixture({ yesKeeps: [".agents/calavera/mcp.md"] });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(kept.context),
    /only the footprint ADR-0017 keeps/,
    /^\.agents\/calavera\/mcp\.md$/m,
  );
  // A package folder the plan never named counts too, although its parent folder may stay.
  const extra = await ejectFixture({ extraFiles: [".calavera/packages/other/2.0.0/package.json"] });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(extra.context),
    /only the footprint ADR-0017 keeps/,
    /^\.calavera\/packages\/other\/2\.0\.0\/package\.json$/m,
  );
  // A file in Calavera's folders that eject does not name is a footprint eject does not know.
  const unknown = await ejectFixture({ kept: [".calavera/new-record.json"] });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(unknown.context),
    /eject to name every file in Calavera's folders/,
    /\.calavera\/new-record\.json/,
  );
});

test("the eject checks fail when eject prints an item twice or the dry run changes the project (#1074)", async () => {
  const twice = await ejectFixture({
    dryRunOutput: `${ejectDryRunOutput}\n  calavera.config.json (again)`,
  });
  await assertCheckFails(
    ejectCheck("eject-dry-run-output").run(twice.context),
    /printed once, under a heading/,
    /calavera\.config\.json is printed 2 times/,
  );
  const yesTwice = await ejectFixture({
    yesOutput: `${ejectYesOutput}\n  .calavera/state.json (again)`,
  });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(yesTwice.context),
    /printed once, under a heading/,
    /\.calavera\/state\.json is printed 2 times/,
  );
  const writes = await ejectFixture({ dryRunWrites: ["calavera.config.json", "package.json"] });
  await assertCheckFails(
    ejectCheck("eject-dry-run-output").run(writes.context),
    /a dry run to leave the project unchanged/,
    /^changed: (calavera\.config\.json, package\.json|package\.json, calavera\.config\.json)$/,
  );
});

test("the eject checks fail when vp check or a generated script fails after eject (#1074)", async () => {
  const check = await ejectFixture({ failing: "exec vp check" });
  await assertCheckFails(
    ejectCheck("eject-keeps-toolchain").run(check.context),
    /^pnpm exec vp check to exit 0 after eject --yes$/,
    /exit code 1/,
  );
  const script = await ejectFixture({ failing: "run quality" });
  await assertCheckFails(
    ejectCheck("eject-keeps-toolchain").run(script.context),
    /^pnpm run quality to exit 0 after eject --yes$/,
    /exit code 1/,
  );
  // Only the scripts Calavera added run: the scaffold's own `build` is not Calavera's to prove.
  assert.ok(!script.calls.includes("pnpm run build"));
});

test("a second eject passes with nothing to do, and fails when it removes or leaves something new (#1074)", async () => {
  const nothingToDo = { status: "nothing-to-do", items: [], reported: [], kept: [] };
  // Nothing to do is right only when the first run left nothing.
  const done = await ejectFixture({
    plan: EJECT_PLAN.map((item) => ({ ...item, matchesRecords: true, keptRecord: undefined })),
    secondRun: nothingToDo,
  });
  await ejectCheck("eject-second-run").run(done.context);
  // Otherwise --yes removed the recipe, a package folder, or a record it had to leave.
  const overRemoved = await ejectFixture({ secondRun: nothingToDo });
  await assertCheckFails(
    ejectCheck("eject-second-run").run(overRemoved.context),
    /a second eject to have nothing to remove/,
    /^status nothing-to-do:\n\.calavera\/artifacts\.lock\.json \(not listed\)\ncalavera\.config\.json \(not listed\)/,
  );
  const removes = await ejectFixture({
    secondRun: {
      status: "ejected",
      items: [
        ...EJECT_LEAVES.map((item) => ({ ...item, outcome: "left" })),
        { ...EJECT_REMOVES[0], outcome: "removed" },
      ],
      reported: [],
      kept: [],
    },
  });
  await assertCheckFails(
    ejectCheck("eject-second-run").run(removes.context),
    /a second eject to have nothing to remove/,
    /\.calavera\/state\.json \(removed\)/,
  );
  const differs = await ejectFixture({
    secondRun: {
      status: "ejected",
      items: [{ ...EJECT_PLAN.find(({ kind }) => kind === "recipe"), outcome: "left" }],
      reported: [],
      kept: [],
    },
  });
  await assertCheckFails(
    ejectCheck("eject-second-run").run(differs.context),
    /a second eject to have nothing to remove/,
    /\.calavera\/artifacts\.lock\.json \(not listed\)/,
  );
});

test("the eject checks name exactly what remains, and allow what eject keeps and reports (#1074)", async () => {
  const { context } = await ejectFixture({
    yesKeeps: [".calavera/state.json", ".agents/calavera/mcp.md"],
  });
  await assert.rejects(ejectCheck("eject-yes-footprint").run(context), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.equal(
      error.expected,
      "only the footprint ADR-0017 keeps after --yes: .calavera/artifacts.lock.json, calavera.config.json, .calavera/packages/skill-x/1.0.0",
    );
    assert.equal(
      error.actual,
      "still in the project:\n.calavera/state.json\n.agents/calavera/mcp.md",
    );
    return true;
  });
  // Footprint text eject keeps and reports may stay.
  const reported = await ejectFixture({
    yesKeeps: [".agents/calavera/mcp.md"],
    reported: [".agents/calavera/mcp.md"],
  });
  await ejectCheck("eject-yes-footprint").run(reported.context);
  // An empty folder in the footprint still counts.
  const empty = await ejectFixture({ extraDirectories: [".calavera/.staging"] });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(empty.context),
    /only the footprint ADR-0017 keeps/,
    /^\.calavera\/\.staging$/m,
  );
  // Only the recipe and package folders may stay unmatched: any other item --yes leaves means
  // eject took Calavera's own text for an edit in a project nobody edited.
  const misread = await ejectFixture({
    plan: EJECT_PLAN.map((item) =>
      item.kind === "mcp-notes" ? { ...item, matchesRecords: false } : item,
    ),
    yesKeeps: [".agents/calavera/mcp.md"],
  });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(misread.context),
    /only the footprint ADR-0017 keeps/,
    /^\.agents\/calavera\/mcp\.md$/m,
  );
  const unknown = await ejectFixture({ kept: [".calavera/a.json", ".calavera/b.json"] });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(unknown.context),
    /eject to name every file/,
    /: \.calavera\/a\.json, \.calavera\/b\.json$/,
  );
});

test("each eject check fails when the eject run it reads exits with an error (#1074)", async () => {
  for (const [args, ids] of /** @type {Array<[string, string[]]>} */ ([
    ["eject --dry-run --json", EJECT_CHECK_IDS.filter((id) => id !== "eject-keeps-toolchain")],
    ["eject --dry-run", ["eject-dry-run-output"]],
    ["eject --yes", ["eject-yes-footprint", "eject-keeps-toolchain", "eject-second-run"]],
    ["eject --yes --json", ["eject-second-run"]],
  ])) {
    for (const id of ids) {
      const { context } = await ejectFixture({ exitCodes: { [args]: 1 } });
      await assertCheckFails(ejectCheck(id).run(context), /^exit code 0$/, /exit code 1/);
    }
  }
});

test("the eject checks use the applied project when the commit failed (#1074)", async () => {
  const { context } = await ejectFixture({ commitFails: true });
  for (const id of EJECT_CHECK_IDS) await ejectCheck(id).run(context);
});

test("a second eject fails when it removes or fails an item the first run left (#1074)", async () => {
  const { context } = await ejectFixture({
    secondRun: {
      status: "failed",
      items: EJECT_LEAVES.map((item, index) => ({
        ...item,
        outcome: index === 0 ? "failed" : "left",
      })),
    },
  });
  await assert.rejects(ejectCheck("eject-second-run").run(context), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.equal(
      error.expected,
      "a second eject to have nothing to remove, and to list only what the first left: .calavera/artifacts.lock.json, calavera.config.json, .calavera/packages/skill-x/1.0.0",
    );
    assert.equal(error.actual, "status failed:\n.calavera/artifacts.lock.json (failed)");
    return true;
  });
  const two = await ejectFixture({
    secondRun: { status: "ejected", items: [] },
  });
  await assertCheckFails(
    ejectCheck("eject-second-run").run(two.context),
    /nothing to remove/,
    /\(not listed\)\n.*\(not listed\)\n.*\(not listed\)$/,
  );
});

test("the footprint check reads footprintIn from the release candidate's own eject.js (#1074)", async () => {
  const { context } = await ejectFixture();
  const candidate = await mkdtemp(join(scratch, "candidate-"));
  await mkdir(join(candidate, "src"));
  await writeFile(
    join(candidate, "src", "eject.js"),
    'export async function footprintIn() { return ["candidate-only.json"]; }\n',
  );
  await writeFile(join(context.dirs.projects, "..", "source", "candidate-only.json"), "{}\n");
  context.calavera.packageDirectory = candidate;
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(context),
    /only the footprint ADR-0017 keeps/,
    /^candidate-only\.json$/m,
  );
});

test("eject-yes-footprint fails when --yes deletes or edits anything its plan does not name (#1074)", async () => {
  const deletes = await ejectFixture({
    yesDeletes: ["docs/repository-controls.md", ".agents/skills/release"],
  });
  await assert.rejects(ejectCheck("eject-yes-footprint").run(deletes.context), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.equal(
      error.expected,
      "eject --yes to change only the items its dry run planned, and each planned edit to leave the text the dry run showed (ADR-0017 Decisions 2 and 3)",
    );
    assert.equal(
      error.actual,
      [
        "changed outside the plan:",
        ".agents/skills/release/ (removed)",
        ".agents/skills/release/SKILL.md (removed)",
        "docs/repository-controls.md (removed)",
      ].join("\n"),
    );
    assert.equal(error.command, "create-project-calavera eject --yes");
    return true;
  });
  // A folder that held a planned file and one eject does not name is not Calavera's to remove.
  const folder = await ejectFixture({
    extraFiles: [".agents/calavera/notes.md"],
    yesDeletes: [".agents/calavera"],
  });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(folder.context),
    /change only the items its dry run planned/,
    /^changed outside the plan:\n\.agents\/calavera\/ \(removed\)\n\.agents\/calavera\/notes\.md \(removed\)$/,
  );
  // A planned edit that also removes the integration block eject keeps.
  const overEdit = await ejectFixture({ yesWrites: { ".gitignore": "node_modules\n" } });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(overEdit.context),
    /each planned edit to leave the text the dry run showed/,
    /^\.gitignore \(not the text the dry run planned\)$/,
  );
  // An edit --yes leaves for an interactive run must leave the file as it was.
  const leftEdit = await ejectFixture({
    plan: EJECT_PLAN.map((item) =>
      item.kind === "artifact-cache-block" ? { ...item, keptRecord: true } : item,
    ),
  });
  await ejectCheck("eject-yes-footprint").run(leftEdit.context);
  const leftEditWritten = await ejectFixture({
    plan: EJECT_PLAN.map((item) =>
      item.kind === "artifact-cache-block" ? { ...item, keptRecord: true } : item,
    ),
    yesWrites: { ".gitignore": GITIGNORE_KEPT },
  });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(leftEditWritten.context),
    /each planned edit/,
    /^\.gitignore \(changed, although --yes leaves it\)$/,
  );
  // An MCP entry's text afterward stays out of the JSON (ADR-0017, Amendment 3), so only the
  // path rule covers it.
  const mcpEntry = await ejectFixture({
    plan: [
      ...EJECT_PLAN,
      { kind: "mcp-entry", path: ".mcp.json", action: "edit", matchesRecords: true },
    ],
    extraFiles: [".mcp.json"],
    yesOutput: `${ejectYesOutput}\n  .mcp.json (unedited)`,
    dryRunOutput: `${ejectDryRunOutput}\n  .mcp.json (unedited)`,
  });
  await ejectCheck("eject-yes-footprint").run(mcpEntry.context);
  // So does a file outside the plan that --yes rewrites.
  const rewrites = await ejectFixture({ yesWrites: { "docs/repository-controls.md": "gone\n" } });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(rewrites.context),
    /change only the items its dry run planned/,
    /^docs\/repository-controls\.md \(changed\)$/m,
  );
  // A new file outside the plan counts too.
  const adds = await ejectFixture({ yesWrites: { "notes.md": "new\n" } });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(adds.context),
    /change only the items its dry run planned/,
    /^notes\.md \(added\)$/m,
  );
});

test("eject-yes-footprint fails when --yes changes anything it must leave (#1074)", async () => {
  const cases = /** @type {Array<[Parameters<typeof ejectFixture>[0], string]>} */ ([
    [
      { yesDeletes: [".calavera/packages/skill-x/1.0.0/payload/SKILL.md"] },
      ".calavera/packages/skill-x/1.0.0/payload/SKILL.md (removed, although --yes leaves .calavera/packages/skill-x/1.0.0)",
    ],
    [
      { yesWrites: { ".calavera/artifacts.lock.json": '{"rewritten":true}\n' } },
      ".calavera/artifacts.lock.json (changed, although --yes leaves it)",
    ],
    [
      { yesWrites: { "calavera.config.json": '{"rewritten":true}\n' } },
      "calavera.config.json (changed, although --yes leaves it)",
    ],
  ]);
  for (const [options, line] of cases) {
    const { context } = await ejectFixture(options);
    await assert.rejects(ejectCheck("eject-yes-footprint").run(context), (error) => {
      assert.ok(error instanceof CheckFailure);
      assert.match(error.expected, /change only the items its dry run planned/);
      assert.equal(error.actual, line);
      return true;
    });
  }
});

test("eject-yes-footprint notices a file that loses its executable bit (#1074)", async () => {
  const { context } = await ejectFixture({ yesModes: { ".vite-hooks/pre-commit": 0o644 } });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(context),
    /change only the items its dry run planned/,
    /^changed outside the plan:\n\.vite-hooks\/pre-commit \(changed\)$/,
  );
});

test("eject-yes-footprint allows an empty removed folder only in Calavera's own folders (#1074)", async () => {
  const outside = await ejectFixture({
    extraDirectories: ["src/empty"],
    yesDeletes: ["src/empty"],
  });
  await assertCheckFails(
    ejectCheck("eject-yes-footprint").run(outside.context),
    /change only the items its dry run planned/,
    /^changed outside the plan:\nsrc\/empty\/ \(removed\)$/,
  );
  const inside = await ejectFixture({
    extraDirectories: [".calavera/.staging"],
    yesDeletes: [".calavera/.staging"],
  });
  await ejectCheck("eject-yes-footprint").run(inside.context);
  // eject also removes an empty .agents/calavera folder.
  const agents = await ejectFixture({
    omit: [".agents/calavera/mcp.md"],
    extraDirectories: [".agents/calavera"],
  });
  await ejectCheck("eject-yes-footprint").run(agents.context);
});

/**
 * A stand-in for Yarn's `.pnp.cjs`: loaded with `--require`, it makes `require("pnpapi")` return
 * an API whose `resolveToUnqualified` maps `vite-plus/package.json` to a file outside any
 * node_modules folder, as Yarn's maps it into a zip archive in its cache.
 *
 * @param {string} project
 * @param {string} version
 * @param {string} [manifest] the manifest's text, when it is not a valid one for `version`
 */
async function writePnpProject(
  project,
  version,
  manifest = JSON.stringify({ name: "vite-plus", version }),
) {
  const store = join(project, ".yarn", "unplugged", "vite-plus");
  await mkdir(store, { recursive: true });
  await writeFile(join(store, "package.json"), manifest);
  await writeFile(
    join(project, ".pnp.cjs"),
    `const Module = require("node:module");
const { join } = require("node:path");
const api = {
  resolveToUnqualified(request, issuer) {
    if (request !== "vite-plus/package.json") throw new Error("not a dependency: " + request);
    if (issuer !== ${JSON.stringify(`${await realpath(project)}/`)}) throw new Error("the issuer must be the project's real path");
    return join(${JSON.stringify(store)}, "package.json");
  },
};
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "pnpapi" ? __filename : resolve.call(this, request, ...rest);
};
module.exports = api;
`,
  );
}

/** @param {string} project @param {string} version */
async function writeNodeModulesProject(project, version) {
  const directory = join(project, "node_modules", "vite-plus");
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "package.json"), JSON.stringify({ name: "vite-plus", version }));
}

/**
 * A context for one --new check: the launcher "scaffolds" with `layout`, prints the runner it
 * implies, and the registry log shows the release candidate's tarball. Node.js runs for real, so
 * the Plug'n'Play read goes through `.pnp.cjs`. The MCP server does not exist, so a check that
 * gets past the version reaches `inspect_project` and fails there. The projects folder is a
 * symbolic link.
 *
 * @param {string} runner
 * @param {(project: string) => Promise<void>} layout
 */
async function newCheckContext(runner, layout) {
  const root = await mkdtemp(join(scratch, "new-check-"));
  // Reached through a symbolic link, as the macOS temporary folder is, so a Plug'n'Play read that
  // passes Yarn a path that is not the real one fails here on every platform.
  await mkdir(join(root, "real-projects"));
  await symlink(join(root, "real-projects"), join(root, "projects"));
  /** @type {string[]} */
  const requests = [];
  return {
    dirs: { projects: join(root, "projects") },
    env: process.env,
    vitePlusVersion: "1.6.0",
    versions: {},
    registry: { url: "http://127.0.0.1:0", requests },
    calavera: { version: "9.9.9", mcpBin: join(root, "missing-mcp") },
    recordEnvironment: () => {},
    freshEnvironment: async () => process.env,
    run: async (
      /** @type {string} */ command,
      /** @type {string[]} */ args,
      /** @type {{ cwd?: string }} */ options = {},
    ) => {
      const display = formatCommand(command, args, options.cwd ?? root);
      if (command === "node") {
        const child = spawnSync(command, args, { cwd: options.cwd, encoding: "utf8" });
        return {
          exitCode: child.status,
          signal: child.signal,
          timedOut: false,
          stdout: child.stdout,
          stderr: child.stderr,
          output: `${child.stdout}${child.stderr}`,
          display,
        };
      }
      await layout(join(options.cwd ?? root, "app"));
      requests.push("/create-project-calavera/-/create-project-calavera-9.9.9.tgz");
      const stdout = `Command: ${runner} create-vite-plus@latest vite:library\n`;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout,
        stderr: "",
        output: stdout,
        display,
      };
    },
  };
}

/** The --new check for `id`, with the runner line its launcher prints. */
const newChecks = [
  ["new-npm", "npm exec --"],
  ["new-pnpm", "pnpm dlx"],
  ["new-yarn", "yarn dlx"],
  ["new-bun", "bunx"],
  ["new-npx-package", "npx"],
];

test("every --new check fails when the launcher installed another Vite+ than the run's (#1090)", async () => {
  for (const [id, runner] of newChecks) {
    const check = cliExperienceChecks.find((candidate) => candidate.id === id);
    assert.ok(check, id);
    const context = await newCheckContext(runner, (project) =>
      writeNodeModulesProject(project, "1.5.0"),
    );
    await assert.rejects(check.run(context), (error) => {
      assert.ok(error instanceof CheckFailure, id);
      assert.match(error.expected, /to install Vite\+ 1\.6\.0/, id);
      assert.match(error.actual, /installed 1\.5\.0/, id);
      return true;
    });
  }
});

test("a --new check gets past the Vite+ version when the launcher installed the run's (#1090)", async () => {
  for (const [id, runner] of newChecks) {
    const check = cliExperienceChecks.find((candidate) => candidate.id === id);
    assert.ok(check, id);
    const context = await newCheckContext(runner, (project) =>
      writeNodeModulesProject(project, "1.6.0"),
    );
    // The missing MCP server is the next step, so the version check passed.
    await assert.rejects(check.run(context), /the MCP server to start/, id);
  }
});

test("the Yarn --new check reads the Vite+ version through Plug'n'Play, with no node_modules (#1090)", async () => {
  const check = cliExperienceChecks.find((candidate) => candidate.id === "new-yarn");
  assert.ok(check);
  const heldBack = await newCheckContext("yarn dlx", (project) =>
    writePnpProject(project, "1.5.0"),
  );
  await assert.rejects(check.run(heldBack), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.match(error.actual, /installed 1\.5\.0/);
    return true;
  });
  const current = await newCheckContext("yarn dlx", (project) => writePnpProject(project, "1.6.0"));
  await assert.rejects(check.run(current), /the MCP server to start/);
});

test("a --new check names a project without Vite+ and a Plug'n'Play project that cannot resolve it (#1090)", async () => {
  const check = cliExperienceChecks.find((candidate) => candidate.id === "new-yarn");
  assert.ok(check);
  const empty = await newCheckContext("yarn dlx", (project) => mkdir(project, { recursive: true }));
  await assert.rejects(check.run(empty), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.match(
      error.actual,
      /it installed nothing: there is no node_modules\/vite-plus\/package\.json and no \.pnp\.cjs/,
    );
    return true;
  });
  const broken = await newCheckContext("yarn dlx", async (project) => {
    await mkdir(project, { recursive: true });
    // A runtime that prints before it fails: its output is not a version.
    await writeFile(
      join(project, ".pnp.cjs"),
      'process.stdout.write("1.6.0");\nthrow new Error("broken runtime");\n',
    );
  });
  await assert.rejects(check.run(broken), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.match(error.actual, /\.pnp\.cjs/);
    assert.match(error.actual, /exit code 1/);
    // A short label, not the script: the .pnp.cjs path and what was read.
    assert.match(error.actual, /app\/\.pnp\.cjs reading vite-plus\/package\.json/);
    assert.doesNotMatch(error.actual, /--eval|pnpapi/);
    // The runtime's own output is not copied, because it can quote the files it read.
    assert.doesNotMatch(error.actual, /broken runtime/);
    assert.match(error.actual, /the Plug'n'Play read ended without a version/);
    return true;
  });
  const corrupt = await newCheckContext("yarn dlx", async (project) => {
    await mkdir(join(project, "node_modules", "vite-plus"), { recursive: true });
    await writeFile(join(project, "node_modules", "vite-plus", "package.json"), "{ not json");
  });
  await assert.rejects(check.run(corrupt), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.match(error.actual, /package\.json that is not valid JSON/);
    return true;
  });
});

test("the flow project records the Vite+ it installed and fails when it is not the run's (#1090)", async () => {
  const check = cliExperienceChecks.find(({ id }) => id === "init-output");
  assert.ok(check);
  for (const [layout, recorded] of [
    [(/** @type {string} */ project) => writeNodeModulesProject(project, "1.5.0"), "1.5.0"],
    [(/** @type {string} */ project) => mkdir(project, { recursive: true }), "not installed"],
  ]) {
    const root = await mkdtemp(join(scratch, "flow-version-"));
    await mkdir(join(root, "projects"));
    /** @type {Record<string, string>} */
    const recordedVersions = {};
    const context = {
      dirs: { projects: join(root, "projects") },
      vitePlusVersion: "1.6.0",
      versions: recordedVersions,
      runOrThrow: async (
        /** @type {string} */ _command,
        /** @type {string[]} */ _args,
        /** @type {{ cwd: string }} */ { cwd },
      ) => {
        await layout(join(cwd, "app"));
      },
    };
    await assert.rejects(check.run(context), (error) => {
      assert.ok(error instanceof CheckFailure);
      assert.match(error.expected, /the flow project to install Vite\+ 1\.6\.0/);
      assert.match(error.command, /pnpm create vite-plus vite:library/);
      return true;
    });
    assert.equal(recordedVersions["Vite+ installed in the flow project"], recorded);
  }
});

test("a Plug'n'Play read that prints more than a version is reported without that output (#1090)", async () => {
  const check = cliExperienceChecks.find((candidate) => candidate.id === "new-yarn");
  assert.ok(check);
  const context = await newCheckContext("yarn dlx", async (project) => {
    await writePnpProject(project, "1.6.0");
    const pnp = join(project, ".pnp.cjs");
    await writeFile(pnp, `process.stdout.write("RUNTIME-NOISE ");\n${await readFile(pnp, "utf8")}`);
  });
  await assert.rejects(check.run(context), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.match(error.actual, /printed something other than a version/);
    assert.doesNotMatch(`${error.actual}\n${error.message}`, /RUNTIME-NOISE/);
    return true;
  });
});

test("a corrupt manifest behind Plug'n'Play is reported without its text (#1090)", async () => {
  const check = cliExperienceChecks.find(({ id }) => id === "new-yarn");
  assert.ok(check);
  const context = await newCheckContext("yarn dlx", (project) =>
    writePnpProject(project, "1.6.0", '{\n  "token": "SECRET-TEXT-HERE" oops\n}\n'),
  );
  await assert.rejects(check.run(context), (error) => {
    assert.ok(error instanceof CheckFailure);
    assert.match(error.actual, /vite-plus\/package\.json that is not valid JSON/);
    assert.doesNotMatch(error.actual, /SECRET-TEXT-HERE/);
    assert.doesNotMatch(error.message, /SECRET-TEXT-HERE/);
    return true;
  });
});

test("a manifest without a string version is its own failure, not an installed undefined (#1090)", async () => {
  const check = cliExperienceChecks.find(({ id }) => id === "new-yarn");
  assert.ok(check);
  const manifests = [
    JSON.stringify({ name: "vite-plus", version: "" }),
    JSON.stringify({ name: "vite-plus" }),
    JSON.stringify({ name: "vite-plus", version: 16 }),
  ];
  for (const manifest of manifests) {
    const layouts = [
      (/** @type {string} */ project) => writePnpProject(project, "1.6.0", manifest),
      async (/** @type {string} */ project) => {
        await mkdir(join(project, "node_modules", "vite-plus"), { recursive: true });
        await writeFile(join(project, "node_modules", "vite-plus", "package.json"), manifest);
      },
    ];
    for (const layout of layouts) {
      const context = await newCheckContext("yarn dlx", layout);
      await assert.rejects(check.run(context), (error) => {
        assert.ok(error instanceof CheckFailure);
        assert.match(error.actual, /vite-plus\/package\.json that names no version/, manifest);
        assert.doesNotMatch(error.actual, /undefined|installed 16/, manifest);
        return true;
      });
    }
  }
});

test("a Plug'n'Play read names why Yarn's runtime found no manifest it could read (#1090)", async () => {
  const check = cliExperienceChecks.find(({ id }) => id === "new-yarn");
  assert.ok(check);
  const cases = [
    // pnpapi throws, as Yarn's does for a package the project does not depend on.
    [
      'throw new Error("vite-plus is not a dependency");',
      /no vite-plus that Yarn's runtime resolves/,
      64,
    ],
    // pnpapi resolves a path where no file is.
    [
      'return require("node:path").join(__dirname, "missing", "package.json");',
      /vite-plus\/package\.json that cannot be read/,
      65,
    ],
  ];
  for (const [body, reason, code] of cases) {
    const context = await newCheckContext("yarn dlx", async (project) => {
      await mkdir(project, { recursive: true });
      await writeFile(
        join(project, ".pnp.cjs"),
        `const Module = require("node:module");
const resolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  return request === "pnpapi" ? __filename : resolve.call(this, request, ...rest);
};
module.exports = { resolveToUnqualified() { ${body} } };
`,
      );
    });
    await assert.rejects(check.run(context), (error) => {
      assert.ok(error instanceof CheckFailure);
      assert.match(error.actual, reason);
      assert.match(error.actual, new RegExp(`exit code ${code}\\)$`));
      assert.doesNotMatch(error.actual, /not a dependency/);
      return true;
    });
  }
});
