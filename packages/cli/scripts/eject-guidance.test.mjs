// Issue #678, layer 2 of the five-layer stack the owner approved on 2026-11-18: the guidance part
// of the `eject` footprint (ADR-0017, Decision 2). It covers `AGENTS.md` written as a whole file,
// the marked section in an existing `AGENTS.md`, guidance with only the marker, `AGENTS.calavera.md`,
// and `.agents/calavera/mcp.md`. The command is registered in layer 5, so these tests call the
// planner directly.
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtempDisposable,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { executeEject, planEject, selectEjectItems } from "../src/eject.js";
import { agentBootstrap, agentBootstrapTexts } from "../src/index.js";
import { normalizePinnedVersion } from "../src/utils/earlier-guidance.js";
import { snapshotDirectory } from "./project-snapshot.mjs";

const MARKER = "<!-- calavera-agent-bootstrap -->";
const START = "<!-- calavera-agent-bootstrap:start -->";
const END = "<!-- calavera-agent-bootstrap:end -->";
const MCP_NOTES = ".agents/calavera/mcp.md";
const FIXTURES = new URL("../fixtures/agent-guidance/", import.meta.url);

/** @type {import("../src/utils/project-formatter.js").ProjectFormatter} */
const unformatted = { description: "no formatter", format: async (_path, text) => text };
const guidance = await agentBootstrapTexts(async () => unformatted);

/**
 * Runs `callback` inside a new temporary project.
 *
 * @param {() => Promise<void>} callback
 */
async function inProject(callback) {
  await using project = await mkdtempDisposable(join(tmpdir(), "calavera-eject-guidance-"));
  const originalDirectory = process.cwd();
  process.chdir(await realpath(project.path));
  try {
    await writeFile("package.json", "{}\n");
    await callback();
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string} path @param {string} text */
async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

/** @param {{ dryRun?: boolean, texts?: typeof guidance }} [options] */
const plan = ({ dryRun = false, texts = guidance } = {}) => planEject({ dryRun, guidance: texts });

/** @param {Awaited<ReturnType<typeof planEject>>} found @param {string} path */
function item(found, path) {
  const match = found.items.find((candidate) => candidate.path === path);
  assert.ok(match, `the plan names ${path}: ${found.items.map(({ path: p }) => p).join(", ")}`);
  return match;
}

/** @param {Awaited<ReturnType<typeof planEject>>} found @param {string} path */
const named = (found, path) => found.items.some((candidate) => candidate.path === path);

/** @param {Awaited<ReturnType<typeof planEject>>} found @param {string} path */
function report(found, path) {
  const match = found.reported.find((candidate) => candidate.path === path);
  assert.ok(match, `the plan reports ${path}: ${JSON.stringify(found.reported)}`);
  return match;
}

/** An existing `AGENTS.md` with the current section appended as the bootstrap appends it. */
const MINE = "# My guidance\n\n- Keep tests fast.\n";
const withSection = (before = MINE, after = "") =>
  `${before.trimEnd()}\n\n${guidance.section}${after}`;

/**
 * Plans, approves every item, and removes them.
 *
 * @param {typeof guidance} [texts]
 */
async function ejectApproved(texts = guidance) {
  const found = await plan({ texts });
  const outcome = await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
  assert.deepEqual(outcome.failed, []);
  return { found, outcome };
}

/** @param {URL} url */
const fixture = (url) => readFile(url, "utf8");

test("normalizePinnedVersion replaces the pinned version and refuses a text that holds the placeholder", () => {
  assert.deepEqual(
    normalizePinnedVersion(
      "npx --package create-project-calavera@6.2.1 create-project-calavera-mcp",
    ),
    {
      normalized: "npx --package create-project-calavera@{{version}} create-project-calavera-mcp",
      pin: "6.2.1",
    },
  );
  assert.deepEqual(
    normalizePinnedVersion(
      "create-project-calavera@2.3.0-next.2 and again create-project-calavera@2.3.0-next.2",
    ),
    {
      normalized:
        "create-project-calavera@{{version}} and again create-project-calavera@{{version}}",
      pin: "2.3.0-next.2",
    },
  );
  assert.deepEqual(normalizePinnedVersion("no pin"), { normalized: "no pin", pin: undefined });
  // Two different pins: only the first is replaced, so the text cannot match a single release.
  assert.deepEqual(
    normalizePinnedVersion("create-project-calavera@1.0.0 create-project-calavera@2.0.0"),
    {
      normalized: "create-project-calavera@{{version}} create-project-calavera@2.0.0",
      pin: "1.0.0",
    },
  );
  assert.equal(normalizePinnedVersion("create-project-calavera@{{version}}"), undefined);
  // No version is pinned, so nothing is replaced, not even text that reads like a pin.
  assert.deepEqual(normalizePinnedVersion("create-project-calavera@undefined"), {
    normalized: "create-project-calavera@undefined",
    pin: undefined,
  });
});

test("agentBootstrapTexts formats every form of the guidance and the notes for each package manager", async () => {
  /** @type {string[]} */
  const paths = [];
  const texts = await agentBootstrapTexts(async () => ({
    description: "recording",
    format: async (path, text) => {
      paths.push(path);
      return `${text}<!-- formatted -->\n`;
    },
  }));
  assert.ok(texts.file.startsWith(MARKER) && texts.file.endsWith("<!-- formatted -->\n"));
  assert.ok(texts.section.startsWith(START) && texts.section.endsWith("<!-- formatted -->\n"));
  assert.ok(texts.fallback.startsWith(MARKER) && texts.fallback.endsWith("<!-- formatted -->\n"));
  assert.equal(texts.mcp.length, 4);
  for (const runner of ["npx", "pnpm dlx", "yarn dlx", "bunx"]) {
    assert.ok(
      texts.mcp.some((text) => text.includes(`${runner} --package create-project-calavera@`)),
      runner,
    );
  }
  assert.deepEqual([...new Set(paths)].sort(), [MCP_NOTES, "AGENTS.calavera.md", "AGENTS.md"]);
});

test("the guidance and notes the bootstrap writes are planned as unedited and removed", async () => {
  await inProject(async () => {
    await agentBootstrap({ json: true, assumeYes: true });
    assert.ok((await readFile("AGENTS.md", "utf8")).startsWith(MARKER));
    await readFile(MCP_NOTES, "utf8");

    const found = await plan();
    for (const path of ["AGENTS.md", MCP_NOTES]) {
      assert.equal(item(found, path).edits, "unedited", path);
      assert.equal(item(found, path).matchesRecords, true, path);
    }
    const { remove } = selectEjectItems(found, { assumeYes: true });
    assert.ok(remove.some(({ path }) => path === "AGENTS.md"));
    await executeEject(remove);
    await assert.rejects(lstat("AGENTS.md"), { code: "ENOENT" });
    await assert.rejects(lstat(MCP_NOTES), { code: "ENOENT" });
    // ADR-0017 Decision 2: `.agents/calavera/` goes once eject has emptied it.
    await assert.rejects(lstat(".agents/calavera"), { code: "ENOENT" });
  });
});

test("the section and the fallback the bootstrap writes into an existing AGENTS.md are unedited", async () => {
  await inProject(async () => {
    await write("AGENTS.md", MINE);
    await agentBootstrap({ json: true, assumeYes: true, agentsMd: "append" });
    await write("AGENTS.calavera.md", guidance.fallback);

    const found = await plan();
    const section = item(found, "AGENTS.md");
    assert.equal(section.kind, "guidance-section");
    assert.equal(section.action, "edit");
    assert.equal(section.edits, "unedited");
    assert.equal(section.matchesRecords, true);
    assert.equal(section.contents, MINE);
    assert.equal(item(found, "AGENTS.calavera.md").edits, "unedited");
    assert.equal(item(found, "AGENTS.calavera.md").action, "delete");
    assert.deepEqual(found.reported, []);

    await executeEject(selectEjectItems(found, { assumeYes: true }).remove);
    assert.equal(await readFile("AGENTS.md", "utf8"), MINE);
    await assert.rejects(lstat("AGENTS.calavera.md"), { code: "ENOENT" });
  });
});

test("a whole-file AGENTS.md an earlier release wrote is unedited and removed", async () => {
  await inProject(async () => {
    await write("AGENTS.md", await fixture(new URL("guidance/2.0.0.md", FIXTURES)));
    const found = await plan();
    assert.equal(item(found, "AGENTS.md").kind, "guidance-file");
    assert.equal(item(found, "AGENTS.md").action, "delete");
    assert.equal(item(found, "AGENTS.md").edits, "unedited");
    assert.equal(item(found, "AGENTS.md").matchesRecords, true);
    assert.deepEqual(found.reported, []);
    await ejectApproved();
    await assert.rejects(lstat("AGENTS.md"), { code: "ENOENT" });
  });
});

test("a whole-file AGENTS.md with Windows line endings is unedited", async () => {
  await inProject(async () => {
    await write("AGENTS.md", guidance.file.replaceAll("\n", "\r\n"));
    assert.equal(item(await plan(), "AGENTS.md").edits, "unedited");
    // An earlier release's text with Windows line endings is unedited too.
    const earlier = await fixture(new URL("guidance/2.0.0.md", FIXTURES));
    await write("AGENTS.md", earlier.replaceAll("\n", "\r\n"));
    assert.equal(item(await plan(), "AGENTS.md").edits, "unedited");
  });
});

test("each guidance file is checked against the text the project's formatter gives", async () => {
  // A formatter whose text no release table lists, so only the current texts can match.
  const formatted = await agentBootstrapTexts(async () => ({
    description: "star bullets",
    format: async (_path, text) => text.replaceAll("\n- ", "\n* "),
  }));
  for (const [path, text] of [
    ["AGENTS.md", formatted.file],
    ["AGENTS.md", formatted.file.replaceAll("\n", "\r\n")],
    ["AGENTS.calavera.md", formatted.fallback],
    ...formatted.mcp.map((notes) => [MCP_NOTES, notes]),
  ]) {
    await inProject(async () => {
      await write(path, text);
      const found = await plan({ texts: formatted });
      assert.equal(item(found, path).edits, "unedited", path);
      assert.deepEqual(found.reported, []);
    });
  }
});

test("a file formatted with Windows line endings matches the same text with Unix ones", async () => {
  const crlf = await agentBootstrapTexts(async () => ({
    description: "star bullets and Windows line endings",
    format: async (_path, text) => text.replaceAll("\n- ", "\n* ").replaceAll("\n", "\r\n"),
  }));
  await inProject(async () => {
    await write("AGENTS.calavera.md", crlf.fallback.replaceAll("\r\n", "\n"));
    assert.equal(item(await plan({ texts: crlf }), "AGENTS.calavera.md").edits, "unedited");
  });
});

test("a section formatted with Windows line endings is unedited", async () => {
  const crlf = await agentBootstrapTexts(async () => ({
    description: "Windows line endings",
    format: async (_path, text) => text.replaceAll("\n", "\r\n"),
  }));
  await inProject(async () => {
    await write("AGENTS.md", `${MINE.replaceAll("\n", "\r\n")}\r\n${crlf.section}`);
    assert.equal(item(await plan({ texts: crlf }), "AGENTS.md").edits, "unedited");
  });
});

test("an edited whole-file AGENTS.md is kept and reported, even after approval", async () => {
  await inProject(async () => {
    const edited = `${guidance.file}\n- My own rule.\n`;
    await write("AGENTS.md", edited);
    const before = await snapshotDirectory();

    const found = await plan();
    assert.equal(named(found, "AGENTS.md"), false);
    assert.match(report(found, "AGENTS.md").reason, /no section markers/);
    assert.equal(found.nothingToDo, true);

    await ejectApproved();
    assert.deepEqual(await snapshotDirectory(), before);
    assert.equal(await readFile("AGENTS.md", "utf8"), edited);

    await write("AGENTS.md", edited.replaceAll("\n", "\r\n"));
    assert.match(report(await plan(), "AGENTS.md").reason, /no section markers/);
  });
});

test("guidance with only the marker, such as a hand merge, is kept and reported", async () => {
  await inProject(async () => {
    const merged = `${MINE}\n${guidance.fallback}`;
    await write("AGENTS.md", merged);

    const found = await plan();
    assert.equal(named(found, "AGENTS.md"), false);
    assert.match(report(found, "AGENTS.md").reason, /calavera-agent-bootstrap/);
    assert.doesNotMatch(report(found, "AGENTS.md").reason, /no section markers/);
    await ejectApproved();
    assert.equal(await readFile("AGENTS.md", "utf8"), merged);
  });
});

test("an AGENTS.md without any Calavera marker is neither removed nor reported", async () => {
  await inProject(async () => {
    await write("AGENTS.md", MINE);
    const found = await plan();
    assert.equal(named(found, "AGENTS.md"), false);
    assert.deepEqual(found.reported, []);
  });
});

test("an edited or older section is kept and reported", async () => {
  for (const text of [
    withSection().replace("# Calavera Agent Guidance", "# Calavera Agent Guidance (mine)"),
    // The section an earlier release wrote differs from the current one, which looks the same as
    // an edit, so it stays too (ADR-0017, Decision 2).
    `${MINE}\n${START}\n\n# Calavera Agent Guidance\n\n- An older rule.\n\n${END}\n`,
  ]) {
    await inProject(async () => {
      await write("AGENTS.md", text);
      const found = await plan();
      assert.equal(named(found, "AGENTS.md"), false);
      assert.match(report(found, "AGENTS.md").reason, /section/);
      await ejectApproved();
      assert.equal(await readFile("AGENTS.md", "utf8"), text);
    });
  }
});

test("removing the section keeps every line around it and drops only the separator Calavera added", async () => {
  await inProject(async () => {
    await write("AGENTS.md", withSection(MINE, "\n# Added later\n\nMore of mine.\n"));
    const section = item(await plan(), "AGENTS.md");
    assert.equal(section.contents, `${MINE}\n# Added later\n\nMore of mine.\n`);
    assert.deepEqual(section.removedLines, guidance.section.trimEnd().split("\n").slice(1, -1));
    await ejectApproved();
    assert.equal(await readFile("AGENTS.md", "utf8"), `${MINE}\n# Added later\n\nMore of mine.\n`);
  });
});

test("a section right after the person's text, with no blank line, removes no line of theirs", async () => {
  await inProject(async () => {
    await write("AGENTS.md", `${MINE}${guidance.section}`);
    assert.equal(item(await plan(), "AGENTS.md").contents, MINE);
  });
});

test("a section at the start of AGENTS.md is removed with nothing before it", async () => {
  await inProject(async () => {
    await write("AGENTS.md", `${guidance.section}\n${MINE}`);
    assert.equal(item(await plan(), "AGENTS.md").contents, `\n${MINE}`);
    await write("AGENTS.md", guidance.section);
    assert.equal(item(await plan(), "AGENTS.md").contents, "");
  });
});

test("a section followed directly by the person's text keeps the blank line between their paragraphs", async () => {
  await inProject(async () => {
    await write("AGENTS.md", `Para A.\n\n${guidance.section}Para B.\n`);
    assert.equal(item(await plan(), "AGENTS.md").contents, "Para A.\n\nPara B.\n");
  });
});

test("a section without a final line break is removed and the text before it keeps its own", async () => {
  await inProject(async () => {
    await write("AGENTS.md", withSection().trimEnd());
    assert.equal(item(await plan(), "AGENTS.md").contents, MINE);
  });
});

test("a section with Windows line endings is unedited and the rest keeps its line endings", async () => {
  await inProject(async () => {
    await write("AGENTS.md", withSection().replaceAll("\n", "\r\n"));
    const section = item(await plan(), "AGENTS.md");
    assert.equal(section.edits, "unedited");
    assert.equal(section.contents, MINE.replaceAll("\n", "\r\n"));
  });
});

test("the section is checked against the text the project's formatter gives", async () => {
  const formatted = await agentBootstrapTexts(async () => ({
    description: "star bullets",
    format: async (_path, text) => text.replaceAll("\n- ", "\n* "),
  }));
  await inProject(async () => {
    await write("AGENTS.md", `${MINE}\n${formatted.section}`);
    assert.equal(item(await plan({ texts: formatted }), "AGENTS.md").edits, "unedited");
    // The unformatted text is not what this project's bootstrap writes.
    assert.equal(named(await plan({ texts: formatted }), "AGENTS.md"), true);
    await write("AGENTS.md", withSection());
    assert.equal(named(await plan({ texts: formatted }), "AGENTS.md"), false);
  });
});

test("a section next to marker-only guidance is removed and the rest is reported", async () => {
  await inProject(async () => {
    await write("AGENTS.md", withSection(`${MINE}\n${MARKER}\n\n# Merged by hand\n`));
    const found = await plan();
    assert.equal(item(found, "AGENTS.md").kind, "guidance-section");
    assert.match(report(found, "AGENTS.md").reason, /calavera-agent-bootstrap/);
  });
});

test("a broken guidance marker stops eject before it writes anything", async () => {
  const body = "\n\n# Calavera Agent Guidance\n\n";
  for (const [text, problem] of [
    [`${MINE}\n${START}${body}`, /the Calavera guidance section has a start marker without an end/],
    [`${MINE}\n${body}${END}\n`, /end marker without a start marker/],
    [`${MINE}\n${END}\n${body}${START}\n`, /end marker that comes before/],
    [
      `${MINE}\n${START}${body}${END}\n${START}${body}${END}\n`,
      /2 start markers and 2 end markers/,
    ],
    [`${MINE}\n  ${START}${body}${END}\n`, /marker line was changed/],
    [`${MINE}\n<!-- calavera-agent-bootstrap:start-->${body}${END}\n`, /marker line was changed/],
  ]) {
    await inProject(async () => {
      await write("AGENTS.md", /** @type {string} */ (text));
      await write("AGENTS.calavera.md", guidance.fallback);
      const before = await snapshotDirectory();
      await assert.rejects(plan(), (error) => {
        assert.ok(error instanceof Error);
        assert.match(error.message, /^eject stopped before removing anything: AGENTS\.md: /);
        assert.match(error.message, /** @type {RegExp} */ (problem));
        assert.match(error.message, /run eject again/);
        return true;
      });
      assert.deepEqual(await snapshotDirectory(), before);
    });
  }
});

test("AGENTS.calavera.md is unedited when it holds the current or an earlier release's guidance", async () => {
  for (const text of [guidance.fallback, await fixture(new URL("guidance/3.0.0.md", FIXTURES))]) {
    await inProject(async () => {
      await write("AGENTS.calavera.md", text);
      const fallback = item(await plan(), "AGENTS.calavera.md");
      assert.equal(fallback.kind, "fallback-guidance");
      assert.equal(fallback.edits, "unedited");
      assert.equal(fallback.matchesRecords, true);
    });
  }
});

test("an edited AGENTS.calavera.md is listed as edited and removed only after approval", async () => {
  await inProject(async () => {
    await write("AGENTS.calavera.md", `${guidance.fallback}- Mine.\n`);
    const found = await plan();
    const fallback = item(found, "AGENTS.calavera.md");
    assert.equal(fallback.edits, "edited");
    assert.equal(fallback.matchesRecords, false);
    assert.match(fallback.reason ?? "", /AGENTS\.calavera\.md/);
    assert.deepEqual(
      selectEjectItems(found, { assumeYes: true }).leave.map(({ path }) => path),
      ["AGENTS.calavera.md"],
    );
    await ejectApproved();
    await assert.rejects(lstat("AGENTS.calavera.md"), { code: "ENOENT" });
  });
});

test("the MCP setup notes are unedited for every package manager and for an earlier release", async () => {
  const earlier = (await fixture(new URL("mcp/2.0.6.pnpm.md", FIXTURES))).replaceAll(
    "{{version}}",
    "2.0.6",
  );
  for (const text of [...guidance.mcp, earlier]) {
    await inProject(async () => {
      await write(MCP_NOTES, text);
      const notes = item(await plan(), MCP_NOTES);
      assert.equal(notes.kind, "mcp-notes");
      assert.equal(notes.edits, "unedited");
      assert.equal(notes.matchesRecords, true);
    });
  }
});

test("edited MCP setup notes are listed as edited, and notes pinning an unreleased version count as edited", async () => {
  const unreleased = (await fixture(new URL("mcp/2.0.6.npm.md", FIXTURES))).replaceAll(
    "{{version}}",
    "9.9.9",
  );
  for (const text of [`${guidance.mcp[0]}\nMine.\n`, unreleased]) {
    await inProject(async () => {
      await write(MCP_NOTES, text);
      const notes = item(await plan(), MCP_NOTES);
      assert.equal(notes.edits, "edited");
      assert.equal(notes.matchesRecords, false);
      assert.match(notes.reason ?? "", /mcp\.md differs from the MCP setup notes/);
    });
  }
});

test("guidance that holds the version placeholder is edited, because no release wrote it", async () => {
  await inProject(async () => {
    await write("AGENTS.calavera.md", `${guidance.fallback}create-project-calavera@{{version}}\n`);
    assert.equal(item(await plan(), "AGENTS.calavera.md").edits, "edited");
  });
});

test(".agents/calavera stays, and is listed, while it holds a file eject does not name", async () => {
  await inProject(async () => {
    await write(MCP_NOTES, guidance.mcp[0] ?? "");
    await write(".agents/calavera/mine.md", "mine\n");
    const { found } = await ejectApproved();
    assert.deepEqual(found.kept, [".agents/calavera/mine.md"]);
    await assert.rejects(lstat(MCP_NOTES), { code: "ENOENT" });
    assert.equal(await readFile(".agents/calavera/mine.md", "utf8"), "mine\n");
  });
});

test("an empty .agents/calavera that eject did not empty is left alone", async () => {
  await inProject(async () => {
    await mkdir(".agents/calavera", { recursive: true });
    await write("AGENTS.calavera.md", guidance.fallback);
    await ejectApproved();
    assert.ok((await lstat(".agents/calavera")).isDirectory());
  });
});

test("a folder named AGENTS.md holds no guidance, so it is neither removed nor reported", async () => {
  await inProject(async () => {
    await mkdir("AGENTS.md/inside", { recursive: true });
    const found = await plan();
    assert.equal(named(found, "AGENTS.md"), false);
    assert.deepEqual(found.reported, []);
  });
});

test("a folder in place of a Calavera guidance file is reported and left", async () => {
  for (const path of ["AGENTS.calavera.md", MCP_NOTES]) {
    await inProject(async () => {
      await mkdir(`${path}/inside`, { recursive: true });
      const found = await plan();
      assert.equal(named(found, path), false, path);
      assert.match(report(found, path).reason, /not a file/);
      await ejectApproved();
      assert.ok((await lstat(`${path}/inside`)).isDirectory());
    });
  }
});

test("a guidance file that is a symbolic link needs approval, and approval removes only the link", async () => {
  for (const [path, text] of [
    ["AGENTS.md", guidance.file],
    ["AGENTS.calavera.md", guidance.fallback],
    [MCP_NOTES, guidance.mcp[0] ?? ""],
  ]) {
    await inProject(async () => {
      await write("target/guidance.md", text);
      await mkdir(dirname(path), { recursive: true });
      await symlink(join(process.cwd(), "target/guidance.md"), path);
      const found = await plan();
      const link = item(found, path);
      assert.equal(link.edits, "cannot-detect", path);
      assert.equal(link.matchesRecords, false, path);
      assert.equal(
        link.reason,
        `${path} is a symbolic link, which no record covers; edits cannot be detected. eject removes only the link, not what it leads to.`,
      );
      await ejectApproved();
      await assert.rejects(lstat(path), { code: "ENOENT" });
      assert.equal(await readFile("target/guidance.md", "utf8"), text);
    });
  }
});

test("a linked guidance file with edited text is listed as edited, and its reason names both", async () => {
  await inProject(async () => {
    await write("target/guidance.md", `${guidance.fallback}- Mine.\n`);
    await symlink("target/guidance.md", "AGENTS.calavera.md");
    const link = item(await plan(), "AGENTS.calavera.md");
    assert.equal(link.edits, "edited");
    assert.equal(link.matchesRecords, false);
    assert.match(link.reason ?? "", /symbolic link.*holds edits\. eject removes only the link/);
  });
});

test("a broken link in place of a Calavera guidance file is reported and left", async () => {
  await inProject(async () => {
    await symlink("missing.md", "AGENTS.calavera.md");
    const found = await plan();
    assert.equal(named(found, "AGENTS.calavera.md"), false);
    assert.match(report(found, "AGENTS.calavera.md").reason, /not a file/);
  });
});

test("a section in an AGENTS.md that links out of the project is reported, and the rest of eject goes on", async () => {
  await using outside = await mkdtempDisposable(join(tmpdir(), "calavera-eject-outside-"));
  await writeFile(join(outside.path, "AGENTS.md"), withSection());
  await inProject(async () => {
    await symlink(join(outside.path, "AGENTS.md"), "AGENTS.md");
    await write("AGENTS.calavera.md", guidance.fallback);
    const found = await plan();
    assert.equal(named(found, "AGENTS.md"), false);
    assert.match(report(found, "AGENTS.md").reason, /outside the project/);
    assert.equal(item(found, "AGENTS.calavera.md").edits, "unedited");
    await ejectApproved();
  });
  assert.equal(await readFile(join(outside.path, "AGENTS.md"), "utf8"), withSection());
});

test("a link in the middle of a chain retargeted after the plan stops the edit", async () => {
  await inProject(async () => {
    await write("one/AGENTS.md", withSection());
    await write("two/AGENTS.md", withSection());
    await symlink("one/AGENTS.md", "hop.md");
    await symlink("hop.md", "AGENTS.md");
    const found = await plan();
    await rm("hop.md");
    await symlink("two/AGENTS.md", "hop.md");
    await assert.rejects(
      executeEject(selectEjectItems(found, { assumeYes: true }).remove),
      /AGENTS\.md changed since eject listed/,
    );
    assert.equal(await readFile("two/AGENTS.md", "utf8"), withSection());
  });
});

test("a section in an AGENTS.md that is a link is edited through the link", async () => {
  await inProject(async () => {
    await write("docs/AGENTS.md", withSection());
    await symlink("docs/AGENTS.md", "AGENTS.md");
    await ejectApproved();
    assert.ok((await lstat("AGENTS.md")).isSymbolicLink());
    assert.equal(await readFile("docs/AGENTS.md", "utf8"), MINE);
  });
});

// Every item `executeEject` changes is read again just before the change, and nothing is removed
// when it differs from what the plan read, in every direction of change.
const RECHECKS = [
  { path: "AGENTS.md", text: () => guidance.file, kind: "guidance-file" },
  { path: "AGENTS.md", text: () => withSection(), kind: "guidance-section" },
  { path: "AGENTS.calavera.md", text: () => guidance.fallback, kind: "fallback-guidance" },
  { path: MCP_NOTES, text: () => guidance.mcp[0] ?? "", kind: "mcp-notes" },
];

/**
 * Plans with `path` holding `text`, applies `change`, and checks that the approved removal stops
 * with nothing changed.
 *
 * @param {string} path @param {string} text @param {(path: string, text: string) => Promise<void>} change
 */
async function assertStopsAfter(path, text, change) {
  await inProject(async () => {
    await write("target/text.md", text);
    await write(path, text);
    const found = await plan();
    await change(path, text);
    const before = await snapshotDirectory();
    await assert.rejects(
      executeEject(selectEjectItems(found, { assumeYes: false }).remove),
      new RegExp(`${path.replaceAll(".", "\\.")} changed since eject listed`),
    );
    assert.deepEqual(await snapshotDirectory(), before);
  });
}

for (const { path, text, kind } of RECHECKS) {
  test(`${kind}: an edit after the plan stops the removal`, async () => {
    await assertStopsAfter(path, text(), (target, current) =>
      writeFile(target, `${current}- Added after the plan.\n`),
    );
  });

  test(`${kind}: a link to identical text in its place after the plan stops the removal`, async () => {
    await assertStopsAfter(path, text(), async (target) => {
      await rm(target);
      await symlink(join(process.cwd(), "target/text.md"), target);
    });
  });

  test(`${kind}: a folder in its place after the plan stops the removal`, async () => {
    await assertStopsAfter(path, text(), async (target) => {
      await rm(target);
      await mkdir(target);
    });
  });

  test(`${kind}: a file deleted after the plan counts as removed`, async () => {
    await inProject(async () => {
      await write(path, text());
      const found = await plan();
      await rm(path);
      const outcome = await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
      assert.deepEqual(outcome.failed, []);
      assert.ok(outcome.removed.some((removed) => removed.path === path));
      await assert.rejects(lstat(path), { code: "ENOENT" });
    });
  });
}

test("a linked guidance file retargeted to identical text after the plan stops the removal", async () => {
  await inProject(async () => {
    await write("one/guidance.md", guidance.fallback);
    await write("two/guidance.md", guidance.fallback);
    await symlink("one/guidance.md", "AGENTS.calavera.md");
    const found = await plan();
    await rm("AGENTS.calavera.md");
    await symlink("two/guidance.md", "AGENTS.calavera.md");
    await assert.rejects(
      executeEject(selectEjectItems(found, { assumeYes: false }).remove),
      /AGENTS\.calavera\.md changed since eject listed/,
    );
    assert.ok((await lstat("AGENTS.calavera.md")).isSymbolicLink());
  });
});

test("a linked AGENTS.md whose target holds a section is retargeted after the plan stops the edit", async () => {
  await inProject(async () => {
    await write("one/AGENTS.md", withSection());
    await write("two/AGENTS.md", withSection());
    await symlink("one/AGENTS.md", "AGENTS.md");
    const found = await plan();
    await rm("AGENTS.md");
    await symlink("two/AGENTS.md", "AGENTS.md");
    await assert.rejects(
      executeEject(selectEjectItems(found, { assumeYes: false }).remove),
      /AGENTS\.md changed since eject listed/,
    );
    assert.equal(await readFile("two/AGENTS.md", "utf8"), withSection());
  });
});

test("a second run after eject has nothing to do, and still reports kept guidance", async () => {
  await inProject(async () => {
    await write("AGENTS.md", `${guidance.file}- Mine.\n`);
    await write("AGENTS.calavera.md", guidance.fallback);
    await write(MCP_NOTES, guidance.mcp[1] ?? "");
    await ejectApproved();
    const again = await plan({ dryRun: true });
    assert.equal(again.nothingToDo, true);
    assert.deepEqual(again.items, []);
    assert.equal(again.reported.length, 1);
  });
});
