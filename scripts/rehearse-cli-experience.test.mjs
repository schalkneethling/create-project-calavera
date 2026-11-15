// Unit tests for the cli-experience rehearsal's own logic (#918), with stubbed checks and setup.
// The rehearsal itself needs network access and takes minutes, so it runs only through
// `pnpm release:rehearse:cli` and its workflow, never in `pnpm quality`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildEnvironment,
  compareRuns,
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
