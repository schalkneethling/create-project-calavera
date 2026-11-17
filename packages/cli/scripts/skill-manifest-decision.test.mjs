// #962: when the directory has no package.json of its own but a manifest above it was found,
// dry_run_apply returns `manifestDecision` and plans nothing until the user chooses (#430). The
// bundled Calavera skill must tell an agent to show the choices and pass the user's choice as
// `manifestChoice`, so these tests fail when either copy stops naming the result, the input, or a
// choice the CLI offers.
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";

import { manifestChoices } from "../src/manifest-decision.js";

// The CLI installs the first copy during `--init`; the second is the published skill artifact.
const skills = [
  {
    source: "packages/cli/src/bootstrap/calavera/SKILL.md",
    url: new URL("../src/bootstrap/calavera/SKILL.md", import.meta.url),
  },
  {
    source: "packages/artifacts/skill-calavera/payload/calavera/SKILL.md",
    url: new URL("../../artifacts/skill-calavera/payload/calavera/SKILL.md", import.meta.url),
  },
];

for (const { source, url } of skills) {
  test(`the bundled Calavera skill at ${source} keeps the manifest choice with the user`, async () => {
    const skill = await readFile(url, "utf8");

    for (const name of ["manifestDecision", "manifestChoice", ...manifestChoices]) {
      assert.ok(skill.includes(`\`${name}\``), `${source} does not name \`${name}\``);
    }
    assert.match(
      skill,
      /never (?:pick|choose)/i,
      `${source} does not forbid choosing for the user`,
    );
  });
}
