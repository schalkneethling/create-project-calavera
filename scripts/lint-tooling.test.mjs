import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = new URL("../", import.meta.url);
const fromRoot = (path) => fileURLToPath(new URL(path, repositoryRoot));
const readJson = async (path) => JSON.parse(await readFile(fromRoot(path), "utf8"));

test("oxlint reads a configuration file it discovers on its own", async () => {
  assert.ok(
    existsSync(fromRoot(".oxlintrc.json")),
    `${fileURLToPath(repositoryRoot)} must hold a .oxlintrc.json, the only configuration name oxlint discovers without -c.`,
  );
  assert.equal(
    existsSync(fromRoot("oxlint.json")),
    false,
    "oxlint.json is never read and must not exist alongside .oxlintrc.json.",
  );

  const configuration = await readJson(".oxlintrc.json");

  assert.deepEqual(configuration.rules?.["no-console"], ["error", { allow: ["clear", "info"] }]);
  assert.equal(configuration.rules?.["no-regex-spaces"], "error");
  assert.equal(
    (configuration.plugins ?? []).includes("jsdoc"),
    false,
    "The jsdoc plugin stays off until reactivating its rules is decided.",
  );
});

test("the root lint script fails the build on a rule violation", async () => {
  const { scripts } = await readJson("package.json");

  assert.match(scripts.lint, /--deny-warnings/);
  assert.match(scripts["lint:fix"], /--deny-warnings/);
});

test("ESLint is gone from the repository's own tooling", async () => {
  const rootPackage = await readJson("package.json");

  assert.equal(
    Object.hasOwn(rootPackage.scripts, "lint:js"),
    false,
    `The lint:js script must not return: ${JSON.stringify(rootPackage.scripts)}`,
  );

  const dependencies = {
    ...rootPackage.dependencies,
    ...rootPackage.devDependencies,
  };

  for (const name of ["eslint", "@eslint/js", "globals"]) {
    assert.equal(
      Object.hasOwn(dependencies, name),
      false,
      `${name} serves no remaining configuration and must not be a root dependency.`,
    );
  }

  assert.equal(
    existsSync(fromRoot("eslint.config.js")),
    false,
    "eslint.config.js is removed; oxlint carries the rules it held.",
  );
});
