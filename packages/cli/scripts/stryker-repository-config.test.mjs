// Checks this repository's own `stryker.config.mjs`, which mutation-tests the CLI package. It is not
// the `stryker.config.json` that the stryker integration writes into projects; the
// stryker-integration and stryker-node-test files cover that one.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import Ajv from "ajv";
import config from "../../../stryker.config.mjs";

test("the repository's Stryker config is valid under the installed @stryker-mutator/core schema", async () => {
  const schema = JSON.parse(
    await readFile(
      new URL(
        "../../../node_modules/@stryker-mutator/core/schema/stryker-schema.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const ajv = new Ajv({ allErrors: true, allowUnionTypes: true });
  // Stryker's schema annotates enums with this keyword for its own type generation.
  ajv.addKeyword("tsEnumNames");
  const validate = ajv.compile(schema);

  assert.equal(validate(config), true, JSON.stringify(validate.errors, null, 2));
});

test("the tap runner lets a failing test file finish instead of killing it", () => {
  // With forceBail, the tap runner kills a test process at its first failure. The process then
  // writes Stryker's result file into its current directory, which is a temporary project when a
  // test has called process.chdir(), so the runner cannot find the file and reports the mutant as
  // a runtime error instead of killed (#985).
  assert.equal(config.tap.forceBail, false);
});
