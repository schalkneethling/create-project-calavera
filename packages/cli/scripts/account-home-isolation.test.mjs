// The test setup points os.userInfo().homedir at an empty folder for the test process and every
// Node.js process it starts, so no test reads the developer's real ~/.npmrc (#1064). Only
// booleans are reported, never a path's contents.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";
import os from "node:os";
import test from "node:test";
import { promisify } from "node:util";

test("the test process sees an empty account home folder of its own", async () => {
  const home = os.userInfo().homedir;
  assert.equal(home, process.env.CALAVERA_TEST_ACCOUNT_HOME);
  assert.equal(dirname(home), os.tmpdir());
  assert.ok(basename(home).startsWith("calavera-test-account-home-"));
  assert.deepEqual(await readdir(home), []);
});

test("a child process started with the inherited environment sees the same account home", async () => {
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import os from "node:os"; console.log(os.userInfo().homedir === process.env.CALAVERA_TEST_ACCOUNT_HOME);',
    ],
    { env: process.env },
  );
  assert.equal(stdout.trim(), "true");
});
