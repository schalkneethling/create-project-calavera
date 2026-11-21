// @ts-check

/**
 * `quoteShellToken` formats the commands Calavera prints for people to paste (#1037). These tests
 * paste each quoted token into zsh and bash and check that the shell hands the command the token
 * unchanged.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";

import { quoteShellToken } from "../src/utils/shell.js";

/**
 * Whether a shell is installed, so a machine without it skips that shell's cases instead of
 * failing on a missing program.
 *
 * @param {string} shell
 */
function hasShell(shell) {
  try {
    execFileSync(shell, ["-c", "exit 0"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * The words a shell passes to a command for a pasted line, read back one per NUL byte.
 *
 * @param {{ shell: string, options: string[] }} shell The shell and its options.
 * @param {string} line
 */
function wordsAfterPaste({ shell, options }, line) {
  const output = execFileSync(shell, [...options, "-c", `printf '%s\\0' ${line}`], {
    encoding: "utf8",
    env: { HOME: "/home/calavera-test", PATH: process.env.PATH },
  });
  return output.split("\0").slice(0, -1);
}

// Each token holds characters that zsh or bash expands when they are not quoted, with the
// shell's default options or with the options named next to the token.
const expandingTokens = [
  // Tilde expansion: both shells replace a leading `~` with a home directory.
  "~",
  "~/project",
  "~root/project",
  "~+",
  // zsh's `=` expansion (the EQUALS option, on by default) replaces `=cmd` with the path of `cmd`.
  "=ls",
  "=printf",
  // After `=` or `:` in an assignment-shaped word, bash expands a tilde in an argument, and zsh
  // does with MAGIC_EQUAL_SUBST, which also applies `=` expansion there.
  "PATH=~/bin",
  "--config=~/calavera.config.json",
  "PATH=/usr/bin:~/bin",
  "--with==ls",
  "PATH=/usr/bin:=ls",
  // With EXTENDED_GLOB, zsh treats `^` as a pattern character anywhere in a word.
  "create-project-calavera@^6.2.0",
  "a^b",
];

// Tokens no shell expands stay unquoted, so the printed command stays as people would type it.
const plainTokens = [
  "create-project-calavera@6.2.1",
  "--config=calavera.config.json",
  "my-app",
  "./apps/web",
  "@scope/pkg",
  "a=b",
];

const shells = [
  { shell: "zsh", options: ["-f"] },
  { shell: "zsh", options: ["-f", "-o", "EXTENDED_GLOB", "-o", "MAGIC_EQUAL_SUBST"] },
  { shell: "bash", options: ["--norc", "--noprofile"] },
];

for (const shell of shells) {
  test(`${shell.shell} ${shell.options.join(" ")} receives every quoted token unchanged`, (t) => {
    if (!hasShell(shell.shell)) {
      t.skip(`${shell.shell} is not installed`);
      return;
    }

    for (const token of [...expandingTokens, ...plainTokens]) {
      assert.deepEqual(
        wordsAfterPaste(shell, quoteShellToken(token)),
        [token],
        `${quoteShellToken(token)} should reach the command as ${token}`,
      );
    }
  });
}

test("quoteShellToken quotes a token with a leading ~ or =, a ~ or ^ anywhere, or == or :=", () => {
  for (const token of expandingTokens) {
    assert.match(quoteShellToken(token), /^'.*'$/, token);
  }
});

test("quoteShellToken leaves a token no shell expands unquoted", () => {
  for (const token of plainTokens) {
    assert.equal(quoteShellToken(token), token);
  }
});

test("quoteShellToken escapes a single quote inside a quoted token", () => {
  assert.equal(quoteShellToken("it's"), `'it'\\''s'`);
});
