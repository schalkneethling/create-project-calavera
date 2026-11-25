// Tests for issue #675: the core of the CLI version notice (ADR-0019 Decisions 1, 4, 5, 6, and 7).
// The resolver is a parameter, so these tests need no network. The CLI adapter, which applies the
// deadline and prints, is tested as a process in version-notice-process.test.mjs.
import assert from "node:assert/strict";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  checkForNewerVersion,
  isVersionCheckDisabled,
  versionCheckApplies,
  versionNoticeText,
} from "../src/version-notice.js";
import { temporaryFolder } from "../../../scripts/temporary-folder.mjs";

const humanRun = { command: "init", json: false, checkUpdates: false };

/**
 * The arguments of checkForNewerVersion, with a resolver that returns `latest` and records calls.
 * @param {Partial<Parameters<typeof checkForNewerVersion>[0]>} [overrides]
 * @param {string | Error} [latest]
 */
function checkInput(overrides = {}, latest = "6.3.0") {
  /** @type {{ cwd: string, env: NodeJS.ProcessEnv }[]} */
  const calls = [];
  return {
    calls,
    input: {
      version: "6.2.1",
      options: humanRun,
      cwd: "/example/project",
      env: {},
      packageRoot: "/elsewhere/_npx/node_modules/create-project-calavera",
      packageName: "create-project-calavera",
      /** @param {{ cwd: string, env: NodeJS.ProcessEnv }} context */
      resolveLatest: async (context) => {
        calls.push(context);
        if (latest instanceof Error) throw latest;
        return latest;
      },
      /** @param {string} version */
      runCommand: (version) =>
        `npx --package create-project-calavera@${version} create-project-calavera --init`,
      /** @param {string} version */
      updateCommand: async (version) => `npm install --save-dev create-project-calavera@${version}`,
      ...overrides,
    },
  };
}

test("CALAVERA_NO_VERSION_CHECK turns the check off with 1 or true, in any case", () => {
  for (const value of ["1", "true", "TRUE", "True"]) {
    assert.equal(isVersionCheckDisabled({ CALAVERA_NO_VERSION_CHECK: value }), true, value);
  }
  for (const value of [undefined, "", "0", "false", "no", "yes", " 1", "10", "truest"]) {
    assert.equal(
      isVersionCheckDisabled({ CALAVERA_NO_VERSION_CHECK: value }),
      false,
      String(value),
    );
  }
});

test("the check runs for human output and is skipped for --json, --help, the switch, and the offline artifact commands", () => {
  assert.equal(versionCheckApplies(humanRun, {}), true);
  assert.equal(versionCheckApplies({ ...humanRun, command: "apply" }, {}), true);
  assert.equal(versionCheckApplies({ ...humanRun, command: "new" }, {}), true);

  assert.equal(versionCheckApplies({ ...humanRun, json: true }, {}), false);
  assert.equal(versionCheckApplies({ ...humanRun, command: "help" }, {}), false);
  assert.equal(versionCheckApplies(humanRun, { CALAVERA_NO_VERSION_CHECK: "1" }), false);

  for (const artifactAction of ["status", "doctor"]) {
    const artifacts = { ...humanRun, command: "artifacts", artifactAction };
    assert.equal(versionCheckApplies(artifacts, {}), false, artifactAction);
    // --check-updates contacts the registry anyway, so the check runs.
    assert.equal(
      versionCheckApplies({ ...artifacts, checkUpdates: true }, {}),
      true,
      artifactAction,
    );
  }
  // Another command whose second argument happens to be status still checks.
  assert.equal(
    versionCheckApplies({ ...humanRun, command: "apply", artifactAction: "status" }, {}),
    true,
  );
  for (const artifactAction of ["update", "add", "remove", undefined]) {
    const artifacts = { ...humanRun, command: "artifacts", artifactAction };
    assert.equal(versionCheckApplies(artifacts, {}), true, String(artifactAction));
  }
});

test("a skipped run never calls the resolver", async () => {
  for (const overrides of [
    { options: { ...humanRun, json: true } },
    { options: { ...humanRun, command: "help" } },
    { options: { ...humanRun, command: "artifacts", artifactAction: "status" } },
    { env: { CALAVERA_NO_VERSION_CHECK: "true" } },
  ]) {
    const { input, calls } = checkInput(overrides);
    assert.deepEqual(await checkForNewerVersion(input), { status: "skipped" });
    assert.equal(calls.length, 0, JSON.stringify(overrides));
  }
});

test("the resolver gets the working directory and environment captured at the start", async () => {
  const env = { npm_config_registry: "http://127.0.0.1:1/" };
  const { input, calls } = checkInput({ cwd: "/captured", env });
  await checkForNewerVersion(input);
  assert.deepEqual(calls, [{ cwd: "/captured", env }]);
});

test("an older running version gets the notice facts; an equal or newer one gets none", async () => {
  const older = await checkForNewerVersion(checkInput().input);
  assert.deepEqual(older, {
    status: "newer",
    running: "6.2.1",
    latest: "6.3.0",
    command: "npx --package create-project-calavera@6.3.0 create-project-calavera --init",
    update: undefined,
  });

  assert.deepEqual(await checkForNewerVersion(checkInput({}, "6.2.1").input), {
    status: "current",
    latest: "6.2.1",
  });
  assert.deepEqual(await checkForNewerVersion(checkInput({}, "6.2.0").input), {
    status: "current",
    latest: "6.2.0",
  });
  // A prerelease newer than latest, such as one from `next`, is not older.
  assert.deepEqual(
    await checkForNewerVersion(checkInput({ version: "7.0.0-beta.1" }, "6.3.0").input),
    { status: "current", latest: "6.3.0" },
  );
  // Semantic version precedence, not text order: 6.10.0 is newer than 6.9.0.
  assert.equal(
    (await checkForNewerVersion(checkInput({ version: "6.9.0" }, "6.10.0").input)).status,
    "newer",
  );
});

test("a resolver failure or an invalid latest becomes a failed result, never a throw", async () => {
  const cause = new Error("connect ECONNREFUSED 127.0.0.1:1");
  const failed = await checkForNewerVersion(checkInput({}, cause).input);
  assert.equal(failed.status, "failed");
  assert.equal(failed.status === "failed" && failed.error, cause);

  const invalid = await checkForNewerVersion(checkInput({}, "latest-ish").input);
  assert.equal(invalid.status, "failed");
  assert.equal(
    invalid.status === "failed" && /** @type {Error} */ (invalid.error).message,
    "The registry named no valid version as the latest create-project-calavera.",
  );
});

test("the notice names both versions and the pinned command, and prints nothing otherwise", () => {
  const text = versionNoticeText(
    {
      status: "newer",
      running: "6.2.1",
      latest: "6.3.0",
      command: "npx --package create-project-calavera@6.3.0 create-project-calavera --init",
      update: undefined,
    },
    {},
  );
  assert.equal(
    text,
    "create-project-calavera 6.2.1 is running, but 6.3.0 is the latest release. To run 6.3.0: npx --package create-project-calavera@6.3.0 create-project-calavera --init",
  );

  assert.equal(versionNoticeText({ status: "skipped" }, {}), undefined);
  assert.equal(versionNoticeText({ status: "current", latest: "6.2.1" }, {}), undefined);
});

test("a failed check prints nothing, unless CALAVERA_DEBUG is on, and then its redacted cause", () => {
  const secret = "s3cr3t-registry-token-value";
  const failed = /** @type {const} */ ({
    status: "failed",
    error: new Error(`request to registry failed`, {
      cause: new Error(`401 for token ${secret}`),
    }),
  });

  assert.equal(versionNoticeText(failed, {}), undefined);
  assert.equal(versionNoticeText(failed, { CALAVERA_DEBUG: "0" }), undefined);

  const debug = versionNoticeText(failed, { CALAVERA_DEBUG: "1", NPM_TOKEN: secret });
  assert.match(debug ?? "", /^The check for a newer create-project-calavera failed/);
  assert.match(debug ?? "", /request to registry failed/);
  assert.match(debug ?? "", /Caused by: 401 for token/);
  assert.ok(!debug?.includes(secret), debug);
});

test("as a project dependency, the notice adds one sentence with the update command", async (t) => {
  const project = await temporaryFolder(t, "calavera-version-notice-");
  const packageRoot = join(project, "node_modules", "create-project-calavera");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ devDependencies: { "create-project-calavera": "^6.2.1" } }),
  );

  /** @type {string[]} */
  const updateCalls = [];
  const { input } = checkInput({
    cwd: project,
    packageRoot,
    updateCommand: async (version) => {
      updateCalls.push(version);
      return `vp add -D create-project-calavera@${version}`;
    },
  });
  const result = await checkForNewerVersion(input);
  assert.equal(
    result.status === "newer" && result.update,
    "vp add -D create-project-calavera@6.3.0",
  );
  assert.deepEqual(updateCalls, ["6.3.0"]);

  const text = versionNoticeText(result, {});
  assert.match(text ?? "", /^create-project-calavera 6\.2\.1 is running, but 6\.3\.0/);
  assert.match(
    text ?? "",
    /\nThis project's create-project-calavera dependency is unchanged; to update it, run: vp add -D create-project-calavera@6\.3\.0$/,
  );
});

test("a copy inside node_modules counts as a project dependency only when package.json lists it", async (t) => {
  const root = await temporaryFolder(t, "calavera-version-notice-unlisted-");
  const project = join(root, "project");
  const packageRoot = join(project, "node_modules", "create-project-calavera");
  await mkdir(packageRoot, { recursive: true });
  /** @param {unknown} manifest */
  const writeManifest = (manifest) =>
    writeFile(join(project, "package.json"), JSON.stringify(manifest));
  /** @param {string} root */
  const updateFor = async (root) => {
    const result = await checkForNewerVersion(
      checkInput({ cwd: project, packageRoot: root }).input,
    );
    assert.equal(result.status, "newer");
    return result.status === "newer" ? result.update : "not newer";
  };
  const update = "npm install --save-dev create-project-calavera@6.3.0";

  // Each dependency field counts.
  for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
    await writeManifest({ [field]: { "create-project-calavera": "6.2.1" } });
    assert.equal(await updateFor(packageRoot), update, field);
  }

  // Inside node_modules, but not listed: in another field, or not at all.
  for (const manifest of [
    { dependencies: { other: "1" } },
    { peerDependencies: { "create-project-calavera": "6.2.1" } },
    { devDependencies: null },
  ]) {
    await writeManifest(manifest);
    assert.equal(await updateFor(packageRoot), undefined, JSON.stringify(manifest));
  }

  // Listed, but the running copy is outside the project's node_modules: under npx, in a sibling
  // folder whose name only starts with node_modules, or the node_modules folder itself.
  await writeManifest({ devDependencies: { "create-project-calavera": "6.2.1" } });
  const outside = [
    join(root, "_npx", "node_modules", "create-project-calavera"),
    join(project, "node_modules-copy", "create-project-calavera"),
    join(project, "node_modules"),
  ];
  for (const path of outside) {
    await mkdir(path, { recursive: true });
    assert.equal(await updateFor(path), undefined, path);
  }

  // A package.json that is not JSON, or none at all, is no dependency either.
  await writeFile(join(project, "package.json"), "{ not json");
  assert.equal(await updateFor(packageRoot), undefined);
  await rm(join(project, "package.json"));
  assert.equal(await updateFor(packageRoot), undefined);
});

test("an update command that fails leaves the notice without the dependency sentence", async (t) => {
  const project = await temporaryFolder(t, "calavera-version-notice-update-fails-");
  const packageRoot = join(project, "node_modules", "create-project-calavera");
  await mkdir(packageRoot, { recursive: true });
  await writeFile(
    join(project, "package.json"),
    JSON.stringify({ devDependencies: { "create-project-calavera": "6.2.1" } }),
  );
  const { input } = checkInput({
    cwd: project,
    packageRoot,
    updateCommand: async () => {
      throw new Error("vite-plus detection failed");
    },
  });
  const result = await checkForNewerVersion(input);
  assert.equal(result.status, "newer");
  assert.equal(result.status === "newer" && result.update, undefined);
});

test("every test entry point that runs the CLI loads the setup module that turns the check off", async () => {
  // ADR-0019 Decision 7: the suite turns the check off once, so no test asks a registry for latest.
  const setup = "./scripts/no-version-check.mjs";
  const cliPackage = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  const rootPackage = JSON.parse(
    await readFile(new URL("../../../package.json", import.meta.url), "utf8"),
  );
  const { default: stryker } = await import("../../../stryker.config.mjs");

  for (const [name, script] of [
    ["test", cliPackage.scripts.test],
    ["smoke:node-floor", cliPackage.scripts["smoke:node-floor"]],
    ["schema:check", cliPackage.scripts["schema:check"]],
    ["release:fixture", rootPackage.scripts["release:fixture"]],
  ]) {
    assert.ok(script.includes(`node --import ${setup} `), `${name}: ${script}`);
  }
  const nodeArgs = stryker.tap.nodeArgs;
  assert.equal(nodeArgs[nodeArgs.indexOf("--import") + 1], `./packages/cli${setup.slice(1)}`);

  // The module itself sets the switch.
  const before = process.env.CALAVERA_NO_VERSION_CHECK;
  delete process.env.CALAVERA_NO_VERSION_CHECK;
  try {
    await import(`../scripts/no-version-check.mjs?${Date.now()}`);
    assert.equal(isVersionCheckDisabled(process.env), true);
  } finally {
    if (before === undefined) delete process.env.CALAVERA_NO_VERSION_CHECK;
    else process.env.CALAVERA_NO_VERSION_CHECK = before;
  }
});

test("the adapter names the CLI's package folder and builds apply's install command for the update", async (t) => {
  const { cliPackageRoot, projectDependencyUpdateCommand } = await import("../src/index.js");
  // The folder that holds package.json, not src/, so the node_modules test sees the package.
  assert.equal(cliPackageRoot, fileURLToPath(new URL("../", import.meta.url)));

  const root = await temporaryFolder(t, "calavera-version-notice-update-");
  /** @param {string} name @param {Record<string, string>} files */
  const project = async (name, files) => {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    for (const [file, text] of Object.entries(files)) await writeFile(join(directory, file), text);
    return directory;
  };

  // The lockfile is found in the captured directory, not the current one.
  const yarn = await project("yarn", { "package.json": "{}", "yarn.lock": "" });
  assert.notEqual(process.cwd(), yarn);
  assert.equal(
    await projectDependencyUpdateCommand(yarn, "7.0.0"),
    "yarn add --dev create-project-calavera@7.0.0",
  );

  const pnpmWorkspace = await project("pnpm", {
    "package.json": JSON.stringify({ packageManager: "pnpm@11.28.10" }),
    "pnpm-workspace.yaml": "packages:\n  - packages/*\n",
  });
  assert.equal(
    await projectDependencyUpdateCommand(pnpmWorkspace, "7.0.0"),
    "pnpm add --save-dev -w create-project-calavera@7.0.0",
  );

  const vitePlus = await project("vite-plus", {
    "package.json": JSON.stringify({ devDependencies: { "vite-plus": "1.6.0" } }),
  });
  assert.equal(
    await projectDependencyUpdateCommand(vitePlus, "7.0.0"),
    "vp add -D create-project-calavera@7.0.0",
  );
});
