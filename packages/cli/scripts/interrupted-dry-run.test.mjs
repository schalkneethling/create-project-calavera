// Issue #1081: a dry run that Ctrl+C (SIGINT) or SIGTERM interrupts removes the temporary folders
// it created, by their exact paths, and leaves every other folder in the system's temporary
// folder alone, including another run's folder with the same prefix.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtempDisposable, readdir, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createTemporaryFolder, removeTemporaryFolder } from "../src/utils/cleanup.js";

const CHILD = fileURLToPath(new URL("./interrupted-dry-run-child.mjs", import.meta.url));
const PRELOAD = fileURLToPath(new URL("./no-version-check.mjs", import.meta.url));
const ANOTHER_RUN = ["calavera-locked-artifact-another-run", "calavera-artifact-stage-another-run"];
// A bound on each wait, so a child that never gets ready or never ends fails the test instead of
// hanging it. The dry run takes seconds; the bound is generous for a loaded machine.
const WAIT_MS = 120_000;

/**
 * Settles with `promise`, or rejects with `message` once `WAIT_MS` passes.
 *
 * @template T
 * @param {Promise<T>} promise
 * @param {string} message
 * @returns {Promise<T>}
 */
async function bounded(promise, message) {
  const timeout = new AbortController();
  try {
    return await Promise.race([
      promise,
      delay(WAIT_MS, undefined, { signal: timeout.signal }).then(() => {
        throw new Error(message);
      }),
    ]);
  } finally {
    timeout.abort();
  }
}

/**
 * Starts the child dry run with `temporaryRoot` as the system's temporary folder, waits until both
 * of its temporary folders exist, and returns the child and the folders it created.
 *
 * @param {string} temporaryRoot
 * @param {string} project
 */
async function startInterruptibleDryRun(temporaryRoot, project) {
  const child = spawn(process.execPath, ["--import", PRELOAD, CHILD, project], {
    env: { ...process.env, TMPDIR: temporaryRoot, TMP: temporaryRoot, TEMP: temporaryRoot },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = once(child, "exit");
  const lines = createInterface({ input: child.stdout });
  const ready = new Promise((resolveReady, rejectReady) => {
    lines.on("line", (line) => {
      if (line === "ready") resolveReady(undefined);
    });
    exited.then(([code, signal]) =>
      rejectReady(new Error(`The child exited (${code ?? signal}) before it was ready: ${stderr}`)),
    );
  });
  // A bounded wait that fails stops the child in the test's `finally`, so no child outlives it.
  await bounded(ready, `The child dry run was not ready within ${WAIT_MS} ms: ${stderr}`).catch(
    (error) => {
      child.kill("SIGKILL");
      throw error;
    },
  );
  const created = (await readdir(temporaryRoot)).filter((name) => !ANOTHER_RUN.includes(name));
  return { child, exited, created };
}

for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
  test(`a mixed locked and unlocked dry run that ${signal} interrupts removes only the temporary folders it created`, async () => {
    // One folder the test owns holds the child's system temporary folder and its project, so
    // disposing it removes everything the run left, whatever the outcome.
    await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
    const temporaryRoot = { path: join(owned.path, "tmp") };
    const project = { path: join(owned.path, "project") };
    await mkdir(temporaryRoot.path);
    await mkdir(project.path);
    // Another run's folders, with the same prefixes as the ones the dry run creates.
    for (const name of ANOTHER_RUN) {
      await mkdir(join(temporaryRoot.path, name));
      await writeFile(join(temporaryRoot.path, name, "keep.txt"), "another run\n");
    }

    const { child, exited, created } = await startInterruptibleDryRun(
      temporaryRoot.path,
      project.path,
    );
    assert.deepEqual(
      created.map((name) => name.replace(/[^-]+$/, "")).sort(),
      ["calavera-artifact-stage-", "calavera-locked-artifact-"],
      "the dry run rebuilds the locked package and stages the unlocked one",
    );

    let code;
    let exitSignal;
    try {
      child.kill(signal);
      [code, exitSignal] = await bounded(exited, `The child did not end within ${WAIT_MS} ms`);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }

    assert.equal(code, null);
    assert.equal(exitSignal, signal, "the process still ends by the signal it received");
    for (const name of created) {
      await assert.rejects(stat(join(temporaryRoot.path, name)), { code: "ENOENT" }, name);
    }
    for (const name of ANOTHER_RUN) {
      assert.equal(
        (await stat(join(temporaryRoot.path, name, "keep.txt"))).isFile(),
        true,
        `${name} survives`,
      );
    }
  });
}

test("the interrupt handlers stay attached only while a temporary folder exists", async (t) => {
  // The folders go into a folder the test owns, so disposing it removes them whatever the outcome.
  await using owned = await mkdtempDisposable(join(tmpdir(), "calavera-1081-"));
  const systemTemporaryFolder = process.env.TMPDIR;
  process.env.TMPDIR = owned.path;
  t.after(() => {
    if (systemTemporaryFolder === undefined) delete process.env.TMPDIR;
    else process.env.TMPDIR = systemTemporaryFolder;
  });
  const before = {
    SIGINT: process.listenerCount("SIGINT"),
    SIGTERM: process.listenerCount("SIGTERM"),
  };

  const first = await createTemporaryFolder("calavera-locked-artifact-");
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1, "the first folder attaches it");
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);
  const second = await createTemporaryFolder("calavera-locked-artifact-");
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1);
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM + 1);

  await removeTemporaryFolder(first);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT + 1, "a folder still exists");

  await removeTemporaryFolder(second);
  assert.equal(process.listenerCount("SIGINT"), before.SIGINT);
  assert.equal(process.listenerCount("SIGTERM"), before.SIGTERM);
  assert.equal(
    first.startsWith(owned.path),
    true,
    "the folder is in the system's temporary folder",
  );
  await assert.rejects(stat(first), { code: "ENOENT" });
  await assert.rejects(stat(second), { code: "ENOENT" });
});
