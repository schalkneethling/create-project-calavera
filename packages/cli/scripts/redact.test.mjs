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
// Issue #1191: a session ID names a session and grants no access, as `PWD`
// names a folder, so it is not a secret.
const sessionId = "0f6c2a3e-5b7d-4e19-9a8c-1d2e3f4a5b6c";

test("redactSecrets redacts each secret shape and keeps the text around it", () => {
  const cases = [
    // Environment values, by the variable's name.
    [`fetching with ${value}`, "fetching with [redacted]", { NPM_TOKEN: value }],
    [`sent ${value}`, "sent [redacted]", { SESSION_TOKEN: value }],
    [`sent ${value}`, "sent [redacted]", { SESSION_SECRET: value }],
    [`sent ${value}`, "sent [redacted]", { SESSION_COOKIE: value }],
    [`sent ${value}`, "sent [redacted]", { AWS_SESSION_TOKEN: value }],
    [`sent ${value}`, "sent [redacted]", { APP_SESSION: value }],
    // Only the `_SESSION_ID` ending is set aside; the rest of the name decides.
    [`sent ${value}`, "sent [redacted]", { GITHUB_TOKEN_SESSION_ID: value }],
    [`sent ${value}`, "sent [redacted]", { DB_PASS_SESSION_ID: value }],
    // A name that only contains `_SESSION_ID` does not end in it.
    [`sent ${value}`, "sent [redacted]", { APP_SESSION_IDLE: value }],
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
    [`gh-pat=${value}`, "gh-pat=[redacted]"],
    [`--pat ${value}`, "--pat [redacted]"],
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
    CLAUDE_CODE_SESSION_ID: sessionId,
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
    `wrote /var/folders/ab/T/claude-501/project/${sessionId}/scratchpad/out.txt`,
    `CLAUDE_CODE_SESSION_ID=${sessionId}`,
    // A secret in a variable with an innocent name cannot be redacted by name.
    `value ${value}`,
  ];

  for (const text of kept) {
    assert.equal(redactSecrets(text, env), text);
  }
});

// Issue #1149: the time redaction takes must grow linearly with the text, and
// stay small. A single absolute time cannot show the first, because a machine
// running other suites at the same time slows every call. Instead, each
// attempt times the same number
// of characters two ways: as one long input, and as 16 (`GROWTH`) inputs,
// each one sixteenth of its length. In linear time both take about as long, so the
// ratio is near 1. A quadratic term, such as a pattern that starts to
// backtrack, makes the long input slower in proportion to its length, so the
// ratio rises toward `GROWTH` as that term outweighs the linear work. Load
// can slow either measurement of an attempt, so the test compares the
// fastest of each across every attempt, after one untimed run of the short
// inputs that compiles the code. Backtracking grows quadratically or faster,
// so the ratio catches it. A constant-factor slowdown keeps the ratio near 1,
// so the fastest long time must also stay under `LONG_INPUT_LIMIT`. Growth no
// faster than the 1.5th power of the length, such as n log n or a quadratic
// term with a very small constant, keeps the ratio at or below `LIMIT` and is
// caught only if it also crosses that limit.
test("redactSecrets takes linear time on adversarial input", () => {
  const GROWTH = 16;
  const SHORT = 4 * 1024;
  const LONG = SHORT * GROWTH;
  const ATTEMPTS = 10;
  // The long input takes a few milliseconds in linear time. Once two attempts
  // have both taken longer than this, the shape stops early, so a quadratic
  // regression fails after two slow attempts instead of ten. The ratio still
  // decides the result, so a pause that stops the process for a moment does
  // not fail the test by itself.
  const SLOW_LONG_INPUT = 1000;
  // Halfway between linear (about 1) and quadratic (about GROWTH) on a log
  // scale.
  const LIMIT = Math.sqrt(GROWTH);
  // Measured on an 11-core Apple Silicon Mac, the fastest 64 KiB time of the
  // slowest shape (`a:a:…`) was 2.8 to 3.1 ms on a quiet machine and 2.8 to
  // 2.9 ms with 44 busy processes running, because only the fastest attempt
  // counts. A redaction made uniformly 20 times slower took 53 to 54 ms. The
  // limit sits about 8 times above the healthy time, which leaves room for a
  // slower continuous integration runner, and about half the 20-times time,
  // so that slowdown fails.
  const LONG_INPUT_LIMIT = 25;
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
    const redactShortCopies = () => {
      for (let copy = 0; copy < GROWTH; copy += 1) redactSecrets(short, env);
    };
    let fastestShort = Infinity;
    let fastestLong = Infinity;

    redactShortCopies();
    for (
      let attempt = 0;
      attempt < ATTEMPTS && (attempt < 2 || fastestLong < SLOW_LONG_INPUT);
      attempt += 1
    ) {
      fastestShort = Math.min(fastestShort, time(redactShortCopies));
      fastestLong = Math.min(
        fastestLong,
        time(() => redactSecrets(long, env)),
      );
    }

    assert.ok(
      fastestLong < fastestShort * LIMIT,
      `an input starting ${JSON.stringify(short.slice(0, 12))} took ${fastestLong.toFixed(2)} ms ` +
        `at ${long.length} characters, against ${fastestShort.toFixed(2)} ms for ${GROWTH} ` +
        `inputs of ${short.length} characters, a ratio of ` +
        `${(fastestLong / fastestShort).toFixed(2)} where the limit is ${LIMIT}, ` +
        `so its time grows faster than its length`,
    );
    assert.ok(
      fastestLong < LONG_INPUT_LIMIT,
      `an input starting ${JSON.stringify(short.slice(0, 12))} took ${fastestLong.toFixed(2)} ms ` +
        `at its fastest at ${long.length} characters, where the limit is ${LONG_INPUT_LIMIT} ms, ` +
        `so redaction has become slower at every length`,
    );
  }
});
