// Issue #1204 (ADR-0022, Decision 6): when OpenCode is the MCP host, `--init` runs the `opencode` on
// PATH once with `--version`, before it writes `opencode.json`, and warns when it is older than
// OpenCode 2. The check only informs: it never blocks or changes the write, and a missing, failing,
// or unreadable `opencode` is not an error. These tests put a stub `opencode`, a Node script, in a
// new folder on PATH, as check-config-schema.test.mjs does for `npm`. The stub tests run on POSIX
// systems only, because on Windows the check looks for `opencode.exe`, which a script cannot be.
import assert from "node:assert/strict";
import { execFile, spawn as spawnProcess } from "node:child_process";
import {
  access,
  chmod,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { listingViolations } from "../../../scripts/rehearsal-checks.mjs";
import { agentBootstrap } from "../src/index.js";
import {
  checkOpenCodeVersion,
  findOpenCode,
  parseOpenCodeVersion,
} from "../src/utils/opencode-version.js";

const binPath = fileURLToPath(new URL("../bin/create-project-calavera.js", import.meta.url));
const posix = { skip: process.platform === "win32" ? "the stub cannot be opencode.exe" : false };
const WARNING =
  "Calavera writes this file in the OpenCode 2 layout (mcp.servers), and OpenCode's migration guide says not to point OpenCode 1.x at files in that layout. Upgrade OpenCode to version 2 (https://opencode.ai/docs/migrate-v1/), then start OpenCode in this project.";

/**
 * Runs `callback` with a new project folder as the working folder and a new, empty folder for
 * stubs, which it can put on PATH.
 *
 * @param {(folders: { project: string, bin: string }) => Promise<void>} callback
 */
async function withFolders(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-oc-version-test-"));
  await using bin = await mkdtempDisposable(join(tmpdir(), "calavera-oc-version-test-bin-"));
  const originalDirectory = process.cwd();
  const originalPath = process.env.PATH;
  process.chdir(await realpath(project.path));
  try {
    await callback({ project: await realpath(project.path), bin: await realpath(bin.path) });
  } finally {
    process.chdir(originalDirectory);
    process.env.PATH = originalPath;
  }
}

/**
 * Writes an executable Node script named `opencode` into `folder`. The script runs with this
 * test's Node through an absolute interpreter line, because PATH may hold only the stub's folder.
 *
 * @param {string} folder
 * @param {string} body JavaScript run as the stub.
 * @param {string} [name]
 */
async function stub(folder, body, name = "opencode") {
  const path = join(folder, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** @param {string} text */
const printing = (text) => `process.stdout.write(${JSON.stringify(text)});`;

/** The switch the test preload sets, which turns the OpenCode version check off. */
const SWITCH = "CALAVERA_NO_OPENCODE_VERSION_CHECK";
/** @param {NodeJS.ProcessEnv} env */
const withoutSwitch = (env) =>
  Object.fromEntries(Object.entries(env).filter(([name]) => name !== SWITCH));

/**
 * Whether the process `pid` is gone. A killed process can take a moment to be reaped, so this
 * waits up to two seconds.
 *
 * @param {number} pid
 */
async function gone(pid) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
  }
  return false;
}

/** @param {string} pidFile */
async function killIfAlive(pidFile) {
  for (const pid of (await readFile(pidFile, "utf8").catch(() => "")).split(/\s+/).map(Number)) {
    if (pid > 0) {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }
}

test("parseOpenCodeVersion reads both release lines and nothing else", () => {
  assert.deepEqual(parseOpenCodeVersion("1.19.6\n"), { major: 1, version: "1.19.6" });
  assert.deepEqual(parseOpenCodeVersion("opencode v2.4.0\n"), { major: 2, version: "2.4.0" });
  assert.deepEqual(
    parseOpenCodeVersion(
      "\u001B[1mopencode\u001B[22m \u001B[2mv\u001B[22m\u001B[1m2.4.0\u001B[22m\n",
    ),
    {
      major: 2,
      version: "2.4.0",
    },
  );
  // A build whose root command has another name, and the suffixes semantic versioning allows.
  assert.deepEqual(parseOpenCodeVersion("oc v2.4.0-beta.1+abc"), {
    major: 2,
    version: "2.4.0-beta.1+abc",
  });
  assert.deepEqual(parseOpenCodeVersion("\n  0.15.0  \nmore\n"), { major: 0, version: "0.15.0" });
  assert.deepEqual(parseOpenCodeVersion("1.19.16"), { major: 1, version: "1.19.16" });
  assert.deepEqual(parseOpenCodeVersion("opencode  v10.0.0"), { major: 10, version: "10.0.0" });
  // An escape sequence with an intermediate byte, such as a cursor-style change, is removed too.
  assert.deepEqual(parseOpenCodeVersion("\u001B[1 q1.19.6"), { major: 1, version: "1.19.6" });
  for (const text of [
    "local",
    "",
    "\n\n",
    "opencode 1.2",
    "two words 1.2.3",
    "1.2.3 extra",
    "v1.2.3.4",
  ]) {
    assert.equal(parseOpenCodeVersion(text), undefined, JSON.stringify(text));
  }
});

test(
  "findOpenCode skips empty and relative PATH entries and files without execute permission",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      await stub(project, "", "opencode");
      assert.equal(await findOpenCode(`${delimiter}.${delimiter}relative`, "linux"), undefined);
      await using second = await mkdtempDisposable(join(tmpdir(), "calavera-opencode-second-"));
      const plain = join(bin, "opencode");
      await writeFile(plain, "not executable");
      await chmod(plain, 0o644);
      const later = await stub(await realpath(second.path), "");
      assert.equal(
        await findOpenCode([bin, await realpath(second.path)].join(delimiter), "linux"),
        later,
      );
      // A folder named opencode is not the executable.
      await mkdir(join(project, "dir", "opencode"), { recursive: true });
      assert.equal(await findOpenCode(join(project, "dir"), "linux"), undefined);
      // On Windows only opencode.exe counts, so a script named opencode is never chosen there.
      const secondFolder = later.slice(0, -"opencode".length - 1);
      assert.equal(await findOpenCode(secondFolder, "win32"), undefined);
      const exe = await stub(secondFolder, "", "opencode.exe");
      assert.equal(await findOpenCode(secondFolder, "win32"), exe);
      assert.equal(await findOpenCode(undefined, "linux"), undefined);
    });
  },
);

for (const [label, body, expected] of /** @type {const} */ ([
  ["1.19.6", printing("1.19.6\n"), { versionCheck: "older", version: "1.19.6" }],
  ["0.15.0", printing("0.15.0\n"), { versionCheck: "older", version: "0.15.0" }],
  ["opencode v2.4.0", printing("opencode v2.4.0\n"), { versionCheck: "ok", version: "2.4.0" }],
  [
    "opencode v2.4.0 in color",
    printing("\u001B[1mopencode\u001B[22m \u001B[2mv\u001B[22m\u001B[1m2.4.0\u001B[22m\n"),
    { versionCheck: "ok", version: "2.4.0" },
  ],
  ["local", printing("local\n"), { versionCheck: "unparsed" }],
  ["nothing", "", { versionCheck: "unparsed" }],
  ["exit code 1", `${printing("1.19.6\n")} process.exit(1);`, { versionCheck: "failed" }],
  ["100 KiB of output", printing("1".repeat(100 * 1024)), { versionCheck: "failed" }],
])) {
  test(`a stub that prints ${label} gives ${expected.versionCheck}`, posix, async () => {
    await withFolders(async ({ bin }) => {
      await stub(bin, body);
      assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin } }), expected);
    });
  });
}

test("a temporary folder that cannot be created gives failed, never an error", posix, async () => {
  await withFolders(async ({ bin }) => {
    await stub(bin, printing("1.19.6\n"));
    const original = process.env.TMPDIR;
    process.env.TMPDIR = join(bin, "missing", "folder");
    try {
      assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin } }), {
        versionCheck: "failed",
      });
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
  });
});

test("PATH with only an empty folder gives missing", posix, async () => {
  await withFolders(async ({ bin }) => {
    assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin } }), {
      versionCheck: "missing",
    });
    assert.deepEqual(await checkOpenCodeVersion({ env: {} }), { versionCheck: "missing" });
  });
});

test(
  "an opencode planted in the folder --init runs from never runs through an empty or relative PATH entry",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      const marker = join(bin, "planted-ran");
      await stub(
        project,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); ${printing("1.0.0\n")}`,
      );
      assert.deepEqual(
        await checkOpenCodeVersion({ env: { PATH: `${delimiter}.${delimiter}relative` } }),
        { versionCheck: "missing" },
      );
      await assert.rejects(access(marker), /ENOENT/);
    });
  },
);

test(
  "a stub that sleeps past the bound ends as timeout, not failed, though SIGTERM ends it",
  posix,
  async () => {
    await withFolders(async ({ bin }) => {
      await stub(bin, `setTimeout(() => {}, 60_000);`);
      assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin }, timeoutMs: 300 }), {
        versionCheck: "timeout",
      });
    });
  },
);

test(
  "the test preload turns the check off, so an ordinary --init test never starts opencode",
  posix,
  async () => {
    assert.equal(process.env[SWITCH], "1", "scripts/test-environment.mjs sets the switch");
    await withFolders(async ({ project, bin }) => {
      const marker = join(bin, "ran");
      await stub(
        bin,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran"); ${printing("1.19.6\n")}`,
      );
      // In this process, as the in-process tests run `--init`.
      process.env.PATH = `${bin}${delimiter}${process.env.PATH ?? ""}`;
      const result = await agentBootstrap({
        json: true,
        mcpHarness: "opencode",
        packageManager: "npm",
      });
      assert.equal(result.mcp.versionCheck, "skipped");
      assert.ok(result.changes.every((change) => change.warning === undefined));
      // In a child process with the inherited environment, as the CLI tests run it.
      const child = await new Promise((resolvePromise) => {
        execFile(
          process.execPath,
          [binPath, "--init", "--yes", "--json", "--dry-run", "--mcp-harness", "opencode"],
          { cwd: project, env: { ...process.env, PATH: bin } },
          (error, stdout) => resolvePromise({ error, stdout }),
        );
      });
      assert.equal(
        JSON.parse(String(/** @type {any} */ (child).stdout)).mcp.versionCheck,
        "skipped",
      );
      await assert.rejects(access(marker), /ENOENT/);
    });
  },
);

test(
  "the check runs when the switch is off, and skips for 1 or true in any letter case",
  posix,
  async () => {
    await withFolders(async ({ bin }) => {
      await stub(bin, printing("1.19.6\n"));
      for (const value of ["1", "true", "TRUE"]) {
        assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin, [SWITCH]: value } }), {
          versionCheck: "skipped",
        });
      }
      for (const value of ["0", "", "no"]) {
        assert.equal(
          (await checkOpenCodeVersion({ env: { PATH: bin, [SWITCH]: value } })).versionCheck,
          "older",
          value,
        );
      }
    });
  },
);

test(
  "a stub that traps SIGTERM is gone after a timeout, because the check kills it",
  posix,
  async () => {
    await withFolders(async ({ bin }) => {
      const pidFile = join(bin, "stub.pid");
      await stub(
        bin,
        `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000);`,
      );
      try {
        assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin }, timeoutMs: 2000 }), {
          versionCheck: "timeout",
        });
        assert.ok(await gone(Number(await readFile(pidFile, "utf8"))), "the stub still runs");
      } finally {
        await killIfAlive(pidFile);
      }
    });
  },
);

test(
  "a grandchild the stub started, as npm's opencode launcher starts the native binary, is gone after a timeout",
  posix,
  async () => {
    await withFolders(async ({ bin }) => {
      const pidFile = join(bin, "pids");
      // The grandchild stays in the stub's process group, traps SIGTERM, and has no pipes of its
      // own, so only the group kill reaches it.
      await stub(
        bin,
        [
          `const { spawn } = require("node:child_process");`,
          `const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: "ignore" });`,
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, process.pid + " " + child.pid);`,
          `process.on("SIGTERM", () => {});`,
          `setTimeout(() => {}, 60_000);`,
        ].join("\n"),
      );
      try {
        assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin }, timeoutMs: 2000 }), {
          versionCheck: "timeout",
        });
        const [stubPid, grandchildPid] = (await readFile(pidFile, "utf8")).split(" ").map(Number);
        assert.ok(await gone(/** @type {number} */ (stubPid)), "the stub still runs");
        assert.ok(await gone(/** @type {number} */ (grandchildPid)), "the grandchild still runs");
      } finally {
        await killIfAlive(pidFile);
      }
    });
  },
);

test("the stub that ignores SIGTERM ends as timeout within the bound", posix, async () => {
  await withFolders(async ({ bin }) => {
    await stub(bin, `process.on("SIGTERM", () => {}); setTimeout(() => {}, 60_000);`);
    const started = Date.now();
    assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin }, timeoutMs: 300 }), {
      versionCheck: "timeout",
    });
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  });
});

/**
 * Starts a Node process that runs the check against `bin` and prints the outcome.
 *
 * @param {string} project
 * @param {string} bin
 * @param {number} timeoutMs
 */
async function runnerScript(project, bin, timeoutMs) {
  const moduleUrl = new URL("../src/utils/opencode-version.js", import.meta.url).href;
  const script = join(project, `run-check-${timeoutMs}.mjs`);
  await writeFile(
    script,
    `const { checkOpenCodeVersion } = await import(${JSON.stringify(moduleUrl)});\nconsole.log(JSON.stringify(await checkOpenCodeVersion({ env: { PATH: ${JSON.stringify(bin)} }, timeoutMs: ${timeoutMs} })));\n`,
  );
  return script;
}

test(
  "Ctrl+C during the check ends opencode and its group, and removes the private folder",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      const pidFile = join(bin, "pids");
      await stub(
        bin,
        [
          `const { spawn } = require("node:child_process");`,
          `const child = spawn(process.execPath, ["-e", "process.on('SIGTERM', () => {}); setTimeout(() => {}, 60000)"], { stdio: "ignore" });`,
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, process.pid + " " + child.pid + " " + process.cwd());`,
          `process.on("SIGTERM", () => {});`,
          `setTimeout(() => {}, 60_000);`,
        ].join("\n"),
      );
      const script = await runnerScript(project, bin, 30_000);
      const runner = spawnProcess(process.execPath, [script], { stdio: "ignore" });
      try {
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if ((await readFile(pidFile, "utf8").catch(() => "")).split(" ").length === 3) break;
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 50));
        }
        const [stubPid, grandchildPid, folder] = (await readFile(pidFile, "utf8")).split(" ");
        // What a terminal sends for Ctrl+C reaches Calavera, not the group opencode leads.
        runner.kill("SIGINT");
        await new Promise((resolvePromise) => runner.once("exit", resolvePromise));
        assert.ok(await gone(Number(stubPid)), "the stub still runs");
        assert.ok(await gone(Number(grandchildPid)), "the grandchild still runs");
        await assert.rejects(access(/** @type {string} */ (folder)), /ENOENT/);
      } finally {
        runner.kill("SIGKILL");
        await killIfAlive(pidFile);
      }
    });
  },
);

test(
  "a check that ended removes its exit handler, so exiting later signals no process group",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      await stub(bin, printing("1.19.6\n"));
      const moduleUrl = new URL("../src/utils/opencode-version.js", import.meta.url).href;
      const record = join(project, "kills.json");
      const script = join(project, "run-and-exit.mjs");
      // The spy writes every signal it sees at once, because signal-exit runs its callbacks after
      // the ordinary exit listeners, so an exit listener would write before they run.
      await writeFile(
        script,
        [
          `import { appendFileSync, writeFileSync } from "node:fs";`,
          `writeFileSync(${JSON.stringify(record)}, "");`,
          `const kill = process.kill.bind(process);`,
          `process.kill = (pid, signal) => { appendFileSync(${JSON.stringify(record)}, JSON.stringify([pid, signal]) + "\\n"); try { return kill(pid, signal); } catch { return false; } };`,
          `const { checkOpenCodeVersion } = await import(${JSON.stringify(moduleUrl)});`,
          `const outcome = await checkOpenCodeVersion({ env: { PATH: ${JSON.stringify(bin)} }, timeoutMs: 20000 });`,
          `appendFileSync(${JSON.stringify(record)}, JSON.stringify({ outcome }) + "\\n");`,
          `process.exit(0);`,
        ].join("\n"),
      );
      await new Promise((resolvePromise, reject) => {
        execFile(process.execPath, [script], { timeout: 30_000 }, (error) =>
          error ? reject(error) : resolvePromise(undefined),
        );
      });
      const entries = (await readFile(record, "utf8"))
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line));
      const outcome = entries.find((entry) => !Array.isArray(entry))?.outcome;
      const kills = entries.filter((entry) => Array.isArray(entry));
      assert.deepEqual(outcome, { versionCheck: "older", version: "1.19.6" });
      assert.deepEqual(
        kills.filter((/** @type {[number, string]} */ [pid]) => pid < 0),
        [],
        "a negative process ID names a group",
      );
    });
  },
);

test(
  "the child's standard input is never the caller's: it reads from the null device",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      const record = join(bin, "stdin.json");
      await stub(
        bin,
        [
          `const fs = require("node:fs");`,
          `const input = fs.fstatSync(0);`,
          `const empty = fs.statSync("/dev/null");`,
          `fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify(input.isCharacterDevice() && input.rdev === empty.rdev));`,
          printing("1.19.6\n"),
        ].join("\n"),
      );
      const script = await runnerScript(project, bin, 20_000);
      // The runner's own standard input is a pipe, so a child that inherited it would see a pipe.
      await new Promise((resolvePromise) => {
        const runner = spawnProcess(process.execPath, [script], {
          stdio: ["pipe", "ignore", "ignore"],
        });
        runner.once("exit", resolvePromise);
      });
      assert.equal(JSON.parse(await readFile(record, "utf8")), true);
    });
  },
);

test(
  "a process whose check succeeds exits at once, not when the bound would have ended it",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      await stub(bin, printing("1.19.6\n"));
      const script = await runnerScript(project, bin, 20_000);
      const started = Date.now();
      const stdout = await new Promise((resolvePromise, reject) => {
        execFile(process.execPath, [script], { timeout: 30_000 }, (error, out) =>
          error ? reject(error) : resolvePromise(out),
        );
      });
      assert.deepEqual(JSON.parse(String(stdout)), { versionCheck: "older", version: "1.19.6" });
      assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started} ms`);
    });
  },
);

test(
  "an opencode that cannot start, such as a script whose interpreter is missing, gives failed",
  posix,
  async () => {
    await withFolders(async ({ bin }) => {
      const path = join(bin, "opencode");
      await writeFile(path, `#!${join(bin, "no-such-interpreter")}\n`);
      await chmod(path, 0o755);
      assert.deepEqual(await checkOpenCodeVersion({ env: { PATH: bin } }), {
        versionCheck: "failed",
      });
    });
  },
);

test(
  "a process that runs the check exits within the bound while a grandchild holds the pipes",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      const pidFile = join(bin, "grandchild.pid");
      // The grandchild inherits the stub's standard output, the one pipe the check reads, and sleeps
      // far past the bound.
      await stub(
        bin,
        [
          `const { spawn } = require("node:child_process");`,
          `const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: ["ignore", "inherit", "inherit"] });`,
          `require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));`,
          `process.on("SIGTERM", () => {});`,
          `setTimeout(() => {}, 60_000);`,
        ].join("\n"),
      );
      const moduleUrl = new URL("../src/utils/opencode-version.js", import.meta.url).href;
      const script = join(project, "run-check.mjs");
      await writeFile(
        script,
        `const { checkOpenCodeVersion } = await import(${JSON.stringify(moduleUrl)});\nconsole.log(JSON.stringify(await checkOpenCodeVersion({ env: { PATH: ${JSON.stringify(bin)} }, timeoutMs: 500 })));\n`,
      );
      const started = Date.now();
      try {
        // The process must exit, not only the check settle, while the grandchild holds the pipe.
        const stdout = await new Promise((resolvePromise, reject) => {
          execFile(process.execPath, [script], { timeout: 20_000 }, (error, out) =>
            error ? reject(error) : resolvePromise(out),
          );
        });
        assert.deepEqual(JSON.parse(String(stdout)), { versionCheck: "timeout" });
        assert.ok(Date.now() - started < 5000, `took ${Date.now() - started} ms`);
      } finally {
        const pid = Number(await readFile(pidFile, "utf8").catch(() => "0"));
        if (pid > 0) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            // Already gone.
          }
        }
      }
    });
  },
);

test(
  "the child runs in a fresh private folder that is gone afterward, with NO_COLOR=1, and its standard error is never read",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      const record = join(bin, "record.json");
      await stub(
        bin,
        [
          `process.stderr.write("STDERR-MARKER-1204");`,
          `require("node:fs").writeFileSync(${JSON.stringify(record)}, JSON.stringify({ cwd: process.cwd(), noColor: process.env.NO_COLOR, args: process.argv.slice(2) }));`,
          printing("1.19.6\n"),
        ].join("\n"),
      );
      const result = await checkOpenCodeVersion({ env: { PATH: bin, NO_COLOR: "" } });
      assert.deepEqual(result, { versionCheck: "older", version: "1.19.6" });
      assert.ok(!JSON.stringify(result).includes("STDERR-MARKER"));
      const { cwd, noColor, args } = JSON.parse(await readFile(record, "utf8"));
      assert.equal(noColor, "1");
      assert.deepEqual(args, ["--version"]);
      assert.ok(isAbsolute(cwd));
      // A folder of its own directly under the temporary folder, which mkdtemp made private.
      assert.ok(cwd.startsWith(join(await realpath(tmpdir()), "calavera-opencode-version-")), cwd);
      assert.notEqual(cwd, project);
      assert.ok(!cwd.startsWith(`${project}${sep}`));
      await assert.rejects(access(cwd), /ENOENT/);
    });
  },
);

/**
 * Runs the CLI's `--init` with OpenCode as the host and `bin` alone on PATH.
 *
 * @param {string} cwd
 * @param {string} bin
 * @param {string[]} [extra]
 * @returns {Promise<{ code: number, stdout: string, stderr: string }>}
 */
function runInit(cwd, bin, extra = []) {
  return new Promise((resolvePromise) => {
    execFile(
      process.execPath,
      [binPath, "--init", "--yes", "--mcp-harness", "opencode", ...extra],
      { cwd, env: { ...withoutSwitch(process.env), PATH: bin } },
      (error, stdout, stderr) => {
        resolvePromise({
          code: error ? (typeof error.code === "number" ? error.code : 1) : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

test(
  "--init with OpenCode 1.19.6 on PATH warns once on the opencode.json line and still writes the OpenCode 2 layout",
  posix,
  async () => {
    await withFolders(async ({ project, bin }) => {
      await writeFile(
        "package.json",
        JSON.stringify({ name: "demo", packageManager: "npm@10.0.0" }),
      );
      await stub(bin, `process.stderr.write("STDERR-MARKER-1204"); ${printing("1.19.6\n")}`);

      const human = await runInit(project, bin);
      assert.equal(human.code, 0, human.stderr);
      const line = human.stdout.split("\n").find((text) => text.includes("opencode.json"));
      assert.equal(
        line?.trim(),
        `Wrote opencode.json Warning: OpenCode 1.19.6 is on your PATH. ${WARNING}`,
      );
      assert.deepEqual(listingViolations(human.stdout, ["opencode.json"]), []);
      assert.ok(!`${human.stdout}${human.stderr}`.includes("STDERR-MARKER"));
      const config = JSON.parse(await readFile("opencode.json", "utf8"));
      assert.ok(config.mcp.servers.calavera);
      assert.equal(Object.hasOwn(config.mcp.servers.calavera, "enabled"), false);

      const json = await runInit(project, bin, ["--json", "--dry-run"]);
      const result = JSON.parse(json.stdout);
      assert.equal(result.mcp.versionCheck, "older");
      const change = result.changes.find(
        (/** @type {{ path: string }} */ each) => each.path === "opencode.json",
      );
      assert.equal(change.warning, `OpenCode 1.19.6 is on your PATH. ${WARNING}`);
    });
  },
);

/** @param {() => Promise<void>} callback @param {string} bin */
async function withPath(bin, callback) {
  process.env.PATH = bin;
  // These tests exercise the check, so they opt in: the test preload turns it off for every
  // other test (scripts/test-environment.mjs).
  const switchValue = process.env[SWITCH];
  delete process.env[SWITCH];
  try {
    await callback();
  } finally {
    if (switchValue !== undefined) process.env[SWITCH] = switchValue;
  }
}

for (const [label, body, versionCheck] of /** @type {const} */ ([
  ["OpenCode 2", printing("opencode v2.4.0\n"), "ok"],
  ["a failing opencode", "process.exit(1);", "failed"],
  ["no opencode", undefined, "missing"],
])) {
  test(`--init with ${label} on PATH gives ${versionCheck} and no warning`, posix, async () => {
    await withFolders(async ({ bin }) => {
      if (body !== undefined) await stub(bin, body);
      await withPath(bin, async () => {
        const result = await agentBootstrap({
          json: true,
          mcpHarness: "opencode",
          packageManager: "npm",
        });
        assert.equal(result.mcp.versionCheck, versionCheck);
        assert.equal(result.mcp.action, "write");
        assert.ok(result.changes.every((change) => change.warning === undefined));
      });
    });
  });
}

for (const [label, file, action] of /** @type {const} */ ([
  [
    "an edited entry",
    `${JSON.stringify({ mcp: { servers: { calavera: { type: "local", command: ["mine"] } } } })}\n`,
    "skip",
  ],
  [
    "a file with comments and an entry",
    `{\n  // mine\n  "mcp": { "servers": { "calavera": { "type": "local", "command": ["mine"] } } }\n}\n`,
    "skip",
  ],
  [
    "a moved entry",
    `${JSON.stringify({ mcp: { calavera: { type: "local", command: ["npx", "--package", "create-project-calavera@6.2.1", "create-project-calavera-mcp"], enabled: true } } })}\n`,
    "update",
  ],
])) {
  test(
    `--init with OpenCode 1.x on PATH carries the warning on the one line for ${label}`,
    posix,
    async () => {
      await withFolders(async ({ bin }) => {
        await stub(bin, printing("1.19.6\n"));
        await writeFile("opencode.json", file);
        await withPath(bin, async () => {
          const result = await agentBootstrap({
            json: true,
            mcpHarness: "opencode",
            packageManager: "npm",
          });
          assert.equal(result.mcp.action, action);
          const listed = result.changes.filter((change) => change.path === "opencode.json");
          assert.equal(listed.length, 1);
          assert.equal(listed[0]?.warning, `OpenCode 1.19.6 is on your PATH. ${WARNING}`);
        });
      });
    },
  );
}

test(
  "--init with OpenCode 1.x on PATH and a manual setup appends the warning to the one reason",
  posix,
  async () => {
    await withFolders(async ({ bin }) => {
      await stub(bin, printing("1.19.6\n"));
      await writeFile("opencode.json", "{ broken");
      await withPath(bin, async () => {
        const result = await agentBootstrap({
          json: true,
          mcpHarness: "opencode",
          packageManager: "npm",
        });
        assert.equal(result.mcp.action, "manual");
        assert.equal(result.mcp.versionCheck, "older");
        assert.ok(
          result.mcp.reason?.endsWith(` Warning: OpenCode 1.19.6 is on your PATH. ${WARNING}`),
        );
        assert.equal(
          result.changes.some((change) => change.path === "opencode.json"),
          false,
        );
      });
    });
  },
);

test("a harness other than OpenCode never runs the stub", posix, async () => {
  await withFolders(async ({ bin }) => {
    const marker = join(bin, "ran");
    await stub(bin, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");`);
    await withPath(bin, async () => {
      for (const mcpHarness of ["claude-code", "cursor", "codex", "skip"]) {
        const result = await agentBootstrap({ json: true, mcpHarness, packageManager: "npm" });
        assert.equal(Object.hasOwn(result.mcp, "versionCheck"), false, mcpHarness);
      }
    });
    await assert.rejects(access(marker), /ENOENT/);
  });
});
