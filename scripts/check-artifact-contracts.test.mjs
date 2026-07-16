import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

async function readProjectJson(path) {
  return JSON.parse(await readFile(new URL(`../${path}`, import.meta.url), "utf8"));
}

const ajv = new Ajv2020({ allErrors: true, validateFormats: false });
const manifestSchema = await readProjectJson("schemas/calavera-artifact.schema.json");
const lockSchema = await readProjectJson("schemas/artifacts-lock.schema.json");

function assertValid(validate, value) {
  assert.equal(validate(value), true, ajv.errorsText(validate.errors));
}

function assertInvalid(validate, value) {
  assert.equal(validate(value), false, "Expected contract validation to fail");
}

test("artifact schemas are valid draft 2020-12 schemas", () => {
  assert.equal(ajv.validateSchema(manifestSchema), true, ajv.errorsText(ajv.errors));
  assert.equal(ajv.validateSchema(lockSchema), true, ajv.errorsText(ajv.errors));
});

test("artifact manifest accepts representative skill, hook, and agent packages", () => {
  const validate = ajv.compile(manifestSchema);

  assertValid(validate, {
    schemaVersion: 1,
    id: "skill-frontend-engineering",
    type: "skill",
    displayName: "Frontend engineering",
    payload: "artifact",
    compatibility: { calavera: ">=2.2.0 <3" },
  });
  assertValid(validate, {
    schemaVersion: 1,
    id: "hook-block-dangerous-commands",
    type: "hook",
    displayName: "Block dangerous commands",
    payload: "artifact",
    targets: ["claude-code"],
    compatibility: { calavera: ">=2.2.0 <3" },
  });
  assertValid(validate, {
    schemaVersion: 1,
    id: "agent-technical-devils-advocate",
    type: "agent",
    displayName: "Technical devil's advocate",
    payload: "artifact.md",
    targets: ["claude-code", "codex"],
    compatibility: { calavera: ">=2.2.0 <3" },
  });
});

test("artifact manifest rejects mismatched types, unsafe payloads, and missing targets", () => {
  const validate = ajv.compile(manifestSchema);

  assertInvalid(validate, {
    schemaVersion: 1,
    id: "hook-block-dangerous-commands",
    type: "skill",
    displayName: "Mismatch",
    payload: "artifact",
    compatibility: { calavera: ">=2.2.0" },
  });
  for (const payload of [".", "./payload", "dir/./payload"]) {
    assertInvalid(validate, {
      schemaVersion: 1,
      id: "skill-frontend-engineering",
      type: "skill",
      displayName: "Dot segment",
      payload,
      compatibility: { calavera: ">=2.2.0" },
    });
  }
  assertInvalid(validate, {
    schemaVersion: 1,
    id: "skill-frontend-engineering",
    type: "skill",
    displayName: "Unsafe",
    payload: "../artifact",
    compatibility: { calavera: ">=2.2.0" },
  });
  assertInvalid(validate, {
    schemaVersion: 1,
    id: "agent-technical-devils-advocate",
    type: "agent",
    displayName: "Missing targets",
    payload: "artifact.md",
    compatibility: { calavera: ">=2.2.0" },
  });
});

test("artifact lock accepts exact deterministic package resolutions", () => {
  const validate = ajv.compile(lockSchema);

  assertValid(validate, {
    schemaVersion: 1,
    artifacts: [
      {
        id: "skill-frontend-engineering",
        type: "skill",
        package: "@schalkneethling/calavera-skill-frontend-engineering",
        version: "1.2.3",
        resolved:
          "https://registry.npmjs.org/@schalkneethling/calavera-skill-frontend-engineering/-/calavera-skill-frontend-engineering-1.2.3.tgz",
        integrity: `sha512-${"a".repeat(86)}==`,
        tag: "latest",
        manifestVersion: 1,
        destination: ".agents/skills/frontend-engineering",
        payloadHash: "a".repeat(64),
      },
    ],
  });
});

test("artifact lock rejects floating versions and unsafe destinations", () => {
  const validate = ajv.compile(lockSchema);
  const entry = {
    id: "skill-frontend-engineering",
    type: "skill",
    package: "@schalkneethling/calavera-skill-frontend-engineering",
    version: "latest",
    resolved: "https://registry.npmjs.org/example.tgz",
    integrity: `sha512-${"a".repeat(86)}==`,
    tag: "latest",
    manifestVersion: 1,
    destination: "../skills/frontend-engineering",
    payloadHash: "a".repeat(64),
  };

  assertInvalid(validate, { schemaVersion: 1, artifacts: [entry] });
});

test("artifact lock rejects dot-segment destinations", () => {
  const validate = ajv.compile(lockSchema);
  const entry = {
    id: "skill-frontend-engineering",
    type: "skill",
    package: "@schalkneethling/calavera-skill-frontend-engineering",
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/example.tgz",
    integrity: `sha512-${"a".repeat(86)}==`,
    tag: "latest",
    manifestVersion: 1,
    payloadHash: "a".repeat(64),
  };

  for (const destination of [".", "./payload", "dir/./payload"]) {
    assertInvalid(validate, {
      schemaVersion: 1,
      artifacts: [{ ...entry, destination }],
    });
  }
});

test("artifact lock rejects mismatched package types and missing targets", () => {
  const validate = ajv.compile(lockSchema);
  const entry = {
    id: "hook-block-dangerous-commands",
    type: "hook",
    package: "@schalkneethling/calavera-skill-block-dangerous-commands",
    version: "1.0.0",
    resolved: "https://registry.npmjs.org/example.tgz",
    integrity: `sha512-${"a".repeat(86)}==`,
    tag: "latest",
    manifestVersion: 1,
    destination: ".agents/hooks/claude-code/block-dangerous-commands.mjs",
    payloadHash: "a".repeat(64),
  };

  assertInvalid(validate, { schemaVersion: 1, artifacts: [entry] });
});

test("artifact lock contract carries resolution data but not installed state", () => {
  const artifactProperties = lockSchema.$defs.artifact.properties;

  assert.equal(Object.hasOwn(artifactProperties, "payloadHash"), true);
  assert.equal(Object.hasOwn(artifactProperties, "installedHash"), false);
  assert.equal(Object.hasOwn(artifactProperties, "generatedAt"), false);
});
