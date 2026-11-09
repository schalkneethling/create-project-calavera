// A test integration that declares ignore lines (ADR-0016), so the ignore-line tests do not depend
// on the lines a real entry such as Stryker (#734) declares. Importing this module adds it to the
// catalog of the importing process: a test file imports it, and a CLI child process loads it with
// `node --import`.
import { integrationCatalog } from "../src/catalog.js";

export const fixture = {
  id: "ignore-fixture",
  label: "Ignore fixture",
  summary: "A test integration that declares ignore lines.",
  homepage: "https://example.com",
  group: "Test",
  platform: "generic",
  status: "optional",
  dependencies: [],
  ignore: {
    gitignore: [".fixture-tmp/", "reports/fixture/"],
    htmlValidateIgnore: ["reports/fixture/"],
  },
};

integrationCatalog.push(/** @type {any} */ (fixture));
