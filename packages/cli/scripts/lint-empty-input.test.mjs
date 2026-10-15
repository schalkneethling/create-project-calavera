// Issue #644: the generated lint:styles, lint:styles:fix, and lint:html
// scripts pass when there are no CSS or HTML files to check, and still fail
// on a real Stylelint or HTML Validate error. A recipe option leaves lint:html
// out of quality, and a later apply keeps both settings.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { applyRecipeObject } from "../src/index.js";
import { buildRecipe, composeRecipe, validateRecipe } from "../src/recipe.js";
import { packageDirectory } from "./installed-package.mjs";

const execFileAsync = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/index.js", import.meta.url));
const wrapperTemplatePath = fileURLToPath(
  new URL("../src/templates/lint-html.mjs", import.meta.url),
);

const lintStyles = 'stylelint "**/*.{css,scss}" --allow-empty-input';
const lintStylesFix = 'stylelint "**/*.{css,scss}" --allow-empty-input --fix';
const lintHtml = 'node scripts/lint-html.mjs "**/*.html"';

const applyOptions = {
  json: true,
  noInstall: true,
  assumeYes: true,
  writeConfig: true,
  config: "calavera.config.json",
};

/** @param {Record<string, unknown>} [htmlValidateOptions] */
function recipeFor(htmlValidateOptions) {
  return buildRecipe(
    "default",
    ["stylelint", "stylelint-standard", "html-validate"],
    "npm",
    [],
    htmlValidateOptions ? { "html-validate": htmlValidateOptions } : undefined,
  );
}

/**
 * Runs `callback` in a new temporary project that holds `manifest` as
 * package.json, with the process working directory set to it, as apply reads
 * the project from `process.cwd()`.
 *
 * @param {(directory: string) => Promise<void>} callback
 * @param {unknown} [manifest]
 */
async function inProject(callback, manifest = { name: "lint-empty-input", scripts: {} }) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-lint-empty-input-"));
  const directory = await realpath(project.path);
  const originalDirectory = process.cwd();
  process.chdir(directory);

  try {
    await writeFile("package.json", `${JSON.stringify(manifest, null, 2)}\n`);
    await callback(directory);
  } finally {
    process.chdir(originalDirectory);
  }
}

async function packageScripts() {
  return JSON.parse(await readFile("package.json", "utf8")).scripts;
}

test("lint:styles and lint:styles:fix pass --allow-empty-input to Stylelint", async () => {
  await inProject(async () => {
    await applyRecipeObject(recipeFor(), applyOptions);
    const scripts = await packageScripts();

    assert.equal(scripts["lint:styles"], lintStyles);
    assert.equal(scripts["lint:styles:fix"], lintStylesFix);
  });
});

test("lint:html runs the HTML Validate wrapper, which apply writes and records as managed", async () => {
  await inProject(async () => {
    const result = await applyRecipeObject(recipeFor(), applyOptions);
    const scripts = await packageScripts();
    const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));

    assert.equal(scripts["lint:html"], lintHtml);
    assert.equal(
      await readFile("scripts/lint-html.mjs", "utf8"),
      await readFile(wrapperTemplatePath, "utf8"),
    );
    assert.ok(
      result.changes.some(
        ({ path, ownership }) => path === "scripts/lint-html.mjs" && ownership === "calavera",
      ),
    );
    assert.ok(state.managedFiles.some(({ path }) => path === "scripts/lint-html.mjs"));
  });
});

test("doctor reports a missing HTML Validate wrapper", async () => {
  await inProject(async () => {
    await applyRecipeObject(recipeFor(), applyOptions);
    await rm("scripts/lint-html.mjs");

    const { stdout } = await execFileAsync(process.execPath, [cliPath, "doctor", "--json"], {
      env: { ...process.env, NO_COLOR: "1" },
    });

    assert.ok(
      JSON.parse(stdout).issues.some(
        ({ message }) =>
          message ===
          "Missing managed file: scripts/lint-html.mjs. Run create-project-calavera apply to regenerate managed files.",
      ),
      stdout,
    );
  });
});

test("the html-validate quality option leaves lint:html out of quality and keeps the script", async () => {
  await inProject(async () => {
    const result = await applyRecipeObject(recipeFor({ quality: false }), applyOptions);
    const scripts = await packageScripts();
    const packageChange = result.changes.find(({ path }) => path === "package.json");

    assert.equal(scripts.quality, "npm run lint:styles");
    assert.equal(scripts["lint:html"], lintHtml);
    assert.deepEqual(packageChange.omittedQualitySteps, [
      {
        step: "lint:html",
        reason:
          'the recipe sets integrationOptions["html-validate"].quality to false, so quality does not validate HTML files.',
      },
    ]);
  });
});

test("quality keeps lint:html when the html-validate quality option is true or absent", async () => {
  for (const options of [undefined, { quality: true }]) {
    await inProject(async () => {
      await applyRecipeObject(recipeFor(options), applyOptions);

      assert.equal((await packageScripts()).quality, "npm run lint:styles && npm run lint:html");
    });
  }
});

test("a second apply and dry run keep both settings and report nothing to change", async () => {
  await inProject(async () => {
    await applyRecipeObject(recipeFor({ quality: false }), applyOptions);
    const firstScripts = await packageScripts();

    const reapplied = await applyRecipeObject(recipeFor({ quality: false }), applyOptions);
    assert.ok(reapplied.changes.every(({ type }) => type === "unchanged"));
    assert.deepEqual(reapplied.scriptChanges, []);
    assert.deepEqual(await packageScripts(), firstScripts);
    assert.equal(firstScripts.quality, "npm run lint:styles");
    assert.equal(firstScripts["lint:styles"], lintStyles);

    // The CLI reads the recipe that the first apply wrote to calavera.config.json.
    const { stdout } = await execFileAsync(process.execPath, [cliPath, "apply", "--dry-run"], {
      env: { ...process.env, NO_COLOR: "1" },
    });

    assert.match(stdout, /Nothing to change: the project already matches this recipe\./);
    assert.doesNotMatch(stdout, /Would (write|update|change|add)/);
    assert.ok(
      stdout
        .split("\n")
        .some((line) =>
          line.endsWith(
            'Would omit lint:html from script quality: the recipe sets integrationOptions["html-validate"].quality to false, so quality does not validate HTML files.',
          ),
        ),
      stdout,
    );
  });
});

test("a dry run on a project an earlier release applied shows each changed lint script", async () => {
  const earlierScripts = {
    "lint:styles": 'stylelint "**/*.{css,scss}"',
    "lint:styles:fix": 'stylelint "**/*.{css,scss}" --fix',
    "lint:html": 'html-validate "**/*.html"',
    quality: "npm run lint:styles && npm run lint:html",
  };

  await inProject(
    async () => {
      await writeFile(
        "calavera.config.json",
        `${JSON.stringify(recipeFor({ quality: false }), null, 2)}\n`,
      );
      const { stdout } = await execFileAsync(process.execPath, [cliPath, "apply", "--dry-run"], {
        env: { ...process.env, NO_COLOR: "1" },
      });
      const lines = stdout.split("\n");

      for (const expected of [
        'Would change script lint:styles from "stylelint \\"**/*.{css,scss}\\"" to "stylelint \\"**/*.{css,scss}\\" --allow-empty-input"',
        'Would change script lint:styles:fix from "stylelint \\"**/*.{css,scss}\\" --fix" to "stylelint \\"**/*.{css,scss}\\" --allow-empty-input --fix"',
        'Would change script lint:html from "html-validate \\"**/*.html\\"" to "node scripts/lint-html.mjs \\"**/*.html\\""',
        'Would change script quality from "npm run lint:styles && npm run lint:html" to "npm run lint:styles"',
      ]) {
        assert.ok(
          lines.some((line) => line.endsWith(expected)),
          `missing ${expected}\n${stdout}`,
        );
      }
    },
    { name: "earlier-release", scripts: earlierScripts },
  );
});

const htmlOnlyRecipe = buildRecipe("minimal", ["html-validate"], "npm", [], {
  "html-validate": { quality: false },
});
const htmlLeftOutStep =
  'Would omit lint:html from script quality: the recipe sets integrationOptions["html-validate"].quality to false, so quality does not validate HTML files.';
const htmlOnlyQualityOmission =
  'Would omit script quality: quality was requested, but integrationOptions["html-validate"].quality leaves out lint:html, the only generated script quality would run, so Calavera does not generate quality.';

/** @param {string[]} args */
async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], {
    env: { ...process.env, NO_COLOR: "1" },
  });
  return stdout.split("\n");
}

/**
 * @param {string[]} lines
 * @param {string} expected
 */
function assertLine(lines, expected) {
  assert.ok(
    lines.some((line) => line.endsWith(expected)),
    `missing ${expected}\n${lines.join("\n")}`,
  );
}

test("with only lint:html left out, apply removes a quality an earlier release wrote, and a second apply changes nothing", async () => {
  await inProject(
    async () => {
      await writeFile("calavera.config.json", `${JSON.stringify(htmlOnlyRecipe, null, 2)}\n`);
      const dryRunLines = await runCli(["apply", "--dry-run"]);

      assertLine(dryRunLines, 'Would remove script quality: "npm run lint:html"');
      assertLine(dryRunLines, htmlOnlyQualityOmission);
      assertLine(dryRunLines, htmlLeftOutStep);
      assert.equal((await packageScripts()).quality, "npm run lint:html");

      const applied = await applyRecipeObject(htmlOnlyRecipe, applyOptions);
      const scripts = await packageScripts();
      const packageChange = applied.changes.find(({ path }) => path === "package.json");

      assert.equal(Object.hasOwn(scripts, "quality"), false);
      assert.equal(scripts["lint:html"], lintHtml);
      assert.equal(packageChange.removedQualityScript, "npm run lint:html");
      assert.deepEqual(packageChange.omittedQualitySteps, [
        {
          step: "lint:html",
          reason:
            'the recipe sets integrationOptions["html-validate"].quality to false, so quality does not validate HTML files.',
        },
      ]);

      const reapplied = await applyRecipeObject(htmlOnlyRecipe, applyOptions);
      assert.ok(reapplied.changes.every(({ type }) => type === "unchanged"));
      assert.equal(Object.hasOwn(await packageScripts(), "quality"), false);

      const secondDryRunLines = await runCli(["apply", "--dry-run"]);
      assertLine(secondDryRunLines, "Nothing to change: the project already matches this recipe.");
      assertLine(secondDryRunLines, htmlOnlyQualityOmission);
      assert.equal(
        secondDryRunLines.some((line) => line.includes("Would remove script quality")),
        false,
      );
    },
    {
      name: "html-only",
      scripts: { "lint:html": 'html-validate "**/*.html"', quality: "npm run lint:html" },
    },
  );
});

test("with only lint:html left out, apply keeps a quality of the user's own and says so", async () => {
  const userQuality = "npm run lint:html && npm test";

  await inProject(
    async () => {
      await writeFile("calavera.config.json", `${JSON.stringify(htmlOnlyRecipe, null, 2)}\n`);
      const dryRunLines = await runCli(["apply", "--dry-run"]);

      assertLine(
        dryRunLines,
        `${htmlOnlyQualityOmission} package.json keeps its quality script, "${userQuality}", because Calavera did not write that value.`,
      );
      assert.equal(
        dryRunLines.some((line) => line.includes("Would remove script quality")),
        false,
      );

      await applyRecipeObject(htmlOnlyRecipe, applyOptions);
      assert.equal((await packageScripts()).quality, userQuality);
    },
    { name: "html-only-user-quality", scripts: { quality: userQuality } },
  );
});

test("quality with no generated script to run keeps its earlier reason", async () => {
  await inProject(async () => {
    const result = await applyRecipeObject(
      buildRecipe("minimal", ["editorconfig"], "npm"),
      applyOptions,
    );
    const packageChange = result.changes.find(({ path }) => path === "package.json");

    assert.deepEqual(
      packageChange.omittedScripts.find(({ script }) => script === "quality"),
      {
        script: "quality",
        reason: "quality was requested but no generated scripts are available to aggregate.",
      },
    );
    assert.equal(packageChange.removedQualityScript, undefined);
  });
});

test("the html-validate options accept only a boolean quality field on a selected html-validate", () => {
  // Only the non-default choice is recorded, so a recipe that keeps lint:html
  // in quality stays valid for a CLI release that predates the option.
  assert.equal(recipeFor({}).integrationOptions, undefined);
  assert.equal(recipeFor({ quality: true }).integrationOptions, undefined);
  assert.deepEqual(
    composeRecipe({
      profile: "default",
      tools: ["html-validate"],
      integrationOptions: { "html-validate": { quality: false } },
    }).integrationOptions,
    { "html-validate": { quality: false } },
  );
  assert.throws(
    () => recipeFor({ quality: "no" }),
    /integrationOptions\.html-validate\.quality must be a boolean\./,
  );
  assert.throws(
    () => recipeFor({ quality: false, ignore: true }),
    /Unknown integrationOptions\.html-validate fields: ignore\./,
  );
  assert.throws(
    () =>
      validateRecipe({
        ...buildRecipe("default", ["stylelint"], "npm"),
        integrationOptions: { "html-validate": { quality: false } },
      }),
    /integrationOptions\.html-validate requires the html-validate integration\./,
  );
});

/**
 * Links the workspace's installed packages into `directory`, so the
 * generated scripts run the real tools without a network install. The
 * Stylelint binary is linked into node_modules/.bin, where `npm run` finds it.
 *
 * @param {string} directory
 */
async function linkInstalledTools(directory) {
  const bin = join(directory, "node_modules", ".bin");
  await mkdir(bin, { recursive: true });

  for (const name of ["stylelint", "stylelint-config-standard", "html-validate"]) {
    await symlink(await packageDirectory(name), join(directory, "node_modules", name), "dir");
  }

  const stylelintDirectory = await packageDirectory("stylelint");
  const { bin: stylelintBin } = JSON.parse(
    await readFile(join(stylelintDirectory, "package.json"), "utf8"),
  );
  await symlink(join(stylelintDirectory, stylelintBin.stylelint), join(bin, "stylelint"));
}

/**
 * Runs the generated quality script with npm and returns its exit code and
 * combined output.
 *
 * @param {string} directory
 */
async function runQuality(directory) {
  try {
    const { stdout, stderr } = await execFileAsync("npm", ["run", "quality"], {
      cwd: directory,
      env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0", npm_config_update_notifier: "false" },
    });
    return { code: 0, output: `${stdout}${stderr}` };
  } catch (error) {
    return { code: error.code, output: `${error.stdout}${error.stderr}` };
  }
}

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

test(
  "quality runs the real Stylelint and HTML Validate: empty input passes, a real error fails",
  { skip: process.platform === "win32" && "links the Stylelint binary with a POSIX symlink" },
  async () => {
    await inProject(async (directory) => {
      await applyRecipeObject(recipeFor(), applyOptions);
      await linkInstalledTools(directory);

      const empty = await runQuality(directory);
      assert.equal(empty.code, 0, empty.output);
      assert.match(
        empty.output,
        /No files match \*\*\/\*\.html, so HTML Validate has nothing to check\./,
      );

      await writeFile("broken.css", "a { colr: red; }\n");
      const brokenCss = await runQuality(directory);
      assert.notEqual(brokenCss.code, 0, brokenCss.output);
      assert.match(brokenCss.output, /property-no-unknown/);

      await writeFile("broken.css", "a { color: red; }\n");
      await writeFile("index.html", invalidHtml);
      const brokenHtml = await runQuality(directory);
      assert.notEqual(brokenHtml.code, 0, brokenHtml.output);
      assert.match(brokenHtml.output, /close-order/);

      await writeFile("index.html", validHtml);
      const valid = await runQuality(directory);
      assert.equal(valid.code, 0, valid.output);

      // .htmlvalidateignore lists coverage/, so its HTML does not count as input.
      await rm("index.html");
      await mkdir("coverage");
      await writeFile(join("coverage", "index.html"), invalidHtml);
      const ignoredOnly = await runQuality(directory);
      assert.equal(ignoredOnly.code, 0, ignoredOnly.output);
      assert.match(ignoredOnly.output, /HTML Validate has nothing to check/);
    });
  },
);
