// @ts-check
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { access, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join } from "node:path";

/**
 * @typedef {"missing" | "timeout" | "failed" | "unparsed" | "older" | "ok"} OpenCodeVersionCheck
 */

/** How long `opencode --version` may run before the check ends as `timeout` (ADR-0022, Decision 6). */
export const OPENCODE_VERSION_TIMEOUT_MS = 5000;
const MAX_OUTPUT_BYTES = 65536;

// OpenCode 1.x prints `1.19.6`; OpenCode 2 prints `opencode v2.4.0`, with color codes when color is
// on (ADR-0022, Decision 6, "What opencode --version prints").
const VERSION_LINE = /^(?:\S+\s+)?v?(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/;
// eslint-disable-next-line no-control-regex -- ANSI escape sequences start with the ESC control character.
const ANSI_ESCAPE = /\u001B\[[0-?]*[ -/]*[@-~]/g;

/**
 * The version `opencode --version` printed, rebuilt from the digits and suffixes the expression
 * captured, so no other text from the output is ever printed. Undefined when the first non-empty
 * line is not a version, such as `local`, or the output is empty.
 *
 * @param {string} stdout
 * @returns {{ major: number, version: string } | undefined}
 */
export function parseOpenCodeVersion(stdout) {
  const line = stdout
    .replace(ANSI_ESCAPE, "")
    .split(/\r?\n/)
    .map((text) => text.trim())
    .find((text) => text !== "");
  const match = VERSION_LINE.exec(line ?? "");
  if (match === null) return undefined;
  const [, major, minor, patch, prerelease = "", build = ""] = match;
  return {
    major: Number(major),
    version: `${major}.${minor}.${patch}${prerelease}${build}`,
  };
}

/**
 * The first `opencode` executable in an absolute folder of `PATH`, or undefined. Empty and relative
 * entries are skipped, because both name the folder the command runs from or one relative to it,
 * where a planted file could be chosen. On Windows only `opencode.exe` counts, because Node cannot
 * run an `opencode.cmd` shim without a shell (owner decision of 2026-11-23 on #1204).
 *
 * @param {string | undefined} searchPath
 * @param {NodeJS.Platform} platform
 * @returns {Promise<string | undefined>}
 */
export async function findOpenCode(searchPath, platform) {
  const name = platform === "win32" ? "opencode.exe" : "opencode";
  for (const folder of searchPath?.split(delimiter) ?? []) {
    // An empty entry is not absolute either.
    if (!isAbsolute(folder)) continue;
    const candidate = join(folder, name);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not there, or not executable: the next folder may hold one.
    }
  }
  return undefined;
}

/**
 * Runs `opencode --version` once and says how old the OpenCode on `PATH` is. The check only
 * informs: no outcome is an error, and none changes what `--init` writes (ADR-0022, Decision 6).
 * It runs an absolute path it found itself, with one fixed argument and no shell, in a private,
 * empty folder it removes afterward, and it ends within `timeoutMs` whatever the child does.
 *
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, timeoutMs?: number }} [options]
 * @returns {Promise<{ versionCheck: OpenCodeVersionCheck, version?: string }>}
 */
export async function checkOpenCodeVersion({
  env = process.env,
  platform = process.platform,
  timeoutMs = OPENCODE_VERSION_TIMEOUT_MS,
} = {}) {
  const executable = await findOpenCode(env.PATH ?? env.Path, platform);
  if (executable === undefined) return { versionCheck: "missing" };

  /** @type {string} */
  let folder;
  try {
    folder = await mkdtemp(join(tmpdir(), "calavera-opencode-version-"));
  } catch {
    // Without a private folder the check does not run, and that is not an error either.
    return { versionCheck: "failed" };
  }
  try {
    const outcome = await runVersion(executable, folder, env, timeoutMs);
    if (outcome.versionCheck !== "ran") return { versionCheck: outcome.versionCheck };
    const parsed = parseOpenCodeVersion(outcome.stdout);
    if (parsed === undefined) return { versionCheck: "unparsed" };
    return parsed.major < 2
      ? { versionCheck: "older", version: parsed.version }
      : { versionCheck: "ok", version: parsed.version };
  } finally {
    // A grandchild that outlives a timeout can still hold the folder on Windows. Removing it is
    // tidiness, so a failure never turns the check into an error.
    await rm(folder, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * @param {string} executable
 * @param {string} folder
 * @param {NodeJS.ProcessEnv} env
 * @param {number} timeoutMs
 * @returns {Promise<{ versionCheck: "ran", stdout: string } | { versionCheck: "timeout" | "failed" }>}
 */
function runVersion(executable, folder, env, timeoutMs) {
  return new Promise((resolve) => {
    /** @type {import("node:child_process").ChildProcess} */
    let child;
    // Started before `execFile`'s own timeout of the same length, so it always fires first and the
    // check ends here. A grandchild can hold the pipes open after the child is killed, and then
    // `execFile` never calls back, so the check also lets go of the child and both pipes.
    const timer = setTimeout(() => {
      resolve({ versionCheck: "timeout" });
      child.kill("SIGKILL");
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
    }, timeoutMs);
    try {
      child = execFile(
        executable,
        ["--version"],
        {
          cwd: folder,
          // Effect, which OpenCode 2 prints its version through, turns color off for NO_COLOR.
          env: { ...env, NO_COLOR: "1" },
          timeout: timeoutMs,
          killSignal: "SIGTERM",
          maxBuffer: MAX_OUTPUT_BYTES,
          windowsHide: true,
          encoding: "utf8",
        },
        (error, stdout) => {
          clearTimeout(timer);
          // A nonzero exit, a failed start, or more output than `maxBuffer` allows. Standard error
          // is never read, so nothing the child wrote there can reach the output.
          resolve(error === null ? { versionCheck: "ran", stdout } : { versionCheck: "failed" });
        },
      );
    } catch {
      // `execFile` reports a failed start through the callback; this covers a synchronous throw,
      // so that no outcome of the check is an error.
      clearTimeout(timer);
      resolve({ versionCheck: "failed" });
    }
  });
}

/**
 * The warning for an OpenCode older than version 2 on `PATH` (ADR-0022, Decision 6). It names only
 * the version the check rebuilt, and never the file, which the change it is appended to names.
 *
 * @param {string} version
 */
export function openCodeVersionWarning(version) {
  return `OpenCode ${version} is on your PATH. Calavera writes this file in the OpenCode 2 layout (mcp.servers), and OpenCode's migration guide says not to point OpenCode 1.x at files in that layout. Upgrade OpenCode to version 2 (https://opencode.ai/docs/migrate-v1/), then start OpenCode in this project.`;
}
