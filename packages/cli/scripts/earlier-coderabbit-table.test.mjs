// Issue #678, layer 4: `eject` recognizes a `.coderabbit.yaml` that Calavera created by the
// SHA-256 digests of every text a release wrote. These tests keep those digests honest: they must
// agree with the texts committed in fixtures/coderabbit, and the texts this checkout's bootstrap
// writes, whether it creates the file or adds filters to one an earlier release created, must be
// registered. Changing the template or the filters without recording the new text fails here, not
// in a person's project.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempDisposable, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { CODE_RABBIT_CONFIG_FIRST_LINE, CODE_RABBIT_PACKAGES_FILTER } from "../src/ai/artifacts.js";
import { agentBootstrap } from "../src/index.js";
import {
  CODE_RABBIT_TEXTS,
  isCodeRabbitTextCalaveraWrote,
} from "../src/utils/earlier-coderabbit.js";

const fixtureDirectory = fileURLToPath(new URL("../fixtures/coderabbit/", import.meta.url));
/** @type {{ id: string, action: "created" | "updated", firstRelease: string, lastRelease: string | null }[]} */
const epochs = JSON.parse(await readFile(join(fixtureDirectory, "epochs.json"), "utf8"));
/** @param {string} id */
const fixtureText = (id) => readFile(join(fixtureDirectory, `${id}.yaml`), "utf8");
/** @param {string} text */
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/**
 * The `.coderabbit.yaml` this checkout's bootstrap leaves in a new project, which holds `existing`
 * as its `.coderabbit.yaml` when given.
 *
 * @param {string} [existing]
 */
async function bootstrapCodeRabbit(existing) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-coderabbit-table-"));
  const originalDirectory = process.cwd();
  process.chdir(await realpath(project.path));
  try {
    await writeFile("package.json", "{}\n");
    if (existing !== undefined) await writeFile(".coderabbit.yaml", existing);
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    return await readFile(".coderabbit.yaml", "utf8");
  } finally {
    process.chdir(originalDirectory);
  }
}

test("Given the committed fixtures, then the digests the CLI holds are exactly their digests", async () => {
  const files = (await readdir(fixtureDirectory)).filter((name) => name.endsWith(".yaml")).sort();
  assert.deepEqual(files, epochs.map(({ id }) => `${id}.yaml`).sort());
  assert.deepEqual(
    CODE_RABBIT_TEXTS,
    await Promise.all(
      epochs.map(async ({ id }) => ({ id, sha256: sha256(await fixtureText(id)) })),
    ),
  );
});

test("Given every text a release wrote, then it starts with the first line eject recognizes and holds the packages filter", async () => {
  for (const { id } of epochs) {
    const text = await fixtureText(id);
    assert.equal(text.split("\n", 1)[0], CODE_RABBIT_CONFIG_FIRST_LINE, id);
    assert.ok(text.includes(`"${CODE_RABBIT_PACKAGES_FILTER}"`) || id === "created-2.3.0", id);
    assert.equal(isCodeRabbitTextCalaveraWrote(text), true, id);
    assert.equal(isCodeRabbitTextCalaveraWrote(text.replaceAll("\n", "\r\n")), true, `${id} CRLF`);
  }
});

test("Given a text one character away from a release's, then it is not one Calavera wrote", async () => {
  const text = await fixtureText("created-2.5.0");
  assert.equal(isCodeRabbitTextCalaveraWrote(`${text}\n`), false);
  assert.equal(isCodeRabbitTextCalaveraWrote(text.replace("pnpm", "pnpn")), false);
  assert.equal(isCodeRabbitTextCalaveraWrote(""), false);
});

test("Given a new project, then the text this checkout creates is the one current created template", async () => {
  const created = await bootstrapCodeRabbit();
  const current = epochs.filter(({ action, lastRelease }) => action === "created" && !lastRelease);
  assert.equal(
    current.length,
    1,
    "exactly one created template has no lastRelease, which marks the text this checkout writes",
  );
  assert.equal(
    created,
    await fixtureText(current[0].id),
    "the .coderabbit.yaml this checkout creates is not registered: give the current template a lastRelease, add the new text to fixtures/coderabbit with its digest in src/utils/earlier-coderabbit.js",
  );
});

test("Given a file an earlier release created or updated, then the text this checkout updates it to is a current updated template", async () => {
  const written = new Set();
  // Every text a release wrote, updated ones included: a later filter change updates those too.
  for (const { id } of epochs) {
    const earlier = await fixtureText(id);
    const updated = await bootstrapCodeRabbit(earlier);
    if (updated !== earlier) written.add(updated);
  }
  const current = await Promise.all(
    epochs
      .filter(({ action, lastRelease }) => action === "updated" && !lastRelease)
      .map(({ id }) => fixtureText(id)),
  );
  assert.deepEqual(
    [...written].sort(),
    current.sort(),
    "the texts this checkout writes when it adds filters to an earlier release's file must be exactly the updated templates without a lastRelease",
  );
});
