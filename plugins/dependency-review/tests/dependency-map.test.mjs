import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, it } from "node:test";

import {
  buildMap,
  computeFingerprint,
  extractScriptBlocks,
  formatText,
  parseMarkers,
  parseModuleReferences,
  parseStyleReferences,
  stripComments,
  toPackageName,
} from "../scripts/dependency-map.mjs";

/**
 * Asserts that every expected item appears in actual, in any order.
 *
 * @param {unknown[]} actual
 * @param {unknown[]} expected
 */
function assertContainsAll(actual, expected) {
  for (const item of expected) {
    assert.ok(
      actual.some((candidate) => {
        try {
          assert.deepEqual(candidate, item);
          return true;
        } catch {
          return false;
        }
      }),
      `Expected ${JSON.stringify(item)} in ${JSON.stringify(actual)}`,
    );
  }
}

describe("stripComments", () => {
  it("removes line comments but keeps the code before them", () => {
    const result = stripComments("import a from 'a' // import b from 'b'\n");
    assert.ok(result.includes("import a from 'a'"));
    assert.ok(!result.includes("'b'"));
  });

  it("removes block comments and preserves the newline count", () => {
    const source = "/* import x from 'x';\nimport y from 'y'; */\nconst z = 1;";
    const result = stripComments(source);
    assert.ok(!result.includes("'x'"));
    assert.ok(!result.includes("'y'"));
    assert.equal(result.split("\n").length, source.split("\n").length);
  });

  it("keeps comment-like sequences inside strings", () => {
    const result = stripComments("const u = 'https://example.com/a'; import q from 'q';");
    assert.ok(result.includes("https://example.com/a"));
    assert.ok(result.includes("import q from 'q'"));
  });

  it("keeps comment-like sequences inside template literals", () => {
    const result = stripComments('const t = `see http://x.test`; import q from "q";');
    assert.ok(result.includes("http://x.test"));
    assert.ok(result.includes('import q from "q"'));
  });
});

describe("parseModuleReferences", () => {
  /** @param {string} source */
  const only = (source) => parseModuleReferences(stripComments(source));

  it("parses a default import", () => {
    assert.deepEqual(only("import React from 'react';"), [
      { specifier: "react", symbols: ["default"] },
    ]);
  });

  it("parses named imports, aliases, and inline type modifiers", () => {
    assert.deepEqual(only("import { a, b as c, type D } from 'lib';"), [
      { specifier: "lib", symbols: ["a", "b", "D"] },
    ]);
  });

  it("parses default plus named imports", () => {
    assert.deepEqual(only("import React, { useState } from 'react';"), [
      { specifier: "react", symbols: ["useState", "default"] },
    ]);
  });

  it("parses namespace imports", () => {
    assert.deepEqual(only("import * as ns from 'lib';"), [{ specifier: "lib", symbols: ["*"] }]);
  });

  it("parses multi-line named imports", () => {
    const source = "import {\n  one,\n  two,\n} from 'multi';";
    assert.deepEqual(only(source), [{ specifier: "multi", symbols: ["one", "two"] }]);
  });

  it("parses type-only imports", () => {
    assert.deepEqual(only("import type { Thing } from 'types-lib';"), [
      { specifier: "types-lib", symbols: ["Thing"] },
    ]);
  });

  it("parses side-effect imports with no symbols", () => {
    assert.deepEqual(only("import 'reset-css';"), [{ specifier: "reset-css", symbols: [] }]);
  });

  it("parses re-exports", () => {
    const refs = only(
      "export { a } from 'one';\nexport * from 'two';\nexport * as three from 'three';",
    );
    assertContainsAll(refs, [
      { specifier: "one", symbols: ["a"] },
      { specifier: "two", symbols: ["*"] },
      { specifier: "three", symbols: ["*"] },
    ]);
  });

  it("parses dynamic imports", () => {
    assert.deepEqual(only("const m = await import('lazy');"), [
      { specifier: "lazy", symbols: ["(dynamic)"] },
    ]);
  });

  it("parses require calls, with and without destructuring", () => {
    const refs = only(
      "const { a, b: renamed } = require('destructured');\nconst whole = require('whole');\nrequire('bare');",
    );
    assertContainsAll(refs, [
      { specifier: "destructured", symbols: ["a", "b"] },
      { specifier: "whole", symbols: ["(require)"] },
      { specifier: "bare", symbols: ["(require)"] },
    ]);
    assert.equal(refs.length, 3);
  });

  it("ignores commented-out imports", () => {
    assert.deepEqual(only("// import gone from 'gone';\n/* import also from 'also'; */"), []);
  });

  it('does not let a dynamic import swallow a later unrelated "from" string', () => {
    const source = "const m = await import('lazy');\nconst msg = `data from \"somewhere\"`;";
    assert.deepEqual(only(source), [{ specifier: "lazy", symbols: ["(dynamic)"] }]);
  });
});

describe("parseStyleReferences", () => {
  it("finds @import, @plugin, @use, and @forward specifiers", () => {
    const css =
      '@import "tailwindcss";\n@plugin "@tailwindcss/typography";\n@use "sass:math";\n@forward "~legacy-lib/mixins";';
    assertContainsAll(parseStyleReferences(css), [
      { specifier: "tailwindcss", symbols: [] },
      { specifier: "@tailwindcss/typography", symbols: [] },
      { specifier: "sass:math", symbols: [] },
      { specifier: "legacy-lib/mixins", symbols: [] },
    ]);
  });

  it("supports url() and single quotes", () => {
    assert.deepEqual(parseStyleReferences("@import url('normalize.css');"), [
      { specifier: "normalize.css", symbols: [] },
    ]);
  });
});

describe("toPackageName", () => {
  for (const [input, expected] of [
    ["react", "react"],
    ["react/jsx-runtime", "react"],
    ["@scope/pkg", "@scope/pkg"],
    ["@scope/pkg/deep/path", "@scope/pkg"],
    ["lodash/debounce", "lodash"],
  ]) {
    it(`maps ${input} to ${expected}`, () => {
      assert.equal(toPackageName(input), expected);
    });
  }

  for (const input of [
    "./local",
    "../up",
    "/absolute",
    "node:fs",
    "#internal",
    "~/alias",
    "@/components/x",
    "https://cdn.test/x.js",
    "sass:math",
  ]) {
    it(`returns null for ${input}`, () => {
      assert.equal(toPackageName(input), null);
    });
  }
});

describe("parseMarkers", () => {
  it("parses all fields", () => {
    const text =
      "line one\n// WORKAROUND(some-lib): Compensates for broken focus | upstream: https://github.com/o/r/issues/1 | remove-when: >=2.4.1\n";
    assert.deepEqual(parseMarkers(text), [
      {
        package: "some-lib",
        description: "Compensates for broken focus",
        upstream: "https://github.com/o/r/issues/1",
        removeWhen: ">=2.4.1",
        line: 2,
      },
    ]);
  });

  it("allows description only", () => {
    assert.deepEqual(parseMarkers("// WORKAROUND(pkg): just a note"), [
      { package: "pkg", description: "just a note", upstream: null, removeWhen: null, line: 1 },
    ]);
  });

  it("supports scoped package names", () => {
    assert.equal(parseMarkers("# WORKAROUND(@scope/pkg): scoped")[0]?.package, "@scope/pkg");
  });

  it("strips closing comment tokens", () => {
    assert.equal(parseMarkers("<!-- WORKAROUND(pkg): in html -->")[0]?.description, "in html");
    assert.equal(
      parseMarkers("/* WORKAROUND(pkg): in css | remove-when: >=1.0.0 */")[0]?.removeWhen,
      ">=1.0.0",
    );
  });

  it("handles CRLF line endings", () => {
    assert.equal(parseMarkers("a\r\n// WORKAROUND(pkg): crlf\r\n")[0]?.description, "crlf");
  });

  it("returns an empty list when there are no markers", () => {
    assert.deepEqual(parseMarkers("nothing here"), []);
  });
});

describe("computeFingerprint", () => {
  const base = [
    { file: "src/a.js", symbols: ["x", "y"] },
    { file: "src/b.js", symbols: ["x"] },
  ];

  it("is a 12 character hex string", () => {
    assert.match(computeFingerprint(base), /^[0-9a-f]{12}$/);
  });

  it("does not depend on ordering", () => {
    assert.equal(computeFingerprint([...base].reverse()), computeFingerprint(base));
    assert.equal(
      computeFingerprint([{ file: "src/a.js", symbols: ["y", "x"] }, base[1]]),
      computeFingerprint(base),
    );
  });

  it("changes when a file or a symbol is added", () => {
    const original = computeFingerprint(base);
    assert.notEqual(computeFingerprint([...base, { file: "src/c.js", symbols: [] }]), original);
    assert.notEqual(
      computeFingerprint([{ file: "src/a.js", symbols: ["x", "y", "z"] }, base[1]]),
      original,
    );
  });

  it('returns "none" when nothing uses the package', () => {
    assert.equal(computeFingerprint([]), "none");
  });
});

describe("extractScriptBlocks", () => {
  it("returns plain code files unchanged", () => {
    assert.deepEqual(extractScriptBlocks("const a = 1;", ".js"), ["const a = 1;"]);
  });

  it("extracts script blocks from Vue and Svelte files", () => {
    const vue =
      "<template><p>Don't</p></template>\n<script setup>\nimport { ref } from 'vue'\n</script>";
    const joined = extractScriptBlocks(vue, ".vue").join("");
    assert.ok(joined.includes("import { ref } from 'vue'"));
    assert.ok(!joined.includes("template"));
  });

  it("extracts Astro frontmatter and script tags", () => {
    const astro =
      "---\nimport Layout from 'layout-lib';\n---\n<html></html>\n<script>import 'client-lib';</script>";
    const joined = extractScriptBlocks(astro, ".astro").join("\n");
    assert.ok(joined.includes("import Layout from 'layout-lib'"));
    assert.ok(joined.includes("import 'client-lib'"));
  });
});

describe("buildMap (integration)", () => {
  /** @type {string} */
  let root;

  /**
   * @param {string} relativePath
   * @param {string} contents
   */
  const write = (relativePath, contents) => {
    const full = join(root, relativePath);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents);
  };

  before(() => {
    root = mkdtempSync(join(tmpdir(), "depmap-"));
    write(
      "package.json",
      JSON.stringify({
        name: "fixture",
        scripts: { test: "vitest run", lint: "eslint .", start: "node server.js" },
        dependencies: { react: "^18.3.0", lodash: "^4.17.21" },
        devDependencies: { vitest: "^2.0.0", "unused-lib": "^1.0.0", "@types/node": "^22.0.0" },
      }),
    );
    write(
      "src/a.js",
      "import { useState } from 'react';\nimport _ from 'lodash';\n_.debounce(() => {}, 10);\n",
    );
    write(
      "src/b.ts",
      "import { useState, useEffect } from 'react';\n// WORKAROUND(react): batch fix | upstream: https://example.test/1 | remove-when: >=18.3.1\n",
    );
    write("src/c.js", "import { ghost } from 'not-declared';\nimport fs from 'node:fs';\n");
    write("src/d.js", "const lazy = await import('lodash');\n");
    write(
      "vitest.config.ts",
      "import { defineConfig } from 'vitest/config';\nexport default defineConfig({});\n",
    );
    write("node_modules/react/index.js", "import { shouldBeIgnored } from 'react';\n");
    write("dist/out.js", "import { alsoIgnored } from 'react';\n");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /**
   * @param {ReturnType<typeof buildMap>} map
   * @param {string} name
   */
  const find = (map, name) => {
    const entry = map.packages.find((pkg) => pkg.name === name);
    assert.ok(entry, `${name} is not in the map`);
    return entry;
  };

  it("maps files, symbol counts, and declared sections for a package", () => {
    const map = buildMap({ root, packages: ["react"] });
    const react = find(map, "react");
    assert.equal(map.packages.length, 1);
    assert.deepEqual(react.files.toSorted(), ["src/a.js", "src/b.ts"]);
    assert.deepEqual(react.symbols, { useState: 2, useEffect: 1 });
    assert.deepEqual(react.declared, [
      { manifest: "package.json", section: "dependencies", range: "^18.3.0" },
    ]);
    assert.match(react.fingerprint, /^[0-9a-f]{12}$/);
  });

  it("ignores node_modules and build output", () => {
    const react = find(buildMap({ root, packages: ["react"] }), "react");
    assert.ok(!react.files.includes("node_modules/react/index.js"));
    assert.ok(!react.files.includes("dist/out.js"));
  });

  it("attaches WORKAROUND markers with file and line to the right package", () => {
    const react = find(buildMap({ root, packages: ["react"] }), "react");
    assert.deepEqual(react.markers, [
      {
        package: "react",
        file: "src/b.ts",
        line: 2,
        description: "batch fix",
        upstream: "https://example.test/1",
        removeWhen: ">=18.3.1",
      },
    ]);
  });

  it("flags files that import a package opaquely (default, namespace, or dynamic)", () => {
    const lodash = find(buildMap({ root, packages: ["lodash"] }), "lodash");
    assert.deepEqual(lodash.opaqueFiles, ["src/a.js", "src/d.js"]);
    assert.deepEqual(lodash.symbols, {});
  });

  it("does not match @types packages against package.json scripts", () => {
    const types = find(buildMap({ root, packages: ["@types/node"] }), "@types/node");
    assert.deepEqual(types.scripts, []);
  });

  it("finds config files and package.json scripts for tooling packages", () => {
    const vitest = find(buildMap({ root, packages: ["vitest"] }), "vitest");
    assert.deepEqual(vitest.configFiles, ["vitest.config.ts"]);
    assert.deepEqual(vitest.scripts, ["test"]);
    assert.deepEqual(vitest.files, ["vitest.config.ts"]);
    assert.deepEqual(vitest.subpaths, ["vitest/config"]);
  });

  it("reports declared but unused packages with zero files", () => {
    const unused = find(buildMap({ root, packages: ["unused-lib"] }), "unused-lib");
    assert.deepEqual(unused.files, []);
    assert.equal(unused.fingerprint, "none");
    assert.equal(unused.declared.length, 1);
  });

  it("reports requested packages that are not direct dependencies", () => {
    const transitive = find(buildMap({ root, packages: ["left-pad"] }), "left-pad");
    assert.deepEqual(transitive.declared, []);
    assert.deepEqual(transitive.files, []);
  });

  it("does not report undeclared imports when no filter is given", () => {
    const names = buildMap({ root }).packages.map((pkg) => pkg.name);
    for (const name of ["react", "lodash", "vitest", "unused-lib"]) {
      assert.ok(names.includes(name), `${name} is missing from ${names.join(", ")}`);
    }
    assert.ok(!names.includes("not-declared"));
    assert.ok(!names.includes("fs"));
  });

  it("formats compact text and truncates long file lists (see also formatText below)", () => {
    const map = buildMap({ root, packages: ["react"] });
    const text = formatText(map, { maxFiles: 1 });
    for (const part of [
      "react",
      "^18.3.0",
      "useState (2 files)",
      "(+1 more)",
      "WORKAROUND(react)",
      "remove-when: >=18.3.1",
    ]) {
      assert.ok(text.includes(part), `Expected "${part}" in:\n${text}`);
    }
  });
});

describe("buildMap errors", () => {
  it("throws a clear error when the root directory does not exist", () => {
    assert.throws(
      () => buildMap({ root: join(tmpdir(), "depmap-definitely-missing-dir") }),
      /does not exist/,
    );
  });
});

describe("formatText", () => {
  /** @param {Record<string, unknown>} overrides */
  const packageEntry = (overrides) => ({
    name: "x",
    declared: [],
    files: [],
    symbols: {},
    opaqueFiles: [],
    subpaths: [],
    configFiles: [],
    scripts: [],
    fingerprint: "none",
    markers: [],
    ...overrides,
  });
  /** @param {ReturnType<typeof packageEntry>} entry */
  const wrap = (entry) => ({
    root: "/r",
    mode: "git",
    filesScanned: 1,
    packages: [entry],
    otherMarkers: [],
  });

  it("collapses identical declarations across many manifests", () => {
    const declared = Array.from({ length: 12 }, (_, index) => ({
      manifest: index === 0 ? "package.json" : `templates/t${index}/package.json`,
      section: "devDependencies",
      range: "^1.0.0",
    }));
    const text = formatText(wrap(packageEntry({ declared })));
    assert.ok(text.includes("devDependencies ^1.0.0 (12 manifests)"));
    assert.ok(!text.includes("templates/t5"));
  });

  it("does not repeat the file list when every import is opaque", () => {
    const files = ["a.js", "b.js"];
    const text = formatText(wrap(packageEntry({ files, opaqueFiles: files, fingerprint: "abc" })));
    assert.ok(text.includes("all imports are opaque"));
    assert.equal(text.match(/a\.js/g)?.length, 1);
  });
});
