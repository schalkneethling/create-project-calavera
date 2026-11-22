// Loaded before every test through no-version-check.mjs. When a package manager starts Calavera,
// artifact-core reads credentials only from ~/.npmrc in the home folder of the operating system
// account (#1064), which `pnpm test` would otherwise point at the developer's real file. This module
// points os.userInfo().homedir at an empty folder of its own for the test process, and adds itself
// to NODE_OPTIONS, so every Node.js process a test starts with the inherited environment loads it
// too. The process that creates the folder removes exactly that folder when it exits.
import { mkdtempSync, rmSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { join } from "node:path";

const VARIABLE = "CALAVERA_TEST_ACCOUNT_HOME";

let home = process.env[VARIABLE];
if (!home) {
  home = mkdtempSync(join(os.tmpdir(), "calavera-test-account-home-"));
  process.env[VARIABLE] = home;
  const created = home;
  process.on("exit", () => rmSync(created, { recursive: true, force: true }));
}

const accountHome = home;
const realUserInfo = os.userInfo;
os.userInfo = (/** @type {any} */ options) => {
  /** @type {os.UserInfo<string>} */
  let info;
  try {
    info = realUserInfo.call(os, options);
  } catch {
    info = { username: "test", uid: -1, gid: -1, shell: null, homedir: accountHome };
  }
  return { ...info, homedir: accountHome };
};
syncBuiltinESMExports();

const flag = `--import=${new URL(import.meta.url).href}`;
const nodeOptions = process.env.NODE_OPTIONS ?? "";
if (!nodeOptions.includes(flag)) {
  process.env.NODE_OPTIONS = [nodeOptions, flag].filter(Boolean).join(" ");
}
