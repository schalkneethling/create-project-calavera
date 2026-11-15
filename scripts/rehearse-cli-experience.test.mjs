// Unit tests for the cli-experience rehearsal's own logic (#918), with stubbed checks and setup.
// The rehearsal itself needs network access and takes minutes, so it runs only through
// `pnpm release:rehearse:cli` and its workflow, never in `pnpm quality`.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import {
  buildEnvironment,
  compareRuns,
  formatReport,
  parseOptions,
  runDirectories,
  runRehearsal,
  watchDeveloperState,
} from "./rehearse-cli-experience.mjs";
import {
  cliExperienceChecks,
  countMentions,
  isHeading,
  listingViolations,
  namedItems,
  nextStepCommands,
  pastedCommandWorked,
  tapCounts,
} from "./rehearsal-checks.mjs";
import { CheckFailure } from "./rehearsal-failure.mjs";
import {
  localPackument,
  parseRegistryPath,
  pinPackument,
  startRegistry,
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
      ["harness-developer-state", "pass"],
    ],
  );
  const failure = report.results.find(({ id }) => id === "fails");
  assert.equal(failure?.expected, "exit code 0");
  assert.equal(failure?.actual, "exit code 1");
  assert.equal(failure?.command, "(cd <run> && false)");
});

test("a run passes only when every check passes", async () => {
  const report = await runRehearsal({
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

test("a run fails its developer-state check when a check writes below the developer's HOME", async () => {
  const home = await fakeHome();
  const report = await runRehearsal({
    mode: "pinned",
    pins: {},
    tmpRoot: scratch,
    developerHome: home,
    prepare: async (_dirs, options) => (Object.assign(options.versions, versions), {}),
    checks: [stubCheck("writes-npmrc", () => writeFile(join(home, ".npmrc"), "registry=x\n"))],
  });
  const state = report.results.find(({ id }) => id === "harness-developer-state");
  assert.equal(state?.status, "fail");
  assert.equal(state?.actual, "changed: ~/.npmrc", "the developer's home is not printed");
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
