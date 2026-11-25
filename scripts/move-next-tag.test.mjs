import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import semver from "semver";

import { compareWithStable, moveNextTag, planNextTag } from "./move-next-tag.mjs";

// move-next-tag.mjs runs in the publish job, which has no checkout and no installed dependencies,
// so it compares versions itself. These pairs hold it to the semver package's precedence.
const versions = [
  "0.9.0",
  "1.0.0",
  "1.0.1",
  "1.1.0",
  "2.0.0",
  "10.0.0",
  "1.0.0-next.0",
  "1.0.0-beta.2",
  "1.0.1-next.3",
  "2.0.0-next.1",
  "2.0.0-0",
  "1.0.0+build.5",
  "1.0.0-rc.1+build.5",
];
const stables = ["0.9.0", "1.0.0", "1.0.1", "1.1.0", "2.0.0", "10.0.0"];

test("compareWithStable agrees with semver for every pair", () => {
  for (const stable of stables) {
    for (const other of versions) {
      assert.equal(
        compareWithStable(other, stable),
        semver.compare(other, stable),
        `${other} against ${stable}`,
      );
    }
  }
});

// npm stores normalized versions, so a leading "v", which semver.valid tolerates, is rejected.
test("compareWithStable rejects anything that is not a strict semantic version", () => {
  for (const value of [
    "",
    "1.0",
    "v1.0.0",
    "01.0.0",
    "1.01.0",
    "1.0.01",
    "1.0.0-",
    "1.0.0-01",
    "1.0.0-a.01",
    "1.0.0-a..b",
    "1.0.0-a$b",
    "1.0.0-a.b$",
    "1.0.0+",
    "1.0.0+a.",
    "1.0.0+a$",
    "1.0.0+a.b$",
    "latest",
    undefined,
    { toString: () => "1.0.0" },
  ]) {
    assert.equal(compareWithStable(value, "1.0.0"), undefined, String(value));
  }
});

test("compareWithStable accepts every strict semantic version form", () => {
  for (const value of [
    "1.10.0",
    "1.0.10",
    "1.0.0-10",
    "1.0.0-100",
    "1.0.0-0a",
    "1.0.0-a.10",
    "1.0.0-a.0a",
    "1.0.0-a.b-c",
    "1.0.0+ab",
    "1.0.0+a.bc",
    "1.0.0-a+b.c",
  ]) {
    assert.equal(compareWithStable(value, "1.0.0"), semver.compare(value, "1.0.0"), value);
  }
});

test("compareWithStable compares only against a stable version", () => {
  assert.equal(compareWithStable("1.0.0", "1.0.0-next.0"), undefined);
  assert.equal(compareWithStable("1.0.0", "x"), undefined);
});

test("planNextTag moves a missing next tag to a stable release that is latest", () => {
  assert.deepEqual(planNextTag({ version: "1.2.0", state: "published", tags: {} }), {
    action: "move",
  });
  assert.deepEqual(planNextTag({ version: "1.2.0", state: "skipped", tags: { latest: "1.2.0" } }), {
    action: "move",
  });
});

test("planNextTag moves a next tag that trails the stable release", () => {
  for (const next of ["1.1.0", "1.2.0-next.4", "0.1.0-next.1"]) {
    assert.deepEqual(
      planNextTag({ version: "1.2.0", state: "published", tags: { latest: "1.1.0", next } }),
      { action: "move" },
      next,
    );
  }
});

test("planNextTag never moves next backward", () => {
  assert.deepEqual(
    planNextTag({ version: "1.2.0", state: "published", tags: { next: "1.3.0-next.0" } }),
    { action: "keep", reason: "next 1.3.0-next.0 is already ahead of 1.2.0" },
  );
  assert.deepEqual(
    planNextTag({ version: "1.2.0", state: "skipped", tags: { latest: "1.2.0", next: "1.2.0" } }),
    { action: "keep", reason: "next already points to 1.2.0" },
  );
});

// publish.yml makes the same call for the channel: only a hyphen before any build metadata (+)
// marks a prerelease.
test("planNextTag reads build metadata the way semver does", () => {
  assert.equal(semver.prerelease("1.2.0+build-1"), null);
  assert.deepEqual(planNextTag({ version: "1.2.0+build-1", state: "published", tags: {} }), {
    action: "move",
  });
  assert.deepEqual(planNextTag({ version: "1.2.0-rc.1+build-1", state: "published", tags: {} }), {
    action: "keep",
    reason: "1.2.0-rc.1+build-1 is a prerelease, which npm publish --tag next already tagged",
  });
});

test("planNextTag never moves next to a prerelease", () => {
  assert.deepEqual(planNextTag({ version: "1.2.0-next.1", state: "published", tags: {} }), {
    action: "keep",
    reason: "1.2.0-next.1 is a prerelease, which npm publish --tag next already tagged",
  });
});

test("planNextTag leaves next alone when an already published version is not latest", () => {
  assert.deepEqual(
    planNextTag({ version: "1.2.0", state: "skipped", tags: { latest: "1.3.0", next: "1.1.0" } }),
    {
      action: "keep",
      reason: "latest is 1.3.0, not 1.2.0, so moving next to 1.2.0 would put it behind latest",
    },
  );
  assert.equal(
    planNextTag({ version: "1.2.0", state: "skipped", tags: {} }).action,
    "keep",
    "a missing latest is not this version",
  );
});

test("planNextTag fails on a next tag it cannot compare instead of guessing", () => {
  assert.deepEqual(planNextTag({ version: "1.2.0", state: "published", tags: { next: "x" } }), {
    action: "fail",
    reason: "next is x, which is not a semantic version",
  });
});

test("planNextTag fails on a version or state it does not recognize", () => {
  assert.deepEqual(planNextTag({ version: "1.2", state: "published", tags: {} }), {
    action: "fail",
    reason: "1.2 is not a semantic version",
  });
  assert.deepEqual(planNextTag({ version: "1.2.0", state: "other", tags: {} }), {
    action: "fail",
    reason: "unknown publish state other",
  });
});

test("planNextTag names a missing latest", () => {
  assert.deepEqual(planNextTag({ version: "1.2.0", state: "skipped", tags: {} }), {
    action: "keep",
    reason: "latest is missing, not 1.2.0, so moving next to 1.2.0 would put it behind latest",
  });
});

function fakeNpm(responses) {
  const calls = [];
  return {
    calls,
    runNpm(args) {
      calls.push(args);
      const response = responses[args[0]];
      return typeof response === "function" ? response(args) : response;
    },
  };
}

test("moveNextTag reads dist-tags online and adds next at the stable version", () => {
  const lines = [];
  const npm = fakeNpm({
    view: { status: 0, stdout: JSON.stringify({ latest: "1.1.0", next: "1.1.0-next.2" }) },
    "dist-tag": { status: 0, stdout: "" },
  });
  const status = moveNextTag(["@scope/pkg", "1.2.0", "published"], {
    runNpm: npm.runNpm,
    report: (line) => lines.push(line),
  });
  assert.equal(status, 0);
  assert.deepEqual(npm.calls, [
    ["view", "--prefer-online", "@scope/pkg", "dist-tags", "--json"],
    ["dist-tag", "add", "@scope/pkg@1.2.0", "next"],
  ]);
  assert.deepEqual(lines, ["Moved next for @scope/pkg from 1.1.0-next.2 to 1.2.0."]);
});

test("moveNextTag reports why it keeps next and makes no change", () => {
  const lines = [];
  const npm = fakeNpm({ view: { status: 0, stdout: JSON.stringify({ next: "2.0.0-next.0" }) } });
  const status = moveNextTag(["pkg", "1.2.0", "published"], {
    runNpm: npm.runNpm,
    report: (line) => lines.push(line),
  });
  assert.equal(status, 0);
  assert.equal(npm.calls.length, 1);
  assert.deepEqual(lines, ["Kept next for pkg: next 2.0.0-next.0 is already ahead of 1.2.0."]);
});

test("moveNextTag does not read the registry for a prerelease", () => {
  const lines = [];
  const npm = fakeNpm({});
  const status = moveNextTag(["pkg", "1.2.0-next.0", "published"], {
    runNpm: npm.runNpm,
    report: (line) => lines.push(line),
  });
  assert.equal(status, 0);
  assert.deepEqual(npm.calls, []);
  assert.deepEqual(lines, [
    "Kept next for pkg: 1.2.0-next.0 is a prerelease, which npm publish --tag next already tagged.",
  ]);
});

test("moveNextTag refuses invalid input without reading the registry", () => {
  for (const [args, line] of [
    [["pkg", "1.2", "published"], "Could not move next for pkg: 1.2 is not a semantic version."],
    [["pkg", "1.2.0", "other"], "Could not move next for pkg: unknown publish state other."],
  ]) {
    const lines = [];
    const npm = fakeNpm({});
    const status = moveNextTag(args, { runNpm: npm.runNpm, report: (text) => lines.push(text) });
    assert.equal(status, 1);
    assert.deepEqual(npm.calls, []);
    assert.deepEqual(lines, [line]);
  }
});

test("moveNextTag names the package, the command, and the remedy when npm dist-tag fails", () => {
  const lines = [];
  const npm = fakeNpm({
    view: { status: 0, stdout: "{}" },
    "dist-tag": { status: 1, stdout: "" },
  });
  const status = moveNextTag(["pkg", "1.2.0", "published"], {
    runNpm: npm.runNpm,
    report: (line) => lines.push(line),
  });
  assert.equal(status, 1);
  const text = lines.join("\n");
  assert.match(
    text,
    /^Could not move next for pkg to 1\.2\.0: npm dist-tag add pkg@1\.2\.0 next exited with 1\./,
  );
  assert.equal(
    text,
    [
      "Could not move next for pkg to 1.2.0: npm dist-tag add pkg@1.2.0 next exited with 1. npm's own output above shows its error.",
      "The usual cause is that Allow npm dist-tag is not enabled on the package's trusted publisher on npmjs.com, and npm may report that only as an authentication error. Changing a dist-tag through trusted publishing also needs npm CLI 11.21.0 or later, or 12.2.0 or later.",
      'Enable it, then rerun the failed publish job, or run npm dist-tag add pkg@1.2.0 next from a terminal logged in to npm as a package owner. See "Move a stale next tag" in docs/release-runbook.md.',
    ].join("\n"),
  );
});

test("moveNextTag fails diagnosably when the registry read fails or returns no tag object", () => {
  for (const [view, cause] of [
    [{ status: 1, stdout: "" }, "exited with 1"],
    [{ status: 0, stdout: "not json" }, "returned malformed JSON"],
    [{ status: 0, stdout: "null" }, "returned no object"],
    [{ status: 0, stdout: "3" }, "returned no object"],
  ]) {
    const lines = [];
    const npm = fakeNpm({ view });
    const status = moveNextTag(["pkg", "1.2.0", "skipped"], {
      runNpm: npm.runNpm,
      report: (line) => lines.push(line),
    });
    assert.equal(status, 1);
    assert.equal(npm.calls.length, 1, "no tag change after a failed read");
    assert.deepEqual(lines, [
      `Could not read the dist-tags of pkg: npm view --prefer-online pkg dist-tags --json ${cause}. npm's own output above names the cause. next was not changed.`,
    ]);
  }
});

test("moveNextTag fails when the plan cannot compare next", () => {
  const lines = [];
  const npm = fakeNpm({ view: { status: 0, stdout: JSON.stringify({ next: "x" }) } });
  const status = moveNextTag(["pkg", "1.2.0", "published"], {
    runNpm: npm.runNpm,
    report: (line) => lines.push(line),
  });
  assert.equal(status, 1);
  assert.equal(npm.calls.length, 1);
  assert.deepEqual(lines, [
    "Could not move next for pkg: next is x, which is not a semantic version. Check it with npm view pkg dist-tags --json.",
  ]);
});

test("moveNextTag rejects the wrong number of arguments", () => {
  const lines = [];
  const status = moveNextTag(["pkg", "1.2.0"], {
    runNpm() {
      throw new Error("must not run npm");
    },
    report: (line) => lines.push(line),
  });
  assert.equal(status, 1);
  assert.match(lines[0], /^Usage: move-next-tag\.mjs <package> <version> <published\|skipped>$/);
});

// Runs the script the way publish.yml does, with a fake npm first on PATH, so the real registry is
// never contacted. The fake records its arguments and answers like npm 11.
test("the script runs npm through PATH and exits with the result", async () => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-move-next-tag-"));
  try {
    const log = join(directory, "npm.log");
    const fake = join(directory, "npm");
    await writeFile(
      fake,
      [
        "#!/bin/sh",
        `echo "$*" >> "${log}"`,
        'if [ "$1" = view ]; then echo \'{"latest":"1.1.0"}\'; exit 0; fi',
        'if [ "$3" = "bad@1.2.0" ]; then echo "npm error 403" >&2; exit 1; fi',
        'echo "+next: $3"',
        "",
      ].join("\n"),
    );
    await chmod(fake, 0o755);
    const script = fileURLToPath(new URL("./move-next-tag.mjs", import.meta.url));
    const runScript = (args) =>
      spawnSync(process.execPath, [script, ...args], {
        encoding: "utf8",
        env: { PATH: `${directory}:/usr/bin:/bin` },
      });

    const moved = runScript(["good", "1.2.0", "published"]);
    assert.equal(moved.status, 0, moved.stderr);
    assert.equal(moved.stdout, "Moved next for good from (none) to 1.2.0.\n");

    const failed = runScript(["bad", "1.2.0", "published"]);
    assert.equal(failed.status, 1);
    assert.match(failed.stderr, /^npm error 403$/m);
    assert.match(failed.stdout, /^Could not move next for bad to 1\.2\.0: /);

    assert.deepEqual((await readFile(log, "utf8")).trim().split("\n"), [
      "view --prefer-online good dist-tags --json",
      "dist-tag add good@1.2.0 next",
      "view --prefer-online bad dist-tags --json",
      "dist-tag add bad@1.2.0 next",
    ]);

    const missing = spawnSync(process.execPath, [script, "good", "1.2.0", "published"], {
      encoding: "utf8",
      env: { PATH: join(directory, "nothing-here") },
    });
    assert.equal(missing.status, 1);
    assert.match(
      missing.stdout,
      /^Could not read the dist-tags of good: npm view --prefer-online good dist-tags --json could not start npm \(ENOENT\)\./,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
