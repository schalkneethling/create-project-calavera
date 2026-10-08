// Issue #644: the managed lint:html wrapper, scripts/lint-html.mjs, exits 0
// when no HTML file matches, and otherwise runs html-validate with the same
// arguments and exit code. Each test copies the template into a temporary
// project and runs it directly with Node, without a shell or npm.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtempDisposable, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { packageDirectory } from "./installed-package.mjs";

const templatePath = fileURLToPath(new URL("../src/templates/lint-html.mjs", import.meta.url));

const validHtml = `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Valid</title>
  </head>
  <body>
    <p>Valid</p>
  </body>
</html>
`;

const invalidHtml = validHtml.replace("<p>Valid</p>", "<div></span>");

/**
 * Runs `callback` in a new temporary project that holds the wrapper at
 * scripts/lint-html.mjs.
 *
 * @param {(directory: string) => Promise<void>} callback
 */
async function inWrapperProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-lint-html-"));
  const directory = await realpath(project.path);
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "node_modules"));
  await copyFile(templatePath, join(directory, "scripts", "lint-html.mjs"));
  await callback(directory);
}

/**
 * Links the workspace's installed html-validate into `directory`. A junction
 * needs no extra privileges on Windows; other platforms ignore the type.
 *
 * @param {string} directory
 */
async function linkHtmlValidate(directory) {
  await symlink(
    await packageDirectory("html-validate"),
    join(directory, "node_modules", "html-validate"),
    "junction",
  );
  await writeFile(
    join(directory, ".htmlvalidate.json"),
    `${JSON.stringify({ extends: ["html-validate:recommended", "html-validate:document"] })}\n`,
  );
}

/**
 * Runs the wrapper with `args` and returns its exit code and output.
 *
 * @param {string} directory
 * @param {string[]} args
 * @param {string} [input] written to the wrapper's standard input
 */
function runWrapper(directory, args, input = "") {
  const result = spawnSync(process.execPath, [join("scripts", "lint-html.mjs"), ...args], {
    cwd: directory,
    encoding: "utf8",
    input,
    env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
  });
  return { code: result.status, output: `${result.stdout}${result.stderr}` };
}

test("the wrapper refuses to run without a pattern", async () => {
  await inWrapperProject(async (directory) => {
    await linkHtmlValidate(directory);
    const result = runWrapper(directory, []);

    assert.equal(result.code, 2, result.output);
    assert.match(result.output, /Pass the HTML files or patterns to validate/);
  });
});

test("the wrapper passes when no HTML file matches", async () => {
  await inWrapperProject(async (directory) => {
    await linkHtmlValidate(directory);
    const result = runWrapper(directory, ["**/*.html"]);

    assert.equal(result.code, 0, result.output);
    assert.match(
      result.output,
      /No files match \*\*\/\*\.html, so HTML Validate has nothing to check\./,
    );
  });
});

test("the wrapper fails on an HTML Validate error and passes valid HTML", async () => {
  await inWrapperProject(async (directory) => {
    await linkHtmlValidate(directory);
    await writeFile(join(directory, "index.html"), invalidHtml);
    const invalid = runWrapper(directory, ["**/*.html"]);

    assert.equal(invalid.code, 1, invalid.output);
    assert.match(invalid.output, /close-order/);

    await writeFile(join(directory, "index.html"), validHtml);
    const valid = runWrapper(directory, ["**/*.html"]);
    assert.equal(valid.code, 0, valid.output);
  });
});

test("with --stdin, the wrapper runs html-validate on the input instead of passing as empty", async () => {
  await inWrapperProject(async (directory) => {
    await linkHtmlValidate(directory);
    const invalid = runWrapper(directory, ["--stdin"], invalidHtml);

    assert.equal(invalid.code, 1, invalid.output);
    assert.match(invalid.output, /close-order/);
    assert.doesNotMatch(invalid.output, /nothing to check/);
  });
});

test("with --ext, the wrapper runs html-validate with the extensions it names", async () => {
  await inWrapperProject(async (directory) => {
    await linkHtmlValidate(directory);
    await writeFile(join(directory, "index.htm"), invalidHtml);
    const invalid = runWrapper(directory, ["--ext", "htm", "."]);

    assert.equal(invalid.code, 1, invalid.output);
    assert.match(invalid.output, /close-order/);
    assert.doesNotMatch(invalid.output, /nothing to check/);
  });
});

/**
 * Installs a stand-in html-validate whose CLI always finds one file, with the
 * given `bin` field and binary source, to exercise how the wrapper starts it.
 *
 * @param {string} directory
 * @param {unknown} bin
 * @param {string} [binSource]
 */
async function installStandIn(directory, bin, binSource) {
  const packagePath = join(directory, "node_modules", "html-validate");
  await mkdir(packagePath);
  await writeFile(
    join(packagePath, "package.json"),
    `${JSON.stringify({ name: "html-validate", type: "module", main: "index.js", bin })}\n`,
  );
  await writeFile(
    join(packagePath, "index.js"),
    'export class CLI {\n  async expandFiles() {\n    return ["index.html"];\n  }\n}\n',
  );
  if (binSource !== undefined) {
    await writeFile(join(packagePath, "cli.js"), binSource);
  }
}

test("the wrapper runs a binary named by a string bin field and keeps its exit code", async () => {
  await inWrapperProject(async (directory) => {
    await installStandIn(
      directory,
      "cli.js",
      'process.stdout.write(`stand-in ran ${process.argv.slice(2).join(" ")}\\n`);\nprocess.exitCode = 3;\n',
    );
    const result = runWrapper(directory, ["**/*.html"]);

    assert.equal(result.code, 3, result.output);
    assert.match(result.output, /stand-in ran \*\*\/\*\.html/);
  });
});

test("the wrapper explains a missing html-validate binary", async () => {
  await inWrapperProject(async (directory) => {
    await installStandIn(directory, undefined);
    const result = runWrapper(directory, ["**/*.html"]);

    assert.notEqual(result.code, 0, result.output);
    assert.match(
      result.output,
      /The installed html-validate package names no html-validate binary, so lint:html cannot run it\./,
    );
  });
});

test(
  "the wrapper names the signal that stopped html-validate and exits non-zero",
  { skip: process.platform === "win32" && "Windows does not report POSIX signals" },
  async () => {
    await inWrapperProject(async (directory) => {
      await installStandIn(
        directory,
        { "html-validate": "cli.js" },
        'process.kill(process.pid, "SIGTERM");\n',
      );
      const result = runWrapper(directory, ["**/*.html"]);

      assert.equal(result.code, 1, result.output);
      assert.match(result.output, /html-validate stopped on signal SIGTERM\./);
    });
  },
);
