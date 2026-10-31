import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  fillInputPlaceholders,
  planViteHookBlock,
  planViteHookBlockRemoval,
  viteHookCommandProblem,
} from "../src/ai/vite-hook-blocks.js";

const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const artifactId = "skill-protected-branch-guard";
const skillDirectory = ".agents/skills/protected-branch-guard";
const start = "# calavera:skill-protected-branch-guard:start";
const end = "# calavera:skill-protected-branch-guard:end";
const line = "node .agents/skills/protected-branch-guard/scripts/guard.mjs commit main";
const block = `${start}\n${line}\n${end}`;

/** @param {Partial<Parameters<typeof planViteHookBlock>[0]>} options */
function plan(options) {
  return planViteHookBlock({
    path: ".vite-hooks/pre-commit",
    artifactId,
    line,
    contents: undefined,
    recorded: undefined,
    ...options,
  });
}

test("Given no hook script, when the block is planned, then apply writes a script holding the block alone", () => {
  assert.deepEqual(plan({}), { type: "write", contents: `${block}\n`, block: line });
});

test("Given the scaffold's pre-commit, when the block is planned, then it goes first so the guard runs before vp staged", () => {
  assert.deepEqual(plan({ contents: "vp staged\n" }), {
    type: "update",
    contents: `${block}\nvp staged\n`,
    block: line,
  });
  assert.equal(plan({ contents: "" }).contents, `${block}\n`);
  assert.equal(plan({ contents: "vp staged" }).contents, `${block}\nvp staged`);
});

test("Given a script with a #! line, when the block is planned, then the #! line stays first", () => {
  assert.equal(
    plan({ contents: "#!/bin/sh\nset -u\nvp staged\n" }).contents,
    `#!/bin/sh\n${block}\nset -u\nvp staged\n`,
  );
  assert.equal(plan({ contents: "#!/bin/sh" }).contents, `#!/bin/sh\n${block}\n`);
});

test("Given the block apply wrote, when nothing changed, then the plan is unchanged and the text is kept", () => {
  const contents = `#!/bin/sh\n${block}\nvp staged\n`;
  assert.deepEqual(plan({ contents, recorded: line }), {
    type: "unchanged",
    contents,
    block: line,
  });
  // The text alone decides: a block that already holds the new line needs no record.
  assert.equal(plan({ contents }).type, "unchanged");
});

test("Given the block apply wrote last, when the protected branch changes, then only the block is replaced", () => {
  const before = `#!/bin/sh\necho mine\n${block}\nvp staged\n`;
  const trunk = line.replace(/main$/, "trunk");
  assert.deepEqual(plan({ contents: before, recorded: line, line: trunk }), {
    type: "update",
    contents: `#!/bin/sh\necho mine\n${start}\n${trunk}\n${end}\nvp staged\n`,
    block: trunk,
  });
});

test("Given a block the person edited, when the block is planned, then it is a conflict that names the file and shows both texts", () => {
  const edited = `${start}\n${line} # mine\n${end}\nvp staged\n`;
  const result = plan({ contents: edited, recorded: line, line: line.replace(/main$/, "trunk") });
  assert.equal(result.type, "conflict");
  assert.equal(result.contents, undefined);
  assert.equal(result.previousBlock, `${line} # mine`);
  assert.match(result.reason, /^\.vite-hooks\/pre-commit: /);
  assert.ok(result.reason.includes(`Calavera wrote:\n  ${line}\n`), result.reason);
  assert.ok(result.reason.includes(`The file now holds:\n  ${line} # mine\n`), result.reason);
  assert.match(result.reason, /remove the block, both markers included, and run apply again/);
});

test("Given a block with no record of what apply wrote, when it differs, then it is a conflict", () => {
  const result = plan({ contents: `${start}\nnode other.mjs\n${end}\n` });
  assert.equal(result.type, "conflict");
  assert.match(result.reason, /Calavera has no record of writing it/);
});

test("Given broken markers, when the block is planned, then it is a conflict, because apply cannot tell where its block ends", () => {
  for (const [contents, problem] of [
    [`${start}\n${line}\nvp staged\n`, /has a start marker without an end marker/],
    [`${line}\n${end}\nvp staged\n`, /has an end marker without a start marker/],
    [`${end}\n${line}\n${start}\n`, /an end marker that comes before its start marker/],
    [`${block}\n${block}\n`, /has 2 start markers and 2 end markers/],
  ]) {
    const result = plan({ contents, recorded: line });
    assert.equal(result.type, "conflict", contents);
    assert.match(result.reason, problem, contents);
    assert.match(result.reason, /# calavera:skill-protected-branch-guard:start/);
  }
});

test("Given another artifact's block, when this block is planned, then the other block is kept as it is", () => {
  const other =
    "# calavera:skill-other:start\nnode .agents/skills/other/run.mjs\n# calavera:skill-other:end";
  assert.equal(
    plan({ contents: `${other}\nvp staged\n` }).contents,
    `${block}\n${other}\nvp staged\n`,
  );
  assert.equal(
    plan({ contents: `${other}\n${block}\n`, recorded: line, line: `${line}x` }).contents,
    `${other}\n${start}\n${line}x\n${end}\n`,
  );
});

test("Markers are matched as whole lines, ignoring trailing whitespace", () => {
  const contents = `${start}  \n${line}\n${end}\r\nvp staged\n`;
  assert.equal(plan({ contents, recorded: line }).type, "unchanged");
});

test("Given a marker the person changed, such as an indented block inside an if, then it is a conflict, not a second block", () => {
  const wrapped = `if [ -z "$CI" ]; then\n  ${start}\n  ${line}\n  ${end}\nfi\nvp staged\n`;
  const result = plan({ contents: wrapped, recorded: line });
  assert.equal(result.type, "conflict");
  assert.equal(result.contents, undefined);
  assert.match(
    result.reason,
    /a marker line was changed: " {2}# calavera:skill-protected-branch-guard:start"/,
  );
  for (const contents of [
    `${start} (managed)\n${line}\n${end}\n`,
    `echo "${start}"\nvp staged\n`,
  ]) {
    assert.equal(plan({ contents, recorded: line }).type, "conflict", contents);
  }
});

test("Given a script with Windows line endings, when the block is planned, then it keeps them and still matches its block", () => {
  const crlf = `#!/bin/sh\r\n${start}\r\n${line}\r\n${end}\r\nvp staged\r\n`;
  assert.equal(plan({ contents: crlf, recorded: line }).type, "unchanged");
  const trunk = line.replace(/main$/, "trunk");
  assert.equal(
    plan({ contents: crlf, recorded: line, line: trunk }).contents,
    crlf.replace(`${line}\r\n`, `${trunk}\r\n`),
  );
  assert.equal(
    plan({ contents: "#!/bin/sh\r\nvp staged\r\n" }).contents,
    `#!/bin/sh\r\n${start}\r\n${line}\r\n${end}\r\nvp staged\r\n`,
  );
  assert.equal(
    plan({ contents: "vp staged\r\n" }).contents,
    `${start}\r\n${line}\r\n${end}\r\nvp staged\r\n`,
  );
});

test("A command line that holds a line break is refused before it can add lines to the script", () => {
  for (const bad of [`${line}\n${end}\nrm -rf x`, `${line}\r`]) {
    assert.throws(() => plan({ line: bad }), /must be a single line/);
  }
});

test("Input placeholders are filled from the recorded inputs, and an unknown or malformed placeholder stops apply", () => {
  assert.equal(
    fillInputPlaceholders("guard.mjs commit {{protectedBranch}} {{protectedBranch}}", {
      protectedBranch: "main",
    }),
    "guard.mjs commit main main",
  );
  assert.throws(
    () => fillInputPlaceholders("guard.mjs {{branch}}", { protectedBranch: "main" }),
    /\{\{branch\}\} has no recorded value; the recorded inputs are protectedBranch/,
  );
  assert.throws(() => fillInputPlaceholders("guard.mjs {{branch}}", {}), /no inputs are recorded/);
  for (const name of ["toString", "constructor", "valueOf", "hasOwnProperty"]) {
    assert.throws(() => fillInputPlaceholders(`x {{${name}}}`, {}), /has no recorded value/, name);
  }
  for (const template of [
    "guard.mjs {{ protectedBranch }}",
    "guard.mjs {{protectedBranch}",
    "{{}}",
  ]) {
    assert.throws(
      () => fillInputPlaceholders(template, { protectedBranch: "main" }),
      /malformed placeholder/,
      template,
    );
  }
});

test("A hook command must run a script from the artifact's own skill directory, with no shell syntax", () => {
  assert.equal(viteHookCommandProblem(line, skillDirectory), undefined);
  for (const [command, problem] of [
    ["vp staged", /must start with "node \.agents\/skills\/protected-branch-guard\/"/],
    ["node .agents/skills/other/guard.mjs commit main", /must start with/],
    ["node .agents/skills/protected-branch-guard", /must start with/],
    ["node .agents/skills/protected-branch-guard/../other/guard.mjs", /"\.\." or "\."/],
    ["node .agents/skills/protected-branch-guard/./scripts/guard.mjs", /"\.\." or "\."/],
    [`${line}; rm -rf /`, /only letters, digits/],
    [`${line} $(id)`, /only letters, digits/],
    [`${line} | cat`, /only letters, digits/],
    [`${line}  main`, /single spaces/],
    [` ${line}`, /single spaces/],
    [`${line} -x`, /must not start with "-"/],
    ["node .agents/skills/protected-branch-guard/scripts/", /empty path segment/],
    ["node .agents/skills/protected-branch-guard//guard.mjs", /empty path segment/],
    ["node .agents/skills/protected-branch-guard/scripts/guard.sh", /\.mjs, \.cjs, or \.js/],
  ]) {
    assert.match(viteHookCommandProblem(command, skillDirectory) ?? "", problem, command);
  }
  assert.equal(viteHookCommandProblem(line, `${skillDirectory}/`), undefined);
});

test("Oxfmt does not format an extensionless hook script, so vp staged leaves a written one unchanged", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-vite-hooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".vite-hooks"));
  const path = join(directory, ".vite-hooks", "pre-commit");
  const contents = plan({ contents: "vp staged\n" }).contents;
  await writeFile(path, contents);

  const result = spawnSync(
    join(repositoryRoot, "node_modules", ".bin", "oxfmt"),
    ["--write", "--no-error-on-unmatched-pattern", "."],
    { cwd: directory, encoding: "utf8" },
  );
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /on 0 files/);
  assert.equal(await readFile(path, "utf8"), contents);
});

test("A written block runs first under sh -e, so a refusing guard stops the lines after it", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-vite-hooks-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const scripts = join(directory, skillDirectory, "scripts");
  await mkdir(scripts, { recursive: true });
  await writeFile(join(scripts, "guard.mjs"), "process.exitCode = Number(process.argv[2]);\n");
  const path = join(directory, "pre-commit");
  const runHook = async (code) => {
    const hookLine = `node ${skillDirectory}/scripts/guard.mjs ${code}`;
    await writeFile(path, plan({ contents: "echo after > after.txt\n", line: hookLine }).contents);
    await rm(join(directory, "after.txt"), { force: true });
    return spawnSync("sh", ["-e", path], { cwd: directory, encoding: "utf8" }).status;
  };

  assert.equal(await runHook(1), 1);
  await assert.rejects(readFile(join(directory, "after.txt")), { code: "ENOENT" });
  assert.equal(await runHook(0), 0);
  assert.equal(await readFile(join(directory, "after.txt"), "utf8"), "after\n");
});

test("Given a block apply wrote for a hook the artifact no longer wires, when it is unchanged, then only the block is removed", () => {
  const remove = (contents, recorded = line) =>
    planViteHookBlockRemoval({ path: ".vite-hooks/pre-push", contents, artifactId, recorded });
  assert.deepEqual(remove(`#!/bin/sh\n${block}\nvp staged\n`), {
    type: "update",
    contents: "#!/bin/sh\nvp staged\n",
  });
  assert.equal(remove(`${block}\n`).contents, "");
  assert.equal(remove("vp staged\n").type, "unchanged");
  assert.deepEqual(remove(undefined), { type: "unchanged" });
  assert.equal(remove(`${start}\r\n${line}\r\n${end}\r\nvp staged\r\n`).contents, "vp staged\r\n");
});

test("Given an edited or broken block for a dropped hook, when its removal is planned, then it is a conflict and nothing is removed", () => {
  const remove = (contents) =>
    planViteHookBlockRemoval({
      path: ".vite-hooks/pre-push",
      contents,
      artifactId,
      recorded: line,
    });
  const edited = remove(`${start}\n${line} # mine\n${end}\n`);
  assert.equal(edited.type, "conflict");
  assert.equal(edited.contents, undefined);
  assert.match(edited.reason, /no longer wires this hook.*was edited since Calavera wrote it/s);
  assert.match(edited.reason, /The file now holds:\n {2}.* # mine/);
  assert.equal(remove(`${start}\n${line}\n`).type, "conflict");
});
