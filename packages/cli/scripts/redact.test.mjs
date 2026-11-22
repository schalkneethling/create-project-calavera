// Tests for issue #619: the one redaction step the CLI and the MCP server run
// before they display an error. Every secret here is fake.
import assert from "node:assert/strict";
import test from "node:test";

import { redactSecrets } from "../src/utils/redact.js";

const npmToken = `npm_${"A1b2C3d4E5".repeat(4).slice(0, 36)}`;
const githubToken = `ghp_${"Z9y8X7w6V5".repeat(4).slice(0, 36)}`;
const fineGrainedToken = `github_pat_${"11ABCDEFG0".repeat(3)}_${"q".repeat(40)}`;
const basicCredential = Buffer.from("someone:hunter2-password").toString("base64");
const value = "s3cr3tValue42";

test("redactSecrets redacts each secret shape and keeps the text around it", () => {
  const cases = [
    // Environment values, by the variable's name.
    [`fetching with ${value}`, "fetching with [redacted]", { NPM_TOKEN: value }],
    // Headers, whose value runs to the end of the line.
    [`Authorization: Bearer ${value}`, "Authorization: [redacted]"],
    [`authorization: Basic ${basicCredential}`, "authorization: [redacted]"],
    [`Authorization: token ${value}`, "Authorization: [redacted]"],
    [`Proxy-Authorization: Basic ${basicCredential}`, "Proxy-Authorization: [redacted]"],
    [`X-Api-Key: ${value}`, "X-Api-Key: [redacted]"],
    [`Cookie: session=${value}; theme=dark`, "Cookie: [redacted]"],
    [`Set-Cookie: sid=${value}; Path=/`, "Set-Cookie: [redacted]"],
    [`"authorization": "Bearer ${value}"`, `"authorization": [redacted]`],
    // Keys, query parameters, and flags that name a secret.
    [`--token=${value}`, "--token=[redacted]"],
    [`--token ${value} --verbose`, "--token [redacted] --verbose"],
    [`--auth-token '${value}'`, "--auth-token '[redacted]'"],
    [`password=${value}`, "password=[redacted]"],
    [`TOKEN=${value} npm publish`, "TOKEN=[redacted] npm publish"],
    [`GET /api?token=${value}&page=2`, "GET /api?token=[redacted]&page=2"],
    [`//registry.npmjs.org/:_authToken=${value}`, "//registry.npmjs.org/:_authToken=[redacted]"],
    [`//registry.example/:_auth=${basicCredential}`, "//registry.example/:_auth=[redacted]"],
    [`{"_authToken":"${value}","registry":"x"}`, `{"_authToken":"[redacted]","registry":"x"}`],
    [`{ "password": "two ${value}" }`, `{ "password": "[redacted]" }`],
    [`token: ${value}\nname: app`, "token: [redacted]\nname: app"],
    [`DB_PASS=${value}`, "DB_PASS=[redacted]"],
    [`GH_PAT=${value}`, "GH_PAT=[redacted]"],
    [`signing_key: ${value}`, "signing_key: [redacted]"],
    // Credentials outside a header.
    [`curl -H "Bearer ${value}"`, `curl -H "Bearer [redacted]"`],
    [`sent Basic ${basicCredential} to the proxy`, "sent Basic [redacted] to the proxy"],
    // Tokens by their shape.
    [`npm error 401 ${npmToken}`, "npm error 401 [redacted]"],
    [`remote: ${githubToken} and ${fineGrainedToken}`, "remote: [redacted] and [redacted]"],
    // URL user information.
    [
      "GET https://someone:hunter2-password@registry.example/pkg",
      "GET https://[redacted]@registry.example/pkg",
    ],
    [
      `git clone https://x-access-token:${githubToken}@github.com/owner/repo.git`,
      "git clone https://[redacted]@github.com/owner/repo.git",
    ],
    [`git+https://${value}@github.com/o/r`, "git+https://[redacted]@github.com/o/r"],
  ];

  for (const [text, expected, env = {}] of cases) {
    const redacted = redactSecrets(text, env);
    assert.equal(redacted, expected, text);
    assert.equal(redactSecrets(redacted, env), redacted, `redacting again changed ${text}`);
  }
});

test("redactSecrets keeps prose, paths, and values that are not secret", () => {
  const env = {
    PWD: "/home/someone/project",
    OLDPWD: "/home/someone/previous",
    AUTHOR_NAME: "Someone Else",
    NPM_CONFIG_AUTH: "true",
    GITHUB_TOKEN: "",
    MY_VALUE: value,
  };
  const kept = [
    "Basic configuration options failed",
    "Basic setup: run the installer first",
    "Bearer of bad news",
    "author: Someone Else",
    "Error: the project at /home/someone/project failed",
    "moved from /home/someone/previous",
    "compass=north",
    "Install command: pnpm add --save-dev knip",
    "It exited with code 3.\nIts last output:\nline a",
    "https://registry.npmjs.org/@scope%2fpkg",
    "ssh git@github.com:owner/repo.git",
    "the token was rejected",
    "--token=",
    "true",
    // A secret in a variable with an innocent name cannot be redacted by name.
    `value ${value}`,
  ];

  for (const text of kept) {
    assert.equal(redactSecrets(text, env), text);
  }
});

// Issue #1149: the time redaction takes must grow linearly with the text.
// Absolute time cannot show that, because a machine running other suites at
// the same time slows every call. Instead, each attempt times the same number
// of characters two ways: as one long input, and as `GROWTH` inputs a
// `GROWTH`th of its length. In linear time both take about as long, so the
// ratio is near 1. In quadratic time, such as after a pattern starts to
// backtrack, the long input takes about `GROWTH` times as long. Load slows
// both measurements of an attempt alike, and the fastest of several attempts
// is the one least disturbed, so the ratio stays near 1 under load.
test("redactSecrets takes linear time on adversarial input", () => {
  const GROWTH = 16;
  const SHORT = 1024;
  const LONG = SHORT * GROWTH;
  const ATTEMPTS = 10;
  // Halfway between linear (about 1) and quadratic (about GROWTH) on a log
  // scale.
  const LIMIT = Math.sqrt(GROWTH);
  const shapes = [
    (size) => "a-".repeat(size / 2),
    (size) => "a".repeat(size),
    (size) => `token${" ".repeat(size)}`,
    (size) => `x://${"a".repeat(size)}`,
    (size) => "a://".repeat(size / 4),
    (size) => `Basic ${"A".repeat(size)}====`,
    (size) => `Bearer ${"a".repeat(size)}`,
    (size) => "token=".repeat(Math.floor(size / 6)),
    (size) => "a:".repeat(size / 2),
    (size) => `"${"a".repeat(size)}`,
    (size) => `--token "${"a".repeat(size)}`,
  ];
  const env = { NPM_TOKEN: value };

  /** @param {() => void} run */
  const time = (run) => {
    const started = performance.now();
    run();
    return performance.now() - started;
  };

  for (const shape of shapes) {
    const short = shape(SHORT);
    const long = shape(LONG);
    let fastestShort = Infinity;
    let fastestLong = Infinity;

    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      fastestShort = Math.min(
        fastestShort,
        time(() => {
          for (let copy = 0; copy < GROWTH; copy += 1) redactSecrets(short, env);
        }),
      );
      fastestLong = Math.min(
        fastestLong,
        time(() => redactSecrets(long, env)),
      );
      if (fastestLong < fastestShort * LIMIT) break;
    }

    assert.ok(
      fastestLong < fastestShort * LIMIT,
      `an input starting ${JSON.stringify(short.slice(0, 12))} took ${fastestLong.toFixed(2)} ms ` +
        `at ${LONG} characters, against ${fastestShort.toFixed(2)} ms for ${GROWTH} inputs of ` +
        `${SHORT} characters, so its time grows faster than its length`,
    );
  }
});
