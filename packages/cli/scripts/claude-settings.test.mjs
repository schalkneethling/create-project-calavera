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
