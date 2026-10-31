import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { claudeHookCommandProblem, planClaudeSettings } from "../src/ai/claude-settings.js";
import { formatJSON } from "../src/utils/oxfmt-json.js";

const oxfmt = fileURLToPath(new URL("../../../node_modules/.bin/oxfmt", import.meta.url));
const skillDirectory = ".agents/skills/protected-branch-guard";
const guard = (mode, branch = "main") =>
  `node "$CLAUDE_PROJECT_DIR/${skillDirectory}/scripts/guard.mjs" ${mode} ${branch}`;
const handler = (mode, branch) => ({ type: "command", command: guard(mode, branch), timeout: 10 });
const sessionGroup = (branch) => ({ hooks: [handler("session-start", branch)] });
const toolGroup = (branch) => ({
  matcher: "Write|Edit|MultiEdit|NotebookEdit",
  hooks: [handler("claude-pre-tool-use", branch)],
});
const fragment = (branch = "main") => ({
  hooks: { SessionStart: [sessionGroup(branch)], PreToolUse: [toolGroup(branch)] },
});
const recordFor = (branch = "main") => fragment(branch).hooks;
const userGroup = { matcher: "Bash", hooks: [{ type: "command", command: "./scripts/check.sh" }] };

/** @param {Partial<Parameters<typeof planClaudeSettings>[0]>} options */
function plan(options) {
  return planClaudeSettings({
    path: ".claude/settings.json",
    contents: undefined,
    artifactId: "skill-protected-branch-guard",
    fragment: fragment(),
    recorded: undefined,
    skillDirectory,
    ...options,
  });
}

test("Given no settings file, when the hooks are planned, then apply writes the fragment's groups and records them", () => {
  const result = plan({});
  assert.equal(result.type, "write");
  assert.equal(result.contents, formatJSON(fragment()));
  assert.deepEqual(result.groups, recordFor());
  assert.deepEqual(result.changes, [
    { event: "SessionStart", action: "add", group: sessionGroup() },
    { event: "PreToolUse", action: "add", group: toolGroup() },
  ]);
});

test("Given settings of the person's own, when the hooks are planned, then every other key, event, and group is kept", () => {
  const settings = {
    $schema: "https://json.schemastore.org/claude-code-settings.json",
    permissions: { allow: ["Bash(pnpm test)"] },
    hooks: { PreToolUse: [userGroup], Stop: [{ hooks: [{ type: "command", command: "true" }] }] },
  };
  const result = plan({ contents: formatJSON(settings) });
  assert.equal(result.type, "update");
  assert.deepEqual(JSON.parse(/** @type {string} */ (result.contents)), {
    ...settings,
    hooks: {
      PreToolUse: [userGroup, toolGroup()],
      Stop: settings.hooks.Stop,
      SessionStart: [sessionGroup()],
    },
  });
});

test("Given the groups apply wrote, when nothing changed, then the plan is unchanged and the person's formatting is kept", () => {
  const contents = JSON.stringify({ hooks: recordFor() });
  const result = plan({ contents, recorded: recordFor() });
  assert.equal(result.type, "unchanged");
  assert.equal(result.contents, contents);
  assert.deepEqual(result.changes, []);
  assert.equal(plan({ contents }).type, "unchanged");
});

test("Given the groups apply wrote last, when the protected branch changes, then only those groups are replaced, in place", () => {
  const contents = formatJSON({ hooks: { PreToolUse: [userGroup, toolGroup(), userGroup] } });
  const result = plan({
    contents,
    recorded: { PreToolUse: [toolGroup()] },
    fragment: fragment("trunk"),
  });
  assert.equal(result.type, "update");
  assert.deepEqual(JSON.parse(/** @type {string} */ (result.contents)).hooks, {
    PreToolUse: [userGroup, toolGroup("trunk"), userGroup],
    SessionStart: [sessionGroup("trunk")],
  });
  assert.deepEqual(result.changes, [
    { event: "SessionStart", action: "add", group: sessionGroup("trunk") },
    { event: "PreToolUse", action: "replace", group: toolGroup("trunk"), previous: toolGroup() },
  ]);
  assert.deepEqual(result.groups, recordFor("trunk"));
});

test("Given a group apply wrote that the fragment no longer holds, when the hooks are planned, then it is removed", () => {
  const extra = { matcher: "Write", hooks: [handler("claude-pre-tool-use")] };
  const contents = formatJSON({
    hooks: { ...recordFor(), PreToolUse: [toolGroup(), extra, userGroup] },
  });
  const result = plan({ contents, recorded: { ...recordFor(), PreToolUse: [toolGroup(), extra] } });
  assert.deepEqual(result.changes, [{ event: "PreToolUse", action: "remove", previous: extra }]);
  assert.deepEqual(JSON.parse(/** @type {string} */ (result.contents)).hooks.PreToolUse, [
    toolGroup(),
    userGroup,
  ]);
});

test("Given an event the fragment no longer holds, when the hooks are planned, then apply removes the groups it wrote there", () => {
  const contents = formatJSON({ hooks: { ...recordFor(), Stop: [userGroup] } });
  const result = plan({
    contents,
    recorded: recordFor(),
    fragment: { hooks: { PreToolUse: [toolGroup()] } },
  });
  assert.equal(result.type, "update");
  assert.deepEqual(result.changes, [
    { event: "SessionStart", action: "remove", previous: sessionGroup() },
  ]);
  assert.deepEqual(JSON.parse(/** @type {string} */ (result.contents)).hooks, {
    PreToolUse: [toolGroup()],
    Stop: [userGroup],
  });
  assert.deepEqual(result.groups, { PreToolUse: [toolGroup()] });
});

test("Given the new group already in the file beside the old one, when the hooks are planned, then the old one is removed, not reported as a conflict", () => {
  const contents = formatJSON({
    hooks: { PreToolUse: [toolGroup(), toolGroup("trunk")], SessionStart: [sessionGroup("trunk")] },
  });
  const result = plan({ contents, recorded: recordFor(), fragment: fragment("trunk") });
  assert.equal(result.type, "update");
  assert.deepEqual(result.changes, [
    { event: "PreToolUse", action: "remove", previous: toolGroup() },
  ]);

  const a = { matcher: "Write", hooks: [handler("claude-pre-tool-use")] };
  const oldB = { matcher: "Edit", hooks: [handler("claude-pre-tool-use")] };
  const newB = { matcher: "Edit|MultiEdit", hooks: [handler("claude-pre-tool-use")] };
  const swapped = plan({
    contents: formatJSON({ hooks: { PreToolUse: [oldB, a] } }),
    recorded: { PreToolUse: [a, oldB] },
    fragment: { hooks: { PreToolUse: [a, newB] } },
  });
  assert.deepEqual(swapped.changes, [
    { event: "PreToolUse", action: "replace", group: newB, previous: oldB },
  ]);
  assert.deepEqual(JSON.parse(/** @type {string} */ (swapped.contents)).hooks.PreToolUse, [
    newB,
    a,
  ]);
});

test("Given settings a rewrite would change beyond the hooks, when the hooks are planned, then data loss is a conflict and reformatting is reported", () => {
  for (const [contents, problem] of [
    ['{"model": "opus", "hooks": {}, "model": "sonnet"}', /holds the key "model" more than once/],
    ['{"a": {"x": 1, "x": 2}}', /holds the key "x" more than once/],
    [
      '{"big": 12345678901234567890}',
      /the number 12345678901234567890, which Calavera would write as 12345678901234567000/,
    ],
    ['{"n": [1.50]}', /the number 1\.50, which Calavera would write as 1\.5/],
    ['{"n": -0}', /the number -0, which Calavera would write as 0/],
    ['{"cleanupPeriodDays": 1e400}', /the number 1e400, which is too large for Calavera to write/],
  ]) {
    const result = plan({ contents });
    assert.equal(result.type, "conflict", contents);
    assert.match(result.reason, problem, contents);
    assert.match(result.reason, /Calavera rewrites the whole file/, contents);
  }
  // Keys that only look alike, such as the same key in two objects, are not duplicates.
  assert.equal(
    plan({ contents: '{"a": {"x": 1}, "b": {"x": 1}, "x": "{\\"x\\": 1}"}' }).type,
    "update",
  );

  const fourSpaces = JSON.stringify({ permissions: { allow: ["Bash(ls)"] } }, null, 4);
  const reformatted = plan({ contents: fourSpaces });
  assert.equal(reformatted.type, "update");
  assert.equal(reformatted.reformatted, true);
  assert.equal(plan({ contents: formatJSON({ permissions: {} }) }).reformatted, false);
  assert.equal(plan({}).reformatted, false);
});

test("Given a guard handler merged into a group of the person's own, when it was edited, then the advice keeps the person's hooks", () => {
  const merged = {
    matcher: "Bash",
    hooks: [userGroup.hooks[0], handler("claude-pre-tool-use", "dev")],
  };
  const result = plan({
    contents: formatJSON({ hooks: { PreToolUse: [merged] } }),
    recorded: recordFor(),
  });
  assert.equal(result.type, "conflict");
  assert.match(
    result.reason,
    /remove only the hook in that group that runs \.agents\/skills\/protected-branch-guard\/, keep your other hooks,/,
  );
});

test("Given a record without groups for an event, when a skill group is there, then the conflict says Calavera never wrote it", () => {
  const contents = formatJSON({ hooks: { SessionStart: [sessionGroup("dev")] } });
  const result = plan({ contents, recorded: { PreToolUse: [toolGroup()] } });
  assert.equal(result.type, "conflict");
  assert.match(result.reason, /hooks\.SessionStart .* Calavera has no record of writing it/s);
  assert.equal(result.groups, undefined);
});

test("Given a person's group with a number too large to write, when it is a conflict, then the message still shows it", () => {
  const contents =
    '{"hooks": {"PreToolUse": [{"matcher": "Write", "hooks": [{"type": "command", "command": "node \\"$CLAUDE_PROJECT_DIR/.agents/skills/protected-branch-guard/x.mjs\\"", "timeout": 1e400}]}]}}';
  const result = plan({ contents });
  assert.equal(result.type, "conflict");
  assert.match(result.reason, /"timeout": 1e400|Infinity/);
});

test("Given apply removed the last group, when hooks is left empty, then the empty hooks object is removed too", () => {
  const contents = formatJSON({ model: "opus", hooks: { PreToolUse: [toolGroup()] } });
  const result = plan({
    contents,
    recorded: { PreToolUse: [toolGroup()] },
    fragment: { hooks: { SessionStart: [sessionGroup()] } },
  });
  assert.deepEqual(Object.keys(JSON.parse(/** @type {string} */ (result.contents)).hooks), [
    "SessionStart",
  ]);
  const emptied = plan({
    contents,
    recorded: { PreToolUse: [toolGroup()] },
    fragment: { hooks: {} },
  });
  assert.deepEqual(JSON.parse(/** @type {string} */ (emptied.contents)), { model: "opus" });
});

test("A group runs the skill only when its command names the skill directory from the project root", () => {
  const vendored = {
    hooks: [
      { type: "command", command: `node "$CLAUDE_PROJECT_DIR/vendor/${skillDirectory}/x.mjs"` },
    ],
  };
  const result = plan({ contents: formatJSON({ hooks: { PreToolUse: [vendored] } }) });
  assert.equal(result.type, "update");
  assert.deepEqual(JSON.parse(/** @type {string} */ (result.contents)).hooks.PreToolUse, [
    vendored,
    toolGroup(),
  ]);
  const relative = { hooks: [{ type: "command", command: `node ${skillDirectory}/x.mjs` }] };
  assert.equal(
    plan({ contents: formatJSON({ hooks: { PreToolUse: [relative] } }) }).type,
    "conflict",
  );
});

test("A damaged state record is a diagnosable error", () => {
  for (const recorded of [[toolGroup()], "x"]) {
    assert.throws(
      () => plan({ contents: "{}", recorded: /** @type {any} */ (recorded) }),
      /The Calavera state record for skill-protected-branch-guard is damaged: its hooks are not an object of hook events/,
    );
  }
  assert.throws(
    () => plan({ contents: "{}", recorded: /** @type {any} */ ({ PreToolUse: {} }) }),
    /The Calavera state record for skill-protected-branch-guard is damaged: its hooks\.PreToolUse is not a list of matcher groups/,
  );
});

test("Given a group the person removed, when the hooks are planned, then it is added again as a change the dry run shows", () => {
  const contents = formatJSON({ hooks: { SessionStart: [sessionGroup()] } });
  const result = plan({ contents, recorded: recordFor() });
  assert.equal(result.type, "update");
  assert.deepEqual(result.changes, [{ event: "PreToolUse", action: "add", group: toolGroup() }]);
});

test("Given a group the person edited, when the hooks are planned, then it is a conflict that names the file and event and shows both texts", () => {
  const edited = { ...toolGroup(), matcher: "Write|Edit" };
  const contents = formatJSON({ hooks: { PreToolUse: [edited] } });
  const result = plan({ contents, recorded: recordFor() });
  assert.equal(result.type, "conflict");
  assert.equal(result.contents, undefined);
  assert.match(
    result.reason,
    /^\.claude\/settings\.json: hooks\.PreToolUse holds a group that runs \.agents\/skills\/protected-branch-guard\/ and was edited since Calavera wrote it\./,
  );
  assert.ok(result.reason.includes('"matcher": "Write|Edit"'), result.reason);
  assert.ok(
    result.reason.includes('"matcher": "Write|Edit|MultiEdit|NotebookEdit"'),
    result.reason,
  );
  assert.match(result.reason, /remove that group and run apply again/);

  const unrecorded = plan({ contents });
  assert.equal(unrecorded.type, "conflict");
  assert.match(unrecorded.reason, /Calavera has no record of writing it/);
});

test("Given settings Calavera cannot read, when the hooks are planned, then it is a conflict and nothing is rewritten", () => {
  for (const [contents, problem] of [
    ["{ // comment\n}", /is not valid JSON/],
    ['{"a": 1,}', /is not valid JSON/],
    ["[]", /must hold a JSON object/],
    ['{"hooks": []}', /hooks must be an object/],
    ['{"hooks": {"PreToolUse": {}}}', /hooks\.PreToolUse must be an array/],
  ]) {
    const result = plan({ contents });
    assert.equal(result.type, "conflict", contents);
    assert.equal(result.contents, undefined, contents);
    assert.match(result.reason, problem, contents);
    assert.match(result.reason, /^\.claude\/settings\.json: /, contents);
  }
});

test("A fragment must hold only command hooks that run scripts from the artifact's skill directory", () => {
  const bad = (hooks) => () => plan({ fragment: { hooks } });
  assert.throws(() => plan({ fragment: { hooks: {}, permissions: {} } }), /may hold only "hooks"/);
  assert.throws(bad([]), /hooks must be an object/);
  assert.throws(bad({ PreToolUse: {} }), /hooks\.PreToolUse must be a non-empty array/);
  assert.throws(bad({ PreToolUse: [{ hooks: [] }] }), /must hold a non-empty hooks array/);
  assert.throws(
    bad({ PreToolUse: [{ matcher: 1, hooks: [handler("x")] }] }),
    /matcher must be a string/,
  );
  assert.throws(
    bad({ PreToolUse: [{ hooks: [handler("x")], extra: true }] }),
    /may hold only matcher and hooks/,
  );
  assert.throws(
    bad({ PreToolUse: [{ hooks: [{ type: "prompt", prompt: "x" }] }] }),
    /must be a command hook/,
  );
  assert.throws(
    bad({ PreToolUse: [{ hooks: [{ type: "command", command: guard("x"), timeout: 0 }] }] }),
    /timeout must be a positive whole number/,
  );
  assert.throws(
    bad({ PreToolUse: [{ hooks: [{ type: "command", command: "rm -rf /" }] }] }),
    /must start with node "\$CLAUDE_PROJECT_DIR\/\.agents\/skills\/protected-branch-guard\//,
  );
});

test("A Claude Code hook command runs a script from the skill directory through CLAUDE_PROJECT_DIR, with no other shell syntax", () => {
  assert.equal(claudeHookCommandProblem(guard("claude-pre-tool-use"), skillDirectory), undefined);
  for (const [command, problem] of [
    [
      `node .agents/skills/protected-branch-guard/scripts/guard.mjs x`,
      /must start with node "\$CLAUDE_PROJECT_DIR\//,
    ],
    [
      `node "$CLAUDE_PROJECT_DIR/.agents/skills/other/guard.mjs" x`,
      /must start with node "\$CLAUDE_PROJECT_DIR\//,
    ],
    [`node "$CLAUDE_PROJECT_DIR/${skillDirectory}/../x.mjs" x`, /"\.\." or "\."/],
    [`${guard("x")}; rm -rf /`, /only letters, digits/],
    [`${guard("x")} "$(id)"`, /only letters, digits/],
    [`node "$CLAUDE_PROJECT_DIR/${skillDirectory}/scripts/guard.mjs"x`, /must start with/],
    [
      `node "$CLAUDE_PROJECT_DIR/${skillDirectory}/scripts/a.mjs b.mjs" x`,
      /script path must not contain a space/,
    ],
    [`${guard("x")}\nrm -rf /`, /must be a single line/],
  ]) {
    assert.match(claudeHookCommandProblem(command, skillDirectory) ?? "", problem, command);
  }
});

test("The settings apply writes pass this repository's oxfmt --check", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "calavera-claude-settings-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, ".claude"));
  const settings = {
    permissions: { allow: ["Bash(pnpm test)", "Bash(git status)"], deny: [] },
    hooks: { PreToolUse: [userGroup] },
  };
  const result = plan({ contents: JSON.stringify(settings) });
  await writeFile(
    join(directory, ".claude", "settings.json"),
    /** @type {string} */ (result.contents),
  );

  const check = spawnSync(oxfmt, ["--check", "."], { cwd: directory, encoding: "utf8" });
  assert.equal(check.status, 0, `${check.stdout}\n${check.stderr}`);
  assert.match(check.stdout, /on 1 file/);
});
