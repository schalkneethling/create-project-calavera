// Issue #398: `artifacts status --check-updates` reports, in ordinary output and in `--json`, each
// artifact's installed and latest version, a release-notes link derived from the package's own
// `repository` metadata, and a command that applies the update as printed. Without
// `--check-updates`, status contacts no registry.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import { artifactReleaseNotesUrl, formatArtifactStatus } from "../src/artifact-status-report.js";
import { parseArgs } from "../src/index.js";
import {
  buildRecipe,
  projectLocalCalaveraCommand,
  projectLocalCommandCatalog,
} from "../src/recipe.js";
import { stubRegistry } from "./artifact-registry-stub.mjs";
import { snapshotDirectory } from "./project-snapshot.mjs";

const REPOSITORY = {
  type: "git",
  url: "git+ssh://git@github.com/schalkneethling/create-project-calavera.git",
};

/** @param {string} id */
function packageRepository(id) {
  return { ...REPOSITORY, directory: `packages/artifacts/${id}` };
}

/** @param {string} id @param {string} anchor */
function changelogUrl(id, anchor) {
  return `https://github.com/schalkneethling/create-project-calavera/blob/HEAD/packages/artifacts/${id}/CHANGELOG.md#${anchor}`;
}

/**
 * A status registry: answers each resolve with the release on the requested channel and records
 * every request, so a test can assert that status made none.
 *
 * @param {Record<string, Partial<Record<"latest" | "next", string>>>} releases
 * @param {Record<string, unknown>} [repositories] The `repository` metadata per artifact; an absent entry means the package has none.
 */
function statusRegistry(releases, repositories = {}) {
  /** @type {{ id: string, tag?: string }[]} */
  const requests = [];
  return {
    requests,
    resolve: async (/** @type {{ id: string, tag?: string, cache: string }} */ request) => {
      requests.push({ id: request.id, tag: request.tag });
      const artifact = artifactForId(request.id);
      assert.ok(artifact);
      const tag = request.tag ?? "latest";
      const version = releases[request.id]?.[/** @type {"latest" | "next"} */ (tag)];
      assert.ok(version, `No ${tag} release for ${request.id}`);
      return {
        artifact,
        packageName: artifact.packageName,
        version,
        resolved: `https://registry.example/${request.id}-${version}.tgz`,
        integrity: `sha512-${"a".repeat(86)}==`,
        tag,
        cache: request.cache,
        offline: false,
        repository: repositories[request.id] ?? null,
      };
    },
    extract: async () => {
      throw new Error("Status never extracts a package.");
    },
  };
}

/**
 * Runs `callback` in a new project whose recipe selects `ids` and whose lock holds `locked` at the
 * given version and channel, installed through the registry stand-in.
 *
 * @param {{ ids: string[], locked: { id: string, version: string, tag?: "latest" | "next" }[], packageManager?: string, config?: string }} setup
 * @param {() => Promise<void>} callback
 */
async function inProject({ ids, locked, packageManager = "npm", config }, callback) {
  const originalDirectory = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "calavera-artifact-update-status-"));
  try {
    process.chdir(directory);
    const configPath = config ?? "calavera.config.json";
    if (locked.length > 0) {
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(
        configPath,
        `${JSON.stringify(
          {
            ...buildRecipe("minimal", [], packageManager),
            ai: locked.map(({ id }) => ({ id })),
          },
          null,
          2,
        )}\n`,
      );
      const releases = stubRegistry(new Map(locked.map(({ id, version }) => [id, version])));
      await runArtifactCommand(
        { config: configPath, dryRun: false, artifactAction: "install" },
        releases,
      );
      // An update keeps every other lock entry, so it moves a single artifact onto `next`.
      for (const { id } of locked.filter(({ tag }) => tag === "next")) {
        await runArtifactCommand(
          {
            config: configPath,
            dryRun: false,
            artifactAction: "update",
            artifactId: id,
            artifactTag: "next",
          },
          releases,
        );
      }
    }
    await mkdir(dirname(configPath), { recursive: true });
    await writeFile(
      configPath,
      `${JSON.stringify(
        { ...buildRecipe("minimal", [], packageManager), ai: ids.map((id) => ({ id })) },
        null,
        2,
      )}\n`,
    );
    await callback();
  } finally {
    process.chdir(originalDirectory);
    await rm(directory, { recursive: true, force: true });
  }
}

/** @param {{ config?: string, checkUpdates?: boolean, artifactAction?: string }} [options] */
function statusOptions({
  config = "calavera.config.json",
  checkUpdates = true,
  artifactAction = "status",
} = {}) {
  return { config, dryRun: false, artifactAction, checkUpdates };
}

/** @param {ReturnType<typeof formatArtifactStatus>} lines */
function messages(lines) {
  return lines.map(({ message }) => message);
}

/**
 * The arguments a printed command passes to Calavera: the tokens after the package manager's
 * runner prefix.
 *
 * @param {string} command
 * @param {keyof typeof projectLocalCommandCatalog} packageManager
 */
function calaveraArguments(command, packageManager) {
  const runner = projectLocalCommandCatalog[packageManager].runCalavera;
  assert.ok(command.startsWith(`${runner} `), `${command} does not start with ${runner}`);
  return command.slice(runner.length + 1).split(" ");
}

test("status without --check-updates contacts no registry and says how to check", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      const registry = statusRegistry({ "skill-project-goal": { latest: "0.3.0" } });
      const result = await runArtifactCommand(statusOptions({ checkUpdates: false }), registry);

      assert.deepEqual(registry.requests, []);
      assert.equal(result.offline, true);
      const [artifact] = result.artifacts;
      assert.equal(artifact.latestVersion, null);
      assert.equal(artifact.updateAvailable, false);
      assert.equal(artifact.releaseNotesUrl, null);
      assert.equal(artifact.updateCommand, null);
      assert.equal(result.updateAllCommand, null);
      assert.equal(
        result.checkUpdatesCommand,
        "npm create project-calavera artifacts status -- --check-updates",
      );

      const printed = messages(formatArtifactStatus(result));
      assert.ok(printed.includes("skill-project-goal  0.2.1 (latest)"), printed.join("\n"));
      assert.ok(
        printed.some((line) => line.endsWith(result.checkUpdatesCommand)),
        printed.join("\n"),
      );
      assert.ok(!printed.some((line) => line.includes("up to date")), printed.join("\n"));
    },
  );
});

test("an outdated artifact reports its release notes and a command that updates it", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      const registry = statusRegistry(
        { "skill-project-goal": { latest: "0.3.0" } },
        { "skill-project-goal": packageRepository("skill-project-goal") },
      );
      const result = await runArtifactCommand(statusOptions(), registry);

      assert.deepEqual(registry.requests, [{ id: "skill-project-goal", tag: "latest" }]);
      const [artifact] = result.artifacts;
      assert.equal(artifact.version, "0.2.1");
      assert.equal(artifact.latestVersion, "0.3.0");
      assert.equal(artifact.updateAvailable, true);
      assert.equal(artifact.releaseNotesUrl, changelogUrl("skill-project-goal", "030"));
      assert.equal(
        artifact.updateCommand,
        "npm create project-calavera artifacts update skill-project-goal",
      );
      // With one artifact selected, the targeted command is the whole update.
      assert.equal(result.updateAllCommand, null);
      assert.equal(result.checkUpdatesCommand, null);

      assert.deepEqual(messages(formatArtifactStatus(result)), [
        "skill-project-goal  0.2.1 → 0.3.0 (latest)",
        `  Release notes: ${artifact.releaseNotesUrl}`,
        `  Update: ${artifact.updateCommand}`,
      ]);
    },
  );
});

test("current artifacts print a success message and no update commands", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-code-review"],
      locked: [
        { id: "skill-project-goal", version: "0.3.0" },
        { id: "skill-code-review", version: "0.2.1" },
      ],
    },
    async () => {
      const registry = statusRegistry(
        {
          "skill-project-goal": { latest: "0.3.0" },
          "skill-code-review": { latest: "0.2.1" },
        },
        { "skill-project-goal": packageRepository("skill-project-goal") },
      );
      const result = await runArtifactCommand(statusOptions(), registry);

      for (const artifact of result.artifacts) {
        assert.equal(artifact.updateAvailable, false);
        assert.equal(artifact.releaseNotesUrl, null);
        assert.equal(artifact.updateCommand, null);
      }
      assert.equal(result.updateAllCommand, null);

      const lines = formatArtifactStatus(result);
      assert.deepEqual(messages(lines), [
        "skill-project-goal  0.3.0, up to date (latest)",
        "skill-code-review  0.2.1, up to date (latest)",
        "Every artifact is up to date on its channel.",
      ]);
      assert.equal(lines.at(-1)?.level, "success");
    },
  );
});

test("a prerelease-channel artifact updates on its own channel", async () => {
  await inProject(
    {
      ids: ["skill-release-with-confidence"],
      locked: [{ id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" }],
    },
    async () => {
      const registry = statusRegistry(
        { "skill-release-with-confidence": { latest: "0.2.3", next: "0.3.0-next.1" } },
        { "skill-release-with-confidence": packageRepository("skill-release-with-confidence") },
      );
      const result = await runArtifactCommand(statusOptions(), registry);

      assert.deepEqual(registry.requests, [{ id: "skill-release-with-confidence", tag: "next" }]);
      const [artifact] = result.artifacts;
      assert.equal(artifact.latestVersion, "0.3.0-next.1");
      assert.equal(
        artifact.releaseNotesUrl,
        changelogUrl("skill-release-with-confidence", "030-next1"),
      );
      assert.equal(
        artifact.updateCommand,
        "npm create project-calavera artifacts update skill-release-with-confidence -- --tag next",
      );
      assert.ok(
        messages(formatArtifactStatus(result)).includes(
          "skill-release-with-confidence  0.3.0-next.0 → 0.3.0-next.1 (next)",
        ),
      );
    },
  );
});

test("artifacts on different channels get no all-artifacts command", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-release-with-confidence"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
      ],
    },
    async () => {
      const registry = statusRegistry({
        "skill-project-goal": { latest: "0.3.0" },
        "skill-release-with-confidence": { next: "0.3.0-next.1" },
      });
      const result = await runArtifactCommand(statusOptions(), registry);

      assert.equal(result.updateAllCommand, null);
      const printed = messages(formatArtifactStatus(result));
      assert.ok(
        printed.includes(
          "These artifacts follow different channels, and --all would move every one to a single channel, so run each Update command above instead.",
        ),
        printed.join("\n"),
      );
    },
  );
});

test("an unlocked selection reports the latest version and the install command", async () => {
  await inProject({ ids: ["skill-project-goal"], locked: [] }, async () => {
    const registry = statusRegistry({ "skill-project-goal": { latest: "0.3.0" } });
    const result = await runArtifactCommand(statusOptions(), registry);

    const [artifact] = result.artifacts;
    assert.equal(artifact.version, null);
    assert.equal(artifact.latestVersion, "0.3.0");
    assert.equal(artifact.updateAvailable, false);
    assert.equal(artifact.updateCommand, null);
    assert.equal(artifact.installCommand, "npm create project-calavera artifacts install");
    assert.deepEqual(messages(formatArtifactStatus(result)), [
      "skill-project-goal  not installed, latest 0.3.0 (latest)",
      `  Install: ${artifact.installCommand}`,
    ]);
  });
});

test("missing or untrusted release metadata leaves the update visible without a link", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-code-review", "skill-css-tokens"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-code-review", version: "0.2.1" },
        { id: "skill-css-tokens", version: "0.2.1" },
      ],
    },
    async () => {
      const registry = statusRegistry(
        {
          "skill-project-goal": { latest: "0.3.0" },
          "skill-code-review": { latest: "0.3.0" },
          "skill-css-tokens": { latest: "0.3.0" },
        },
        {
          // Not GitHub, so no link is derived from it.
          "skill-code-review": { type: "git", url: "https://gitlab.example/owner/repo.git" },
          // A directory that leaves the repository is not trusted.
          "skill-css-tokens": { ...REPOSITORY, directory: "../elsewhere" },
        },
      );
      const result = await runArtifactCommand(statusOptions(), registry);

      for (const artifact of result.artifacts) {
        assert.equal(artifact.updateAvailable, true, artifact.id);
        assert.equal(artifact.releaseNotesUrl, null, artifact.id);
        assert.equal(
          artifact.updateCommand,
          `npm create project-calavera artifacts update ${artifact.id}`,
        );
      }
      const printed = messages(formatArtifactStatus(result));
      assert.ok(
        printed.includes(
          "  Release notes: the package metadata names no GitHub repository, so there is no link",
        ),
        printed.join("\n"),
      );
      assert.ok(
        printed.includes("  Update: npm create project-calavera artifacts update skill-css-tokens"),
      );
    },
  );
});

test("release notes accept the repository forms npm publishes", async () => {
  const forms = [
    "github:schalkneethling/create-project-calavera",
    "schalkneethling/create-project-calavera",
    "https://github.com/schalkneethling/create-project-calavera",
    { url: "git+https://github.com/schalkneethling/create-project-calavera.git" },
    { url: "git@github.com:schalkneethling/create-project-calavera.git" },
  ];
  for (const repository of forms) {
    await inProject(
      { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
      async () => {
        const registry = statusRegistry(
          { "skill-project-goal": { latest: "0.3.0" } },
          { "skill-project-goal": repository },
        );
        const [artifact] = (await runArtifactCommand(statusOptions(), registry)).artifacts;
        // Without a directory, the changelog is the one at the repository root.
        assert.equal(
          artifact.releaseNotesUrl,
          "https://github.com/schalkneethling/create-project-calavera/blob/HEAD/CHANGELOG.md#030",
          JSON.stringify(repository),
        );
      },
    );
  }
});

test("printed commands use the project's package manager and a non-default recipe path", async () => {
  await inProject(
    {
      ids: ["skill-release-with-confidence", "skill-project-goal"],
      locked: [
        { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
        { id: "skill-project-goal", version: "0.3.0-next.0", tag: "next" },
      ],
      packageManager: "pnpm",
      config: "recipes/calavera.json",
    },
    async () => {
      const registry = statusRegistry({
        "skill-release-with-confidence": { next: "0.3.0-next.1" },
        "skill-project-goal": { next: "0.3.0-next.0" },
      });
      const result = await runArtifactCommand(
        statusOptions({ config: "recipes/calavera.json" }),
        registry,
      );
      const [artifact] = result.artifacts;
      assert.equal(
        artifact.updateCommand,
        "pnpm dlx create-project-calavera artifacts update skill-release-with-confidence --tag next --config recipes/calavera.json",
      );
      assert.equal(
        result.updateAllCommand,
        "pnpm dlx create-project-calavera artifacts update --all --tag next --config recipes/calavera.json",
      );
    },
  );
});

test("printed update commands parse to the update they describe", () => {
  for (const packageManager of /** @type {const} */ (["npm", "pnpm", "yarn", "bun"])) {
    const runner = projectLocalCommandCatalog[packageManager].runCalavera;
    const separator = packageManager === "npm" ? " --" : "";
    const targeted = parseArgs(
      calaveraArguments(
        `${runner} artifacts update skill-project-goal${separator} --tag next`,
        packageManager,
      ),
    );
    assert.equal(targeted.command, "artifacts");
    assert.equal(targeted.artifactAction, "update");
    assert.equal(targeted.artifactId, "skill-project-goal");
    assert.equal(targeted.artifactTag, "next");

    const all = parseArgs(
      calaveraArguments(`${runner} artifacts update${separator} --all`, packageManager),
    );
    assert.equal(all.artifactAction, "update");
    assert.equal(all.artifactAll, true);
    assert.equal(all.artifactTag, "latest");
  }
});

test("the printed commands run the update and keep the local-edit safeguard", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-code-review"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-code-review", version: "0.2.1" },
      ],
    },
    async () => {
      const result = await runArtifactCommand(
        statusOptions(),
        statusRegistry({
          "skill-project-goal": { latest: "0.3.0" },
          "skill-code-review": { latest: "0.3.0" },
        }),
      );
      const [goal] = result.artifacts;
      const releases = new Map([
        ["skill-project-goal", "0.3.0"],
        ["skill-code-review", "0.3.0"],
      ]);

      const skillPath = ".agents/skills/project-goal/SKILL.md";
      const original = await readFile(skillPath, "utf8");
      await writeFile(skillPath, "local edit\n");
      assert.ok(
        messages(
          formatArtifactStatus(
            await runArtifactCommand(
              statusOptions({ checkUpdates: false }),
              stubRegistry(releases),
            ),
          ),
        ).includes("skill-project-goal  0.2.1 (latest), locally edited"),
      );
      for (const command of [goal.updateCommand, result.updateAllCommand]) {
        const options = parseArgs(calaveraArguments(command, "npm"));
        await assert.rejects(
          () => runArtifactCommand(options, stubRegistry(releases)),
          /Refusing to overwrite existing AI artifact/,
          command,
        );
      }

      await writeFile(skillPath, original);
      const updated = await runArtifactCommand(
        parseArgs(calaveraArguments(result.updateAllCommand, "npm")),
        stubRegistry(releases),
      );
      assert.deepEqual(
        updated.artifacts.map(({ id, version }) => [id, version]),
        [
          ["skill-project-goal", "0.3.0"],
          ["skill-code-review", "0.3.0"],
        ],
      );
    },
  );
});

// Status writes no lock, state, output, or recipe. The real resolver can still fill the npm cache
// in .calavera/cache, which the README documents; this stand-in has no cache to fill.
test("status with --check-updates writes nothing in the project", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      const before = await snapshotDirectory();
      await runArtifactCommand(
        statusOptions(),
        statusRegistry({ "skill-project-goal": { latest: "0.3.0" } }),
      );
      assert.deepEqual(await snapshotDirectory(), before);
    },
  );
});

test("ordinary output carries the same update information as --json", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-code-review", "skill-css-tokens"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-code-review", version: "0.2.1" },
      ],
    },
    async () => {
      const result = await runArtifactCommand(
        statusOptions({ artifactAction: "doctor" }),
        statusRegistry(
          {
            "skill-project-goal": { latest: "0.3.0" },
            "skill-code-review": { latest: "0.2.1" },
            "skill-css-tokens": { latest: "0.2.1" },
          },
          { "skill-project-goal": packageRepository("skill-project-goal") },
        ),
      );
      const printed = messages(formatArtifactStatus(result)).join("\n");
      const fromJson = [
        result.updateAllCommand,
        ...result.artifacts.flatMap((artifact) => [
          artifact.id,
          artifact.version,
          artifact.latestVersion,
          artifact.releaseNotesUrl,
          artifact.updateCommand,
          artifact.installCommand,
        ]),
      ].filter((value) => value !== null);
      for (const value of fromJson) assert.ok(printed.includes(value), `${value}\n${printed}`);
    },
  );
});

test("release notes refuse repository metadata that names no single GitHub repository", () => {
  const github = "git+https://github.com/schalkneethling/create-project-calavera.git";
  for (const repository of [
    undefined,
    null,
    42,
    { url: 42 },
    "not a url",
    "https://github.com/schalkneethling",
    "https://github.com/schalkneethling/create-project-calavera/tree/main",
    "https://github.com/./create-project-calavera",
    "https://github.com/schalkneethling/..",
    "https://github.com/schalkneethling/create project",
    "https://github.com.example/schalkneethling/create-project-calavera",
    "github:schalkneethling/repo/extra",
    "github:./create-project-calavera",
    "github:schalkneethling/..",
    "owner/repo/extra",
    { url: github, directory: "/packages/artifacts/skill-project-goal" },
    { url: github, directory: "packages\\artifacts" },
    { url: github, directory: "packages/../.." },
    { url: github, directory: 7 },
  ]) {
    assert.equal(artifactReleaseNotesUrl(repository, "0.3.0"), null, JSON.stringify(repository));
  }
});

test("release notes normalize the directory and anchor the version heading", () => {
  const github = "git+https://github.com/schalkneethling/create-project-calavera.git";
  const base = "https://github.com/schalkneethling/create-project-calavera/blob/HEAD";
  assert.equal(
    artifactReleaseNotesUrl(
      { url: github, directory: "./packages//artifacts/skill-project-goal/" },
      "0.3.0",
    ),
    `${base}/packages/artifacts/skill-project-goal/CHANGELOG.md#030`,
  );
  assert.equal(
    artifactReleaseNotesUrl(
      { url: `${github}/`, directory: "packages/my artifact" },
      "1.0.0-RC.1+build.5",
    ),
    `${base}/packages/my%20artifact/CHANGELOG.md#100-rc1build5`,
  );
  assert.equal(
    artifactReleaseNotesUrl("https://github.com/schalkneethling/site.github.io.git", "0.3.0"),
    "https://github.com/schalkneethling/site.github.io/blob/HEAD/CHANGELOG.md#030",
  );
  assert.equal(
    artifactReleaseNotesUrl("https://github.com/schalkneethling/create-project-calavera/", "0.3.0"),
    `${base}/CHANGELOG.md#030`,
  );
});

/**
 * One locked artifact as status reports it, with `overrides`.
 *
 * @param {Partial<import("../src/artifact-status-report.js").ArtifactStatusEntry>} overrides
 * @returns {import("../src/artifact-status-report.js").ArtifactStatusEntry}
 */
function entry(overrides) {
  return {
    id: "skill-project-goal",
    version: "0.2.1",
    tag: "latest",
    installed: true,
    managed: true,
    locallyEdited: false,
    latestVersion: null,
    updateAvailable: false,
    releaseNotesUrl: null,
    updateCommand: null,
    installCommand: null,
    ...overrides,
  };
}

test("status output names missing, unmanaged, and edited outputs, and an empty status", () => {
  const report = { offline: true, updateAllCommand: null, checkUpdatesCommand: "check" };
  assert.deepEqual(messages(formatArtifactStatus({ ...report, artifacts: [] })), [
    "The recipe selects no artifacts, and the artifact lock holds none.",
  ]);
  assert.deepEqual(
    messages(
      formatArtifactStatus({
        ...report,
        artifacts: [
          entry({ installed: false }),
          entry({ managed: false, locallyEdited: true }),
          entry({ version: null, installCommand: "install" }),
        ],
      }),
    ),
    [
      "skill-project-goal  0.2.1 (latest), files missing",
      "skill-project-goal  0.2.1 (latest), not managed by Calavera, locally edited",
      "skill-project-goal  not installed (latest)",
      "  Install: install",
      "Update checks are off, so Calavera did not contact the registry. To check for updates, run: check",
    ],
  );
});

test("status output explains an update for an artifact the recipe does not select", () => {
  const lines = messages(
    formatArtifactStatus({
      offline: false,
      updateAllCommand: null,
      checkUpdatesCommand: null,
      artifacts: [
        entry({ latestVersion: "0.3.0", updateAvailable: true, updateCommand: "update one" }),
        entry({ id: "skill-code-review", latestVersion: "0.3.0", updateAvailable: true }),
      ],
    }),
  );
  assert.deepEqual(lines, [
    "skill-project-goal  0.2.1 → 0.3.0 (latest)",
    "  Release notes: the package metadata names no GitHub repository, so there is no link",
    "  Update: update one",
    "skill-code-review  0.2.1 → 0.3.0 (latest)",
    "  Release notes: the package metadata names no GitHub repository, so there is no link",
    "  Update: the recipe does not select this artifact, so artifacts update cannot update it",
  ]);
});

test("a locked artifact the recipe no longer selects gets no update command", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-css-tokens"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-css-tokens", version: "0.2.1" },
        { id: "skill-code-review", version: "0.2.1", tag: "next" },
      ],
    },
    async () => {
      const result = await runArtifactCommand(
        statusOptions(),
        statusRegistry({
          "skill-project-goal": { latest: "0.3.0" },
          "skill-css-tokens": { latest: "0.2.1" },
          "skill-code-review": { next: "0.3.0-next.0" },
        }),
      );
      const byId = new Map(result.artifacts.map((artifact) => [artifact.id, artifact]));
      assert.equal(byId.get("skill-code-review")?.updateAvailable, true);
      assert.equal(byId.get("skill-code-review")?.updateCommand, null);
      // The unselected artifact's channel does not withhold --all from the selected ones.
      assert.equal(
        result.updateAllCommand,
        "npm create project-calavera artifacts update -- --all",
      );
    },
  );
});

test("a recipe without a known package manager prints npm commands", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      const recipe = JSON.parse(await readFile("calavera.config.json", "utf8"));
      for (const packageManager of [undefined, "pip"]) {
        await writeFile(
          "calavera.config.json",
          `${JSON.stringify({ ...recipe, packageManager }, null, 2)}\n`,
        );
        const [artifact] = (
          await runArtifactCommand(
            statusOptions(),
            statusRegistry({ "skill-project-goal": { latest: "0.3.0" } }),
          )
        ).artifacts;
        assert.equal(
          artifact.updateCommand,
          "npm create project-calavera artifacts update skill-project-goal",
        );
      }
    },
  );
});

test("status output prints no success line while a selection is not installed", () => {
  const lines = formatArtifactStatus({
    offline: false,
    updateAllCommand: null,
    checkUpdatesCommand: null,
    artifacts: [
      entry({ latestVersion: "0.2.1" }),
      entry({
        id: "skill-code-review",
        version: null,
        latestVersion: "0.2.1",
        installCommand: "install",
      }),
    ],
  });
  assert.deepEqual(lines, [
    { level: "info", message: "skill-project-goal  0.2.1, up to date (latest)" },
    { level: "info", message: "skill-code-review  not installed, latest 0.2.1 (latest)" },
    { level: "info", message: "  Install: install" },
  ]);
});

test("printed commands quote a recipe path the shell would split", () => {
  assert.equal(
    projectLocalCalaveraCommand(
      "npm",
      ["artifacts", "install"],
      ["--config", "my recipes/it's.json"],
    ),
    "npm create project-calavera artifacts install -- --config 'my recipes/it'\\''s.json'",
  );
  assert.equal(
    projectLocalCalaveraCommand("bun", ["artifacts", "install"], []),
    "bunx create-project-calavera artifacts install",
  );
});
