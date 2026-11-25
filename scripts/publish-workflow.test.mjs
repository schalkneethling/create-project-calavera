// Runs the "Publish package" step of .github/workflows/publish.yml, as written, against a fake npm
// and a fake tag script, so its control flow is proven without a registry (#1126). Text checks in
// check-release-contracts.mjs cannot see an added `continue`, `|| true`, or `set +e`; these can.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const workflowPath = fileURLToPath(new URL("../.github/workflows/publish.yml", import.meta.url));

function stepScript(workflow, stepName) {
  const lines = workflow.split("\n");
  const start = lines.indexOf(`      - name: ${stepName}`);
  assert.notEqual(start, -1, `publish.yml must have a "${stepName}" step`);
  const run = lines.findIndex((line, index) => index > start && line === "        run: |");
  assert.notEqual(run, -1, `"${stepName}" must use a run block`);
  const body = [];
  for (const line of lines.slice(run + 1)) {
    if (line.trim() !== "" && !line.startsWith(" ".repeat(10))) break;
    body.push(line.slice(10));
  }
  return `${body.join("\n").trimEnd()}\n`;
}

// The fake npm answers `npm view <pkg>@<version> version` from PUBLISHED, fails `npm publish` for
// FAIL_PUBLISH, and logs every call. The fake tag script logs its arguments and fails for
// FAIL_TAG.
const fakeNpm = `#!/bin/sh
echo "npm $*" >> "$CALLS"
if [ "$1" = view ]; then
  case " $PUBLISHED " in *" $2 "*) echo found; exit 0;; esac
  echo "npm error code E404"
  exit 1
fi
if [ "$1" = publish ]; then
  case "$2" in *"/$FAIL_PUBLISH.tgz") echo "npm error publish failed" >&2; exit 1;; esac
  exit 0
fi
exit 9
`;
const fakeTagScript = `import { appendFileSync } from "node:fs";
const [name, version, state] = process.argv.slice(2);
appendFileSync(process.env.CALLS, \`tag \${name} \${version} \${state}\\n\`);
process.exitCode = name === process.env.FAIL_TAG ? 1 : 0;
`;

async function runPublishStep(packages, env = {}) {
  const directory = await mkdtemp(join(tmpdir(), "calavera-publish-step-"));
  try {
    const bin = join(directory, "bin");
    const packageDir = join(directory, "packages");
    await mkdir(bin);
    await mkdir(packageDir);
    await writeFile(join(bin, "npm"), fakeNpm);
    await chmod(join(bin, "npm"), 0o755);
    // A version manager's node shim can put its own npm ahead of the fake one, so link the real
    // binary instead.
    await symlink(process.execPath, join(bin, "node"));
    const tagScript = join(directory, "move-next-tag.mjs");
    await writeFile(tagScript, fakeTagScript);
    for (const [index, { name, version }] of packages.entries()) {
      const source = join(directory, `source-${index}`, "package");
      await mkdir(source, { recursive: true });
      await writeFile(join(source, "package.json"), JSON.stringify({ name, version }));
      const packed = spawnSync("tar", [
        "-czf",
        join(packageDir, `${name}.tgz`),
        "-C",
        dirname(source),
        "package",
      ]);
      assert.equal(packed.status, 0, String(packed.stderr));
    }
    const script = join(directory, "step.sh");
    await writeFile(script, stepScript(await readFile(workflowPath, "utf8"), "Publish package"));
    const calls = join(directory, "calls.log");
    await writeFile(calls, "");
    // Plain bash, not bash -e, so the step's own shell options are what stop it on a failure.
    const result = spawnSync("bash", [script], {
      encoding: "utf8",
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        PACKAGE_DIR: packageDir,
        NEXT_TAG_SCRIPT: tagScript,
        CALLS: calls,
        PUBLISHED: "",
        FAIL_PUBLISH: "",
        FAIL_TAG: "",
        ...env,
      },
    });
    // The step passes each tarball through realpath, which resolves /var to /private/var on macOS.
    const log = (await readFile(calls, "utf8")).replaceAll(`${await realpath(packageDir)}/`, "");
    return { status: result.status, stdout: result.stdout, stderr: result.stderr, log };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("every package, published or skipped, reaches the tag script with its state", async () => {
  const result = await runPublishStep(
    [
      { name: "done", version: "1.0.0" },
      { name: "fresh", version: "2.0.0" },
    ],
    { PUBLISHED: "done@1.0.0" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^Skipping already published done@1\.0\.0\.$/m);
  assert.deepEqual(result.log.trim().split("\n"), [
    "npm view done@1.0.0 version",
    "tag done 1.0.0 skipped",
    "npm view fresh@2.0.0 version",
    "npm publish fresh.tgz --access public --tag latest",
    "tag fresh 2.0.0 published",
  ]);
});

test("a failed tag move does not stop the loop, and the step fails afterward naming it", async () => {
  const result = await runPublishStep(
    [
      { name: "first", version: "1.0.0" },
      { name: "second", version: "1.0.0" },
    ],
    { FAIL_TAG: "first" },
  );
  assert.equal(result.status, 1);
  assert.match(result.log, /^tag second 1\.0\.0 published$/m);
  assert.match(result.stderr, /next did not move for: first@1\.0\.0\./);
});

test("a failed npm publish stops the step before any later package or tag move", async () => {
  const result = await runPublishStep(
    [
      { name: "first", version: "1.0.0" },
      { name: "second", version: "1.0.0" },
    ],
    { FAIL_PUBLISH: "first" },
  );
  assert.notEqual(result.status, 0);
  assert.deepEqual(result.log.trim().split("\n"), [
    "npm view first@1.0.0 version",
    "npm publish first.tgz --access public --tag latest",
  ]);
  assert.doesNotMatch(result.stderr, /next did not move/);
});

test("the channel follows the prerelease part of the version and ignores build metadata", async () => {
  const result = await runPublishStep([
    { name: "build", version: "1.2.0+build-1" },
    { name: "candidate", version: "1.2.0-rc.1+build-1" },
  ]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.log, /^npm publish build\.tgz --access public --tag latest$/m);
  assert.match(result.log, /^npm publish candidate\.tgz --access public --tag next$/m);
});
