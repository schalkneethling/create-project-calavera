// Runs package.json scripts with the system temporary folder pointed at a new folder that belongs
// to this run, then fails when they left `calavera-*` entries in it (#1076). `pnpm quality` runs
// its steps through this script, so a test that stops removing its folder fails the suite.
//
//   node scripts/check-temporary-folders.mjs lint test release:contracts
//
// Counting inside a folder of this run's own, instead of counting `calavera-*` entries in the
// system temporary folder before and after, means folders that other sessions and concurrent runs
// create on the same machine are never counted. The run's folder is removed by its exact path
// when the run ends; nothing else in the system temporary folder is touched.
import { spawn } from "node:child_process";
import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { removeTemporaryFolder } from "./temporary-folder.mjs";

/** The prefix of every temporary folder that Calavera's tests and scripts create. */
const LEAK_PREFIX = "calavera-";

/**
 * Runs each command in turn with `TMPDIR` set to a new folder, stopping at the first command that
 * fails, as `&&` would. Returns the exit code of the last command it ran and the `calavera-*`
 * entries left in the folder, which it then removes.
 * @param {[command: string, args: string[]][]} commands
 */
export async function checkTemporaryFolders(commands) {
  const runFolder = await mkdtemp(join(tmpdir(), "calavera-test-run-"));
  try {
    // os.tmpdir() reads TMPDIR on macOS and Linux, the platforms the suite runs on.
    const env = { ...process.env, TMPDIR: runFolder };
    let exitCode = 0;
    for (const [command, args] of commands) {
      exitCode = await run(command, args, env);
      if (exitCode !== 0) break;
    }
    const leftovers = (await readdir(runFolder))
      .filter((name) => name.startsWith(LEAK_PREFIX))
      .sort();
    return { exitCode, leftovers };
  } finally {
    await removeTemporaryFolder(runFolder);
  }
}

/**
 * Groups leftover folder names by the prefix their test gave mkdtemp, which ends before the six
 * random characters that mkdtemp appends, so each line names one kind of fixture once.
 * @param {string[]} leftovers
 */
export function leftoverReport(leftovers) {
  /** @type {Map<string, number>} */
  const counts = new Map();
  for (const name of leftovers) {
    // Only six characters after a hyphen are mkdtemp's; a name without them is kept whole.
    const prefix = name.replace(/(?<=-)[A-Za-z0-9]{6}$/, "");
    counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  const lines = [...counts].map(([prefix, count]) => `  ${prefix}* (${count})`);
  return [
    `The run left ${leftovers.length} ${LEAK_PREFIX}* temporary ${leftovers.length === 1 ? "entry" : "entries"} behind, so a test or script does not remove what it creates when it ends:`,
    ...lines,
    "Create test folders with temporaryFolder from scripts/temporary-folder.mjs, which removes each folder when its test ends, pass or fail.",
  ].join("\n");
}

/**
 * @param {string} command
 * @param {string[]} args
 * @param {NodeJS.ProcessEnv} env
 * @returns {Promise<number>}
 */
function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const scripts = process.argv.slice(2);
  if (scripts.length === 0) {
    process.stderr.write(
      "Usage: node scripts/check-temporary-folders.mjs <package.json script>...\n",
    );
    process.exit(2);
  }
  // Ctrl+C reaches the scripts as well. Ignoring it here lets them stop first, so the run's folder
  // is still removed.
  process.on("SIGINT", () => {});
  const { exitCode, leftovers } = await checkTemporaryFolders(
    scripts.map((script) => ["pnpm", ["run", script]]),
  );
  if (leftovers.length > 0) process.stderr.write(`${leftoverReport(leftovers)}\n`);
  process.exitCode = exitCode !== 0 ? exitCode : leftovers.length > 0 ? 1 : 0;
}
