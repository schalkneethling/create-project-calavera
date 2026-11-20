// Issue #678, layer 4 of the five-layer stack the owner approved on 2026-11-18: `.coderabbit.yaml`
// in the `eject` footprint (ADR-0017, Decision 2). A file that starts with the line Calavera writes
// when it creates the file is Calavera's: it is unedited when its text is one a release wrote, and
// otherwise listed as edited and removed after approval. In any other `.coderabbit.yaml`, which
// existed before Calavera added its filters, the `!.calavera/packages/**` filter line is reported
// and the file is left. These tests call the planner directly; `eject-command.test.mjs` covers the command.
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
import { snapshotDirectory } from "./project-snapshot.mjs";

const PATH = ".coderabbit.yaml";
const FIXTURES = new URL("../fixtures/coderabbit/", import.meta.url);
/** @param {string} id */
const fixture = (id) => readFile(new URL(`${id}.yaml`, FIXTURES), "utf8");
const CREATED = await fixture("created-2.5.0");
const FIRST_LINE = CREATED.split("\n", 1)[0];
const CACHE_BLOCK =
  "# calavera:artifact-cache:start\n.calavera/cache/\n# calavera:artifact-cache:end\n";
/** A `.coderabbit.yaml` the person wrote, with the filters a release added to it. */
const THEIRS = `# Our review settings
reviews:
  profile: chill
  path_filters:
    - "!dist/**"
    - "!.claude/skills/**"
    - "!.agents/skills/**"
    - "!.agents/agents/claude-code/**"
    - "!.calavera/packages/**"
    - "!pnpm-lock.yaml"
`;

/** @type {import("../src/utils/project-formatter.js").ProjectFormatter} */
const unformatted = { description: "no formatter", format: async (_path, text) => text };
const loadFormatter = async () => unformatted;
const guidance = await agentBootstrapTexts(loadFormatter);

/**
 * Runs `callback` inside a new temporary project, with the folder that holds the project as its
 * argument, for files outside the project.
 *
 * @param {(outside: string) => Promise<void>} callback
 */
async function inProject(callback) {
  await using holder = await mkdtempDisposable(join(tmpdir(), "calavera-eject-coderabbit-"));
  const root = await realpath(holder.path);
  await mkdir(join(root, "project"));
  const originalDirectory = process.cwd();
  process.chdir(join(root, "project"));
  try {
    await writeFile("package.json", "{}\n");
    await callback(root);
  } finally {
    process.chdir(originalDirectory);
  }
}

/** @param {string} path @param {string} text */
async function write(path, text) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
}

const plan = () => planEject({ dryRun: false, guidance, loadFormatter });

/** @param {Awaited<ReturnType<typeof planEject>>} found */
function codeRabbit(found) {
  const match = found.items.find((candidate) => candidate.path === PATH);
  assert.ok(match, `the plan names ${PATH}: ${JSON.stringify(found.items)}`);
  return match;
}

/** @param {Awaited<ReturnType<typeof planEject>>} found */
const named = (found) => found.items.some((candidate) => candidate.path === PATH);

/** @param {Awaited<ReturnType<typeof planEject>>} found */
const reportsOf = (found) => found.reported.filter((candidate) => candidate.path === PATH);

/** @param {string} path */
const exists = (path) =>
  lstat(path).then(
    () => true,
    () => false,
  );

/** Plans, approves every item, and removes them. */
async function ejectApproved() {
  const found = await plan();
  const outcome = await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
  assert.deepEqual(outcome.failed, []);
  return { found, outcome };
}

test("a project without .coderabbit.yaml has nothing to remove or report", async () => {
  await inProject(async () => {
    const found = await plan();
    assert.deepEqual(found.items, []);
    assert.deepEqual(found.reported, []);
  });
});

test("a .coderabbit.yaml the bootstrap created is unedited, and --yes removes it", async () => {
  await inProject(async () => {
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    const found = await plan();
    const item = codeRabbit(found);
    assert.equal(item.kind, "coderabbit-config");
    assert.equal(item.action, "delete");
    assert.equal(item.edits, "unedited");
    assert.equal(item.matchesRecords, true);
    assert.equal(item.reason, undefined);
    assert.deepEqual(found.reported, []);

    const { remove } = selectEjectItems(found, { assumeYes: true });
    assert.ok(remove.includes(item));
    const outcome = await executeEject(remove);
    assert.deepEqual(outcome.failed, []);
    assert.equal(await exists(PATH), false);
    assert.equal(named(await plan()), false);
  });
});

test("every text a release wrote, with either line ending, is unedited", async () => {
  for (const id of ["created-2.3.0", "created-2.5.0", "updated-2.5.0-from-2.3.0"]) {
    const text = await fixture(id);
    for (const contents of [text, text.replaceAll("\n", "\r\n")]) {
      await inProject(async () => {
        await write(PATH, contents);
        const item = codeRabbit(await plan());
        assert.equal(item.edits, "unedited", id);
        assert.equal(item.matchesRecords, true, id);
      });
    }
  }
});

test("a .coderabbit.yaml Calavera created and the person edited is listed as edited, which --yes leaves and approval removes", async () => {
  for (const contents of [
    `${CREATED}    - "!dist/**"\n`,
    CREATED.replace('    - "!pnpm-lock.yaml"\n', ""),
    `${FIRST_LINE}\n`,
    FIRST_LINE,
  ]) {
    await inProject(async () => {
      await write(PATH, contents);
      const found = await plan();
      const item = codeRabbit(found);
      assert.equal(item.action, "delete");
      assert.equal(item.edits, "edited");
      assert.equal(item.matchesRecords, false);
      assert.equal(
        item.reason,
        `${PATH} starts with the line Calavera writes when it creates the file, but its text differs from every text a Calavera release wrote, so it holds edits.`,
      );
      assert.deepEqual(found.reported, []);

      const yes = selectEjectItems(found, { assumeYes: true });
      assert.ok(yes.leave.includes(item));
      assert.ok(!yes.remove.includes(item));
      await executeEject(yes.remove);
      assert.equal(await readFile(PATH, "utf8"), contents);

      await ejectApproved();
      assert.equal(await exists(PATH), false);
    });
  }
});

test("a .coderabbit.yaml that existed before Calavera keeps its packages filter, which eject reports", async () => {
  await inProject(async () => {
    await write(PATH, THEIRS);
    const before = await snapshotDirectory(".");
    const found = await plan();
    assert.equal(named(found), false);
    assert.deepEqual(reportsOf(found), [
      {
        path: PATH,
        reason: `${PATH} existed before Calavera added its review filters, so eject leaves the file as it is. Line 9 holds the "!.calavera/packages/**" filter Calavera added; remove it yourself if you no longer want it.`,
      },
    ]);
    // Reported text is not work for eject (ADR-0017, Decision 8).
    assert.equal(found.nothingToDo, true);
    await executeEject(selectEjectItems(found, { assumeYes: false }).remove);
    assert.deepEqual(await snapshotDirectory("."), before);
  });
});

test("the report names every line that holds the packages filter, with either line ending", async () => {
  await inProject(async () => {
    await write(
      PATH,
      `reviews:\r\n  path_filters:\r\n    - '!.calavera/packages/**'\r\n    - "!.calavera/packages/**"\r\n`,
    );
    const [found] = reportsOf(await plan());
    assert.match(found.reason, / Lines 3 and 4 hold the "!\.calavera\/packages\/\*\*" filter /);
    await writeFile(PATH, `${THEIRS}# !.calavera/packages/**\n# "!.calavera/packages/**"\n`);
    const [three] = reportsOf(await plan());
    assert.match(three.reason, / Lines 9, 11 and 12 hold the /);
  });
});

test("a .coderabbit.yaml the person wrote that the bootstrap updated is reported, not removed", async () => {
  await inProject(async () => {
    // An existing file needs a filter list: apply cannot add one today.
    const mine = 'reviews:\n  path_filters:\n    - "!dist/**"\n';
    await write(PATH, mine);
    await agentBootstrap({ mcpHarness: "skip", packageManager: "npm" });
    const updated = await readFile(PATH, "utf8");
    assert.notEqual(updated, mine);
    const found = await plan();
    assert.equal(named(found), false);
    assert.equal(reportsOf(found).length, 1);
    await ejectApproved();
    assert.equal(await readFile(PATH, "utf8"), updated);
  });
});

test("a .coderabbit.yaml without Calavera's first line or the packages filter is neither named nor reported", async () => {
  for (const contents of [
    "reviews:\n  profile: chill\n",
    // The first line with anything added to it is not the line Calavera writes.
    `${FIRST_LINE} \n${CREATED.slice(FIRST_LINE.length + 1).replace('    - "!.calavera/packages/**"\n', "")}`,
    `\n${CREATED.replace('    - "!.calavera/packages/**"\n', "")}`,
    // A carriage return inside the first line, not at its end, changes the line.
    `${FIRST_LINE.replace("CodeRabbit ", "CodeRabbit\r ")}\nreviews: {}\n`,
    "",
  ]) {
    await inProject(async () => {
      await write(PATH, contents);
      const found = await plan();
      assert.equal(named(found), false, JSON.stringify(contents));
      assert.deepEqual(found.reported, [], JSON.stringify(contents));
    });
  }
});

test("Calavera's text below another first line is a file that existed before, so it is reported", async () => {
  await inProject(async () => {
    await write(PATH, `# Mine\n${CREATED}`);
    const found = await plan();
    assert.equal(named(found), false);
    assert.match(reportsOf(found)[0]?.reason ?? "", / Line 13 holds /);
  });
});

test("a folder or a broken link at .coderabbit.yaml is reported and left", async () => {
  for (const make of [() => mkdir(PATH), () => symlink("missing.yaml", PATH)]) {
    await inProject(async () => {
      await make();
      const found = await plan();
      assert.equal(named(found), false);
      assert.deepEqual(reportsOf(found), [
        {
          path: PATH,
          reason: `${PATH} is not a file, so eject cannot tell whether Calavera created it, and leaves it.`,
        },
      ]);
      await ejectApproved();
      assert.equal(await exists(PATH), true);
    });
  }
});

test("a link to Calavera's text needs approval, which removes only the link, inside or outside the project", async () => {
  for (const target of ["shared/coderabbit.yaml", "../outside.yaml"]) {
    await inProject(async () => {
      await write(target, CREATED);
      await symlink(target, PATH);
      const found = await plan();
      const item = codeRabbit(found);
      assert.equal(item.edits, "cannot-detect");
      assert.equal(item.matchesRecords, false);
      assert.equal(
        item.reason,
        `${PATH} is a symbolic link, which no record covers; edits cannot be detected. eject removes only the link, not what it leads to.`,
      );
      assert.ok(selectEjectItems(found, { assumeYes: true }).leave.includes(item));
      await ejectApproved();
      assert.equal(await exists(PATH), false);
      assert.equal(await readFile(target, "utf8"), CREATED);
    });
  }
});

test("a link to an edited Calavera text is listed as edited", async () => {
  await inProject(async () => {
    await write("shared/coderabbit.yaml", `${CREATED}# mine\n`);
    await symlink("shared/coderabbit.yaml", PATH);
    const item = codeRabbit(await plan());
    assert.equal(item.edits, "edited");
    assert.equal(item.matchesRecords, false);
    assert.match(
      item.reason ?? "",
      /symbolic link.* so it holds edits\. eject removes only the link/,
    );
  });
});

/**
 * Plans with `before` in place, then changes the project, and checks that `executeEject` removes
 * nothing and names `.coderabbit.yaml`.
 *
 * @param {() => Promise<void>} before
 * @param {() => Promise<void>} change
 */
async function assertChangeStops(before, change) {
  await inProject(async () => {
    await before();
    const found = await plan();
    codeRabbit(found);
    await change();
    const snapshot = await snapshotDirectory("..");
    await assert.rejects(
      executeEject(selectEjectItems(found, { assumeYes: false }).remove),
      /eject stopped before removing anything, because \.coderabbit\.yaml changed since eject listed what it would remove/,
    );
    assert.deepEqual(await snapshotDirectory(".."), snapshot);
  });
}

const createdFile = () => write(PATH, CREATED);
const linkTo = (/** @type {string} */ target) => async () => {
  await write(target, CREATED);
  await symlink(target, PATH);
};

test("a .coderabbit.yaml edited after the plan stops the removal", async () => {
  await assertChangeStops(createdFile, () => writeFile(PATH, `${CREATED}# mine\n`));
});

test("a .coderabbit.yaml replaced by a link to identical text after the plan stops the removal", async () => {
  await assertChangeStops(createdFile, async () => {
    await write("shared/coderabbit.yaml", CREATED);
    await rm(PATH);
    await symlink("shared/coderabbit.yaml", PATH);
  });
});

test("a .coderabbit.yaml replaced by a folder after the plan stops the removal", async () => {
  await assertChangeStops(createdFile, async () => {
    await rm(PATH);
    await mkdir(PATH);
    await writeFile(join(PATH, "keep.txt"), "mine\n");
  });
});

test("a link at .coderabbit.yaml retargeted to identical text after the plan stops the removal", async () => {
  await assertChangeStops(linkTo("shared/a.yaml"), async () => {
    await write("shared/b.yaml", CREATED);
    await rm(PATH);
    await symlink("shared/b.yaml", PATH);
  });
});

test("a link retargeted in the middle of a chain after the plan stops the removal", async () => {
  await assertChangeStops(
    async () => {
      await write("shared/a.yaml", CREATED);
      await write("shared/b.yaml", CREATED);
      await symlink("shared/a.yaml", "middle.yaml");
      await symlink("middle.yaml", PATH);
    },
    async () => {
      await rm("middle.yaml");
      await symlink("shared/b.yaml", "middle.yaml");
    },
  );
});

test("a link replaced by the file it led to after the plan stops the removal", async () => {
  await assertChangeStops(linkTo("shared/a.yaml"), async () => {
    await rm(PATH);
    await writeFile(PATH, CREATED);
  });
});

test("a .coderabbit.yaml deleted after the plan counts as removed", async () => {
  await inProject(async () => {
    await createdFile();
    const found = await plan();
    const item = codeRabbit(found);
    await rm(PATH);
    const outcome = await executeEject(selectEjectItems(found, { assumeYes: true }).remove);
    assert.ok(outcome.removed.includes(item));
    assert.deepEqual(outcome.failed, []);
  });
});

test("a .coderabbit.yaml that shares its file with .gitignore is kept and reported through both paths", async () => {
  await inProject(async () => {
    await write(PATH, `${CREATED}${CACHE_BLOCK}`);
    await symlink(PATH, ".gitignore");
    const before = await snapshotDirectory(".");
    const found = await plan();
    assert.equal(named(found), false);
    assert.equal(
      found.items.some(({ path }) => path === ".gitignore"),
      false,
    );
    const reason = `.gitignore and ${PATH} lead to the same file, so changing it through one path would undo or lose the change through the other.`;
    for (const path of [PATH, ".gitignore"]) {
      assert.ok(
        found.reported.some((report) => report.path === path && report.reason.startsWith(reason)),
        `${path}: ${JSON.stringify(found.reported)}`,
      );
    }
    await ejectApproved();
    assert.deepEqual(await snapshotDirectory("."), before);
  });
});

test("a link at .coderabbit.yaml to a file eject edits is removed as a link, so it is not grouped", async () => {
  await inProject(async () => {
    await write(".gitignore", `${CREATED}${CACHE_BLOCK}`);
    await symlink(".gitignore", PATH);
    const found = await plan();
    const item = codeRabbit(found);
    assert.equal(item.edits, "edited");
    assert.ok(found.items.some(({ path }) => path === ".gitignore"));
    assert.deepEqual(found.reported, []);
    await ejectApproved();
    assert.equal(await exists(PATH), false);
    assert.equal(await readFile(".gitignore", "utf8"), CREATED);
  });
});

test("eject removes the .coderabbit.yaml between the cache block and the package folders", async () => {
  const { ejectSteps } = await import("../src/eject.js");
  const steps = ejectSteps([
    { kind: "state", path: "s", action: "delete", edits: "not-checked", matchesRecords: true },
    {
      kind: "package-folder",
      path: "p",
      action: "delete",
      edits: "cannot-detect",
      matchesRecords: false,
    },
    {
      kind: "coderabbit-config",
      path: PATH,
      action: "delete",
      edits: "unedited",
      matchesRecords: true,
    },
    {
      kind: "artifact-cache-block",
      path: ".gitignore",
      action: "edit",
      edits: "unedited",
      matchesRecords: true,
    },
    { kind: "cache", path: "c", action: "delete", edits: "not-checked", matchesRecords: true },
  ]);
  assert.deepEqual(
    steps.map(({ kind }) => kind),
    ["cache", "artifact-cache-block", "coderabbit-config", "package-folder", "state"],
  );
});
