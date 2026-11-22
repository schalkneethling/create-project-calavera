// Issue #398: `artifacts status --check-updates` reports, in ordinary output and in `--json`, each
// artifact's installed and latest version, a release-notes link derived from the package's own
// `repository` metadata, and a command that applies the update as printed. Without
// `--check-updates`, status contacts no registry.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { artifactForId } from "@schalkneethling/calavera-artifact-core";
import { resolveArtifactPackage } from "@schalkneethling/calavera-artifact-core/registry";

import { runArtifactCommand } from "../src/artifact-lifecycle.js";
import {
  artifactDoctorVerdict,
  artifactReleaseNotesUrl,
  formatArtifactStatus,
  formatRemovedLockEntries,
} from "../src/artifact-status-report.js";
import { parseArgs } from "../src/index.js";
import { artifactUpdateCommand } from "../src/project-local-commands.js";
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
 * @param {Record<string, Error>} [failures] The error each artifact's lookup throws, as pacote would.
 */
function statusRegistry(releases, repositories = {}, failures = {}) {
  /** @type {{ id: string, tag?: string }[]} */
  const requests = [];
  return {
    requests,
    resolve: async (/** @type {{ id: string, tag?: string, cache: string }} */ request) => {
      requests.push({ id: request.id, tag: request.tag });
      const failure = failures[request.id];
      if (failure) throw failure;
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

// The sentence status prints when an update is available and the recipe selects artifacts that
// are not installed yet (#991).
const UPDATE_TARGETS_ONE =
  "A targeted update, artifacts update <id>, advances only the artifact it names and leaves the artifacts that are not installed yet as they are.";

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

/**
 * An error shaped like the one a registry lookup throws: `message`, plus `code` and `statusCode`
 * when npm sets them.
 *
 * @param {string} message
 * @param {{ code?: string, statusCode?: number, npmDiagnostics?: string[], unsetVariables?: string[], distTags?: Record<string, string> | null, cause?: unknown, type?: string }} [fields]
 */
function registryError(message, fields = {}) {
  return Object.assign(new Error(message), fields);
}

/** @param {string} id */
function packageName(id) {
  const artifact = artifactForId(id);
  assert.ok(artifact);
  return artifact.packageName;
}

// Issue #993: one artifact's failed lookup must not fail the whole report.
test("an artifact locked on a next tag npm does not have is reported alone, beside the others", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-release-with-confidence"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
      ],
    },
    async () => {
      const missing = packageName("skill-release-with-confidence");
      const registry = statusRegistry(
        { "skill-project-goal": { latest: "0.3.0" } },
        { "skill-project-goal": packageRepository("skill-project-goal") },
        {
          // What npm-pick-manifest throws when the packument has no such dist-tag.
          "skill-release-with-confidence": registryError(
            `No matching version found for ${missing}@next.`,
            { code: "ETARGET" },
          ),
        },
      );
      const result = await runArtifactCommand(statusOptions(), registry);

      assert.deepEqual(registry.requests, [
        { id: "skill-project-goal", tag: "latest" },
        { id: "skill-release-with-confidence", tag: "next" },
      ]);
      const [goal, release] = result.artifacts;
      assert.equal(goal.updateAvailable, true);
      assert.equal(goal.latestVersion, "0.3.0");
      assert.equal(goal.updateCheckFailure, null);
      assert.equal(release.version, "0.3.0-next.0");
      assert.equal(release.latestVersion, null);
      assert.equal(release.updateAvailable, false);
      assert.equal(release.updateCommand, null);
      assert.deepEqual(release.updateCheckFailure, {
        code: "ETARGET",
        statusCode: null,
        reason: `npm has no next tag for ${missing}, so Calavera could not check for an update on that channel`,
        remedy:
          "To follow latest instead, run: npm create project-calavera artifacts update skill-release-with-confidence",
        type: null,
        origin: null,
        npmDiagnostics: [],
        unsetVariables: [],
      });
      // A failed update check is not a problem with the installed files.
      assert.equal(result.ok, true);

      const lines = formatArtifactStatus(result);
      assert.deepEqual(messages(lines), [
        "skill-project-goal  0.2.1 → 0.3.0 (latest)",
        `  Release notes: ${goal.releaseNotesUrl}`,
        `  Update: ${goal.updateCommand}`,
        "skill-release-with-confidence  0.3.0-next.0, update check failed (next)",
        `  Cause: ${release.updateCheckFailure?.reason}.`,
        `  ${release.updateCheckFailure?.remedy}`,
      ]);
      assert.equal(lines[3]?.level, "warn");
    },
  );
});

test("a failed update check never claims every artifact is up to date", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-release-with-confidence"],
      locked: [
        { id: "skill-project-goal", version: "0.3.0" },
        { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
      ],
    },
    async () => {
      const registry = statusRegistry(
        { "skill-project-goal": { latest: "0.3.0" } },
        {},
        {
          "skill-release-with-confidence": registryError("No matching version found.", {
            code: "ETARGET",
          }),
        },
      );
      const printed = messages(
        formatArtifactStatus(await runArtifactCommand(statusOptions(), registry)),
      );
      assert.ok(printed.includes("skill-project-goal  0.3.0, up to date (latest)"));
      assert.ok(
        !printed.includes("Every artifact is up to date on its channel."),
        printed.join("\n"),
      );
    },
  );
});

test("a missing tag on an artifact the recipe no longer selects offers no update command", async () => {
  await inProject(
    {
      ids: ["skill-project-goal"],
      locked: [
        { id: "skill-project-goal", version: "0.3.0" },
        { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
      ],
    },
    async () => {
      const registry = statusRegistry(
        { "skill-project-goal": { latest: "0.3.0" } },
        {},
        {
          "skill-release-with-confidence": registryError("No matching version found.", {
            code: "ETARGET",
          }),
        },
      );
      const result = await runArtifactCommand(statusOptions(), registry);
      const release = result.artifacts.find(({ id }) => id === "skill-release-with-confidence");
      assert.equal(release?.selected, false);
      assert.equal(release?.updateCheckFailure?.remedy, null);
      assert.deepEqual(messages(formatArtifactStatus(result)), [
        "skill-project-goal  0.3.0, up to date (latest)",
        "skill-release-with-confidence  0.3.0-next.0, update check failed (next)",
        "  Not selected: the recipe no longer selects this artifact, so the next artifacts install or artifacts update removes its lock entry and leaves its installed files in place.",
        `  Cause: ${release?.updateCheckFailure?.reason}.`,
      ]);
    },
  );
});

test("a missing latest tag does not offer to follow latest", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.3.0" }] },
    async () => {
      const registry = statusRegistry(
        {},
        {},
        { "skill-project-goal": registryError("No matching version found.", { code: "ETARGET" }) },
      );
      const [artifact] = (await runArtifactCommand(statusOptions(), registry)).artifacts;
      assert.equal(
        artifact.updateCheckFailure?.reason,
        `npm has no latest tag for ${packageName("skill-project-goal")}, so Calavera could not check for an update on that channel`,
      );
      assert.equal(artifact.updateCheckFailure?.remedy, null);
    },
  );
});

test("doctor's retry command runs doctor again", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.3.0" }] },
    async () => {
      const registry = statusRegistry(
        {},
        {},
        { "skill-project-goal": registryError("offline", { code: "ENOTFOUND" }) },
      );
      const result = await runArtifactCommand(
        statusOptions({ artifactAction: "doctor" }),
        registry,
      );
      assert.equal(
        result.artifacts[0]?.updateCheckFailure?.remedy,
        "Check the network connection and the npm registry settings, then run: npm create project-calavera artifacts doctor -- --check-updates",
      );
      assert.equal(result.ok, true);
    },
  );
});

test("a failed lookup names its code, keeps the registry message out, and fits the remedy to it", async () => {
  // A registry's error message is raw registry text, which can hold the request URL and response
  // details, so the report keeps only the code and status.
  const secret = "s3cret-token";
  const failures = {
    "skill-project-goal": registryError(
      `401 Unauthorized - GET https://registry.example/${secret}`,
      {
        code: "E401",
        statusCode: 401,
      },
    ),
    "skill-code-review": registryError(`getaddrinfo ENOTFOUND registry.example ${secret}`, {
      code: "ENOTFOUND",
    }),
    "skill-css-tokens": registryError(`404 Not Found - GET https://registry.example/${secret}`, {
      code: "E404",
      statusCode: 404,
    }),
    "skill-release-with-confidence": registryError(`403 Forbidden ${secret}`, {
      code: "E403",
      statusCode: 403,
    }),
  };
  const ids = Object.keys(failures);
  await inProject({ ids, locked: ids.map((id) => ({ id, version: "0.2.1" })) }, async () => {
    const result = await runArtifactCommand(statusOptions(), statusRegistry({}, {}, failures));
    const rerun = "npm create project-calavera artifacts status -- --check-updates";
    const byId = Object.fromEntries(
      result.artifacts.map(({ id, updateCheckFailure }) => [id, updateCheckFailure]),
    );
    // An error without the origin, setting, and layer that artifact-core adds still says that
    // Calavera sends no credentials.
    assert.deepEqual(byId["skill-project-goal"], {
      code: "E401",
      statusCode: 401,
      reason: `the registry lookup for ${packageName("skill-project-goal")} failed (E401, HTTP 401), and Calavera sends no credentials to any registry`,
      remedy: `If this registry requires authentication, point the registry setting at a registry that serves Calavera's packages without authentication, then run: ${rerun}`,
      type: null,
      origin: null,
      npmDiagnostics: [],
      unsetVariables: [],
    });
    assert.deepEqual(byId["skill-code-review"], {
      code: "ENOTFOUND",
      statusCode: null,
      reason: `the registry lookup for ${packageName("skill-code-review")} failed (ENOTFOUND)`,
      remedy: `Check the network connection and the npm registry settings, then run: ${rerun}`,
      type: null,
      origin: null,
      npmDiagnostics: [],
      unsetVariables: [],
    });
    assert.equal(
      byId["skill-css-tokens"]?.remedy,
      `Check that the npm registry settings point at a registry that publishes ${packageName("skill-css-tokens")}, then run: ${rerun}`,
    );
    assert.equal(
      byId["skill-release-with-confidence"]?.remedy,
      `If this registry requires authentication, point the registry setting at a registry that serves Calavera's packages without authentication, then run: ${rerun}`,
    );
    const report = JSON.stringify(result) + messages(formatArtifactStatus(result)).join("\n");
    assert.ok(!report.includes(secret), report);
  });
});

test("the HTTP status picks the remedy, whatever the code", async () => {
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
        statusRegistry(
          {},
          {},
          {
            // npm-registry-fetch answers some 401s with EOTP or EAUTHIP.
            "skill-project-goal": registryError("OTP required", { code: "EOTP", statusCode: 401 }),
            "skill-code-review": registryError("Server error", { code: "E500", statusCode: 500 }),
          },
        ),
      );
      const [goal, review] = result.artifacts;
      assert.equal(
        goal.updateCheckFailure?.reason,
        `the registry lookup for ${packageName("skill-project-goal")} failed (EOTP, HTTP 401), and Calavera sends no credentials to any registry`,
      );
      assert.match(
        goal.updateCheckFailure?.remedy ?? "",
        /^If this registry requires authentication, point the registry setting at/,
      );
      assert.match(review.updateCheckFailure?.remedy ?? "", /^Check the network connection/);
    },
  );
});

test("a local file system or Node error still stops the report, though it has a code", async () => {
  // A cache write that fails reaches pacote as an error with the system code, and a bug inside the
  // resolver raises a Node ERR_ code. Neither is a registry lookup, so neither is reported as one.
  for (const failure of [
    registryError("EACCES: permission denied, open '.calavera/cache/x'", { code: "EACCES" }),
    registryError("ENOSPC: no space left on device", { code: "ENOSPC" }),
    registryError('The "path" argument must be of type string.', { code: "ERR_INVALID_ARG_TYPE" }),
  ]) {
    await inProject(
      { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
      async () => {
        await assert.rejects(
          runArtifactCommand(
            statusOptions(),
            statusRegistry({}, {}, { "skill-project-goal": failure }),
          ),
          (error) => error === failure,
        );
      },
    );
  }
});

test("registry, network, timeout, and TLS codes are each reported per artifact", async () => {
  const codes = [
    "E500",
    "EOTP",
    "EAUTHIP",
    "ETARGET",
    "FETCH_ERROR",
    "FETCH_ABORTED",
    "ENOTFOUND",
    "ECONNREFUSED",
    "ECONNRESET",
    "ETIMEDOUT",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ECONNECTIONTIMEOUT",
    "EIDLETIMEOUT",
    "ERESPONSETIMEOUT",
    "ETRANSFERTIMEOUT",
    "EINVALIDPROXY",
    "CERT_HAS_EXPIRED",
    "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
    "SELF_SIGNED_CERT_IN_CHAIN",
    "DEPTH_ZERO_SELF_SIGNED_CERT",
    "ERR_TLS_CERT_ALTNAME_INVALID",
    // Artifact-core's code for a package document it cannot read, such as a null body.
    "EBADPACKUMENT",
  ];
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      for (const code of codes) {
        const [artifact] = (
          await runArtifactCommand(
            statusOptions(),
            statusRegistry({}, {}, { "skill-project-goal": registryError("failed", { code }) }),
          )
        ).artifacts;
        assert.equal(artifact.updateCheckFailure?.code, code);
      }
    },
  );
});

test("fetch failures of different kinds stay distinguishable", async () => {
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
        statusRegistry(
          {},
          {},
          {
            // minipass-fetch keeps FETCH_ERROR as the code and names the kind in `type`.
            "skill-project-goal": registryError("timeout", {
              code: "FETCH_ERROR",
              type: "request-timeout",
            }),
            "skill-code-review": registryError("<html>", {
              code: "FETCH_ERROR",
              type: "invalid-json",
            }),
          },
        ),
      );
      const [goal, review] = result.artifacts;
      assert.equal(goal.updateCheckFailure?.type, "request-timeout");
      assert.equal(
        goal.updateCheckFailure?.reason,
        `the registry lookup for ${packageName("skill-project-goal")} failed (FETCH_ERROR request-timeout)`,
      );
      assert.equal(review.updateCheckFailure?.type, "invalid-json");
      assert.notEqual(goal.updateCheckFailure?.reason, review.updateCheckFailure?.reason);
    },
  );
});

test("a type that is not a short identifier is not reported", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      const [artifact] = (
        await runArtifactCommand(
          statusOptions(),
          statusRegistry(
            {},
            {},
            {
              "skill-project-goal": registryError("failed", {
                code: "FETCH_ERROR",
                type: "Bearer abc123 secret",
              }),
            },
          ),
        )
      ).artifacts;
      assert.equal(artifact.updateCheckFailure?.type, null);
      assert.ok(!JSON.stringify(artifact).includes("abc123"));
    },
  );
});

test("status withholds update --all while a selected artifact on that channel failed its check", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-release-with-confidence"],
      locked: [
        { id: "skill-project-goal", version: "0.2.0-next.0", tag: "next" },
        { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
      ],
    },
    async () => {
      const registry = statusRegistry(
        { "skill-project-goal": { next: "0.2.0-next.1" } },
        {},
        {
          "skill-release-with-confidence": registryError("No matching version found.", {
            code: "ETARGET",
          }),
        },
      );
      const result = await runArtifactCommand(statusOptions(), registry);
      assert.equal(result.artifacts[0]?.updateAvailable, true);
      // update --all --tag next would resolve the missing tag and stop.
      assert.equal(result.updateAllCommand, null);
      const printed = messages(formatArtifactStatus(result));
      assert.ok(
        printed.includes(
          "No command updates every artifact, because the update check failed for skill-release-with-confidence, so run each Update command above instead.",
        ),
        printed.join("\n"),
      );
      assert.ok(
        !printed.some((line) => line.startsWith("These artifacts follow different channels")),
      );
      assert.ok(
        messages(
          formatArtifactStatus({ ...result, updateAllBlockedBy: ["skill-a", "skill-b"] }),
        ).includes(
          "No command updates every artifact, because the update check failed for skill-a, skill-b, so run each Update command above instead.",
        ),
      );
    },
  );
});

test("Calavera's own errors still stop the report with their message", async () => {
  // An identity mismatch, an invalid .npmrc, or a hand-edited lock entry carries no code and says
  // what to fix, so it is not reported as a failed lookup.
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      const failure = registryError("Resolved package identity mismatch for the package.");
      await assert.rejects(
        runArtifactCommand(
          statusOptions(),
          statusRegistry({}, {}, { "skill-project-goal": failure }),
        ),
        (error) => error === failure,
      );
    },
  );
});

test("a failed lookup names the npm configuration Calavera ignored", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      // As withNpmDiagnostics wraps a registry failure.
      const failure = registryError("401 Unauthorized", {
        code: "E401",
        statusCode: 401,
        npmDiagnostics: [
          "Ignored https-proxy in the user .npmrc: environment variable PROXY_HOST is not set.",
          "Ignored proxy in the user .npmrc: environment variable PROXY_PORT is not set.",
        ],
        unsetVariables: ["PROXY_HOST", "PROXY_PORT"],
      });
      const result = await runArtifactCommand(
        statusOptions(),
        statusRegistry({}, {}, { "skill-project-goal": failure }),
      );
      const [artifact] = result.artifacts;
      assert.deepEqual(artifact.updateCheckFailure?.npmDiagnostics, [
        "Ignored https-proxy in the user .npmrc: environment variable PROXY_HOST is not set.",
        "Ignored proxy in the user .npmrc: environment variable PROXY_PORT is not set.",
      ]);
      assert.deepEqual(artifact.updateCheckFailure?.unsetVariables, ["PROXY_HOST", "PROXY_PORT"]);
      assert.deepEqual(messages(formatArtifactStatus(result)), [
        "skill-project-goal  0.2.1, update check failed (latest)",
        `  Cause: ${artifact.updateCheckFailure?.reason}.`,
        "  Calavera ignored npm configuration that may explain this: Ignored https-proxy in the user .npmrc: environment variable PROXY_HOST is not set. Ignored proxy in the user .npmrc: environment variable PROXY_PORT is not set.",
        "  Unset variables: PROXY_HOST, PROXY_PORT. MCP clients often pass a minimal environment, so a variable set in your shell may be missing here.",
        `  ${artifact.updateCheckFailure?.remedy}`,
      ]);
    },
  );
});

test("a tag that names a version the registry does not list yet is not called missing", async () => {
  await inProject(
    {
      ids: ["skill-release-with-confidence"],
      locked: [{ id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" }],
    },
    async () => {
      const name = packageName("skill-release-with-confidence");
      for (const failure of [
        registryError("No matching version found.", {
          code: "ETARGET",
          distTags: { latest: "0.2.3", next: "0.3.0-next.1" },
        }),
        // withNpmDiagnostics keeps the tags on its cause.
        registryError("No matching version found.", {
          code: "ETARGET",
          cause: { distTags: { next: "0.3.0-next.1" } },
        }),
      ]) {
        const [artifact] = (
          await runArtifactCommand(
            statusOptions(),
            statusRegistry({}, {}, { "skill-release-with-confidence": failure }),
          )
        ).artifacts;
        assert.equal(
          artifact.updateCheckFailure?.reason,
          `npm's next tag for ${name} names a version the registry does not list yet`,
        );
        assert.equal(
          artifact.updateCheckFailure?.remedy,
          "Wait a few minutes for the registry to list it, then run: npm create project-calavera artifacts status -- --check-updates",
        );
      }
      for (const distTags of [{ latest: "0.2.3" }, null, undefined]) {
        const [missing] = (
          await runArtifactCommand(
            statusOptions(),
            statusRegistry(
              {},
              {},
              {
                "skill-release-with-confidence": registryError("No matching version found.", {
                  code: "ETARGET",
                  distTags,
                }),
              },
            ),
          )
        ).artifacts;
        assert.match(missing.updateCheckFailure?.reason ?? "", /^npm has no next tag/);
      }
    },
  );
});

test("doctor's verdict names the artifacts whose update check failed", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-release-with-confidence"],
      locked: [
        { id: "skill-project-goal", version: "0.3.0" },
        { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
      ],
    },
    async () => {
      const registry = statusRegistry(
        { "skill-project-goal": { latest: "0.3.0" } },
        {},
        {
          "skill-release-with-confidence": registryError("No matching version found.", {
            code: "ETARGET",
          }),
        },
      );
      const result = await runArtifactCommand(
        statusOptions({ artifactAction: "doctor" }),
        registry,
      );
      const verdict = artifactDoctorVerdict(result);
      assert.deepEqual(verdict, [
        {
          level: "warn",
          message:
            "The update check failed for 1 artifact: skill-release-with-confidence. The lines above name each cause. The installed files were still checked.",
        },
        { level: "success", message: "Calavera artifacts doctor found no problems." },
      ]);
      assert.equal(
        artifactDoctorVerdict({ ...result, artifacts: [result.artifacts[0]] }).length,
        1,
      );
      // Several failed checks beside a problem with the installed files.
      const failed = result.artifacts[1];
      assert.ok(failed);
      assert.deepEqual(
        artifactDoctorVerdict({
          ok: false,
          artifacts: [
            { ...failed, id: "skill-a" },
            { ...failed, id: "skill-b", installed: false },
          ],
        }),
        [
          {
            level: "warn",
            message:
              "The update check failed for 2 artifacts: skill-a, skill-b. The lines above name each cause. The installed files were still checked.",
          },
          {
            level: "error",
            message: "Calavera artifacts doctor found problems with 1 artifact: skill-b.",
          },
        ],
      );
    },
  );
});

test("an unlocked selection whose lookup fails keeps its install command", async () => {
  await inProject({ ids: ["skill-project-goal"], locked: [] }, async () => {
    const registry = statusRegistry(
      {},
      {},
      { "skill-project-goal": registryError("offline", { code: "ENOTFOUND" }) },
    );
    const result = await runArtifactCommand(statusOptions(), registry);
    const [artifact] = result.artifacts;
    assert.equal(artifact.latestVersion, null);
    assert.equal(artifact.updateCheckFailure?.code, "ENOTFOUND");
    const lines = formatArtifactStatus(result);
    assert.deepEqual(messages(lines), [
      "skill-project-goal  not installed, update check failed (latest)",
      `  Cause: ${artifact.updateCheckFailure?.reason}.`,
      "  Check the network connection and the npm registry settings, then run: npm create project-calavera artifacts status -- --check-updates",
      `  Install: ${artifact.installCommand}`,
    ]);
    assert.equal(lines[0]?.level, "warn");
  });
});

test("status without --check-updates records no update check failure", async () => {
  await inProject(
    { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
    async () => {
      const registry = statusRegistry({});
      const result = await runArtifactCommand(statusOptions({ checkUpdates: false }), registry);
      assert.deepEqual(registry.requests, []);
      assert.equal(result.artifacts[0]?.updateCheckFailure, null);
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
          "  Release notes: none, because the package metadata names no GitHub repository and package directory to link to",
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
    "git+https://github.com/schalkneethling/create-project-calavera.git",
    "git@github.com:schalkneethling/create-project-calavera.git",
  ];
  for (const repository of forms) {
    await inProject(
      { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
      async () => {
        const registry = statusRegistry(
          { "skill-project-goal": { latest: "0.3.0" } },
          { "skill-project-goal": { url: repository, directory: "packages/goal" } },
        );
        const [artifact] = (await runArtifactCommand(statusOptions(), registry)).artifacts;
        assert.equal(
          artifact.releaseNotesUrl,
          "https://github.com/schalkneethling/create-project-calavera/blob/HEAD/packages/goal/CHANGELOG.md#030",
          repository,
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

// #995: the menu-bar app copies these commands, so each package manager's runner and separator
// are pinned here rather than read back from the catalog.
test("each package manager prints its own runner, and npm alone needs a separator", () => {
  const expected = {
    npm: "npm create project-calavera artifacts update skill-project-goal -- --tag next --config recipes/calavera.json",
    pnpm: "pnpm dlx create-project-calavera artifacts update skill-project-goal --tag next --config recipes/calavera.json",
    yarn: "yarn dlx create-project-calavera artifacts update skill-project-goal --tag next --config recipes/calavera.json",
    bun: "bunx create-project-calavera artifacts update skill-project-goal --tag next --config recipes/calavera.json",
  };
  for (const [packageManager, command] of Object.entries(expected)) {
    assert.equal(
      artifactUpdateCommand(
        { packageManager },
        "recipes/calavera.json",
        "skill-project-goal",
        "next",
      ),
      command,
    );
  }
  assert.equal(
    artifactUpdateCommand({}, "calavera.config.json", "skill-project-goal", "latest"),
    "npm create project-calavera artifacts update skill-project-goal",
  );
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
// in .calavera/cache, which the README documents; this stand-in has no cache to fill. The install
// that set the project up already wrote the cache block (#960), so status finds it in place.
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
      assert.ok(!("updateAlsoInstalls" in result));
      assert.ok(printed.includes(UPDATE_TARGETS_ONE), printed);
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
    // Each URL below comes with a valid directory, so only the URL refuses the link.
    ...[
      42,
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
      "github:schalkneethling/.",
      "github:/create-project-calavera",
      "github:schalkneethling/",
      "github:sch@lk/create-project-calavera",
      "owner/repo/extra",
    ].map((url) => ({ url, directory: "packages/goal" })),
    { url: github, directory: "/packages/artifacts/skill-project-goal" },
    { url: github, directory: "packages\\artifacts" },
    { url: github, directory: "packages/../.." },
    { url: github, directory: 7 },
    // Without a package directory, the root changelog would be another package's.
    github,
    { url: github },
    { url: github, directory: "./" },
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
    artifactReleaseNotesUrl(
      { url: "https://github.com/schalkneethling/site.github.io.git", directory: "docs" },
      "0.3.0",
    ),
    "https://github.com/schalkneethling/site.github.io/blob/HEAD/docs/CHANGELOG.md#030",
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
    selected: true,
    ...overrides,
  };
}

test("status output names missing, unmanaged, and edited outputs, and an empty status", () => {
  const report = {
    offline: true,
    updateAllCommand: null,
    checkUpdatesCommand: "check",
    updateAllBlockedBy: [],
  };
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
      updateAllBlockedBy: [],
      artifacts: [
        entry({ latestVersion: "0.3.0", updateAvailable: true, updateCommand: "update one" }),
        entry({ id: "skill-code-review", latestVersion: "0.3.0", updateAvailable: true }),
      ],
    }),
  );
  assert.deepEqual(lines, [
    "skill-project-goal  0.2.1 → 0.3.0 (latest)",
    "  Release notes: none, because the package metadata names no GitHub repository and package directory to link to",
    "  Update: update one",
    "skill-code-review  0.2.1 → 0.3.0 (latest)",
    "  Release notes: none, because the package metadata names no GitHub repository and package directory to link to",
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
      assert.equal(
        messages(formatArtifactStatus(result)).at(-1),
        `Update every artifact: ${result.updateAllCommand}`,
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
    updateAllBlockedBy: [],
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

// #991: a targeted `artifacts update <id>` installs and locks only the artifact it names. A
// selection without a lock entry waits for `artifacts install` or `artifacts update --all`, and
// status says so.
test("status says that a targeted update leaves the unlocked selections to install", async () => {
  await inProject(
    {
      ids: [
        "skill-project-goal",
        "skill-code-review",
        "skill-css-tokens",
        "skill-frontend-testing",
      ],
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
          "skill-css-tokens": { latest: "0.3.0" },
          "skill-frontend-testing": { latest: "0.3.0" },
        }),
      );
      assert.ok(!("updateAlsoInstalls" in result));
      assert.equal(
        result.updateAllCommand,
        "npm create project-calavera artifacts update -- --all",
      );
      const printed = messages(formatArtifactStatus(result));
      assert.deepEqual(printed.slice(-2), [
        `Update every artifact: ${result.updateAllCommand}`,
        `${UPDATE_TARGETS_ONE} To install them, run their Install command, or update every artifact, which installs them on the channel its --tag names, or latest without --tag.`,
      ]);
      assert.ok(!printed.some((line) => line.includes("also installs")), printed.join("\n"));
    },
  );
});

test("without an update every artifact command, status points only at Install", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-code-review", "skill-css-tokens"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-code-review", version: "0.3.0-next.0", tag: "next" },
      ],
    },
    async () => {
      const result = await runArtifactCommand(
        statusOptions(),
        statusRegistry({
          "skill-project-goal": { latest: "0.3.0" },
          "skill-code-review": { next: "0.3.0-next.1" },
          "skill-css-tokens": { latest: "0.3.0" },
        }),
      );
      assert.equal(result.updateAllCommand, null);
      assert.equal(
        messages(formatArtifactStatus(result)).at(-1),
        `${UPDATE_TARGETS_ONE} To install them, run their Install command.`,
      );
    },
  );
});

test("status says nothing about unlocked selections when no update is available", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-css-tokens"],
      locked: [{ id: "skill-project-goal", version: "0.2.1" }],
    },
    async () => {
      const result = await runArtifactCommand(
        statusOptions(),
        statusRegistry({
          "skill-project-goal": { latest: "0.2.1" },
          "skill-css-tokens": { latest: "0.3.0" },
        }),
      );
      const printed = messages(formatArtifactStatus(result));
      assert.ok(!printed.includes(UPDATE_TARGETS_ONE), printed.join("\n"));
    },
  );
});

test("a printed targeted update installs and locks only the artifact it names", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-css-tokens"],
      locked: [{ id: "skill-project-goal", version: "0.2.1" }],
    },
    async () => {
      const result = await runArtifactCommand(
        statusOptions(),
        statusRegistry({
          "skill-project-goal": { latest: "0.3.0" },
          "skill-css-tokens": { latest: "0.3.0" },
        }),
      );
      const [goal, tokens] = result.artifacts;
      // A file the user placed where the unlocked selection would install stays untouched.
      const userFile = join(tokens.destination, "SKILL.md");
      await mkdir(tokens.destination, { recursive: true });
      await writeFile(userFile, "my own notes\n");
      const releases = stubRegistry(
        new Map([
          ["skill-project-goal", "0.3.0"],
          ["skill-css-tokens", "0.3.0"],
        ]),
      );
      const updated = await runArtifactCommand(
        parseArgs(calaveraArguments(goal.updateCommand, "npm")),
        releases,
      );
      assert.deepEqual(
        updated.artifacts.map(({ id, version }) => [id, version]),
        [["skill-project-goal", "0.3.0"]],
      );
      const lock = JSON.parse(await readFile(".calavera/artifacts.lock.json", "utf8"));
      assert.deepEqual(
        lock.artifacts.map(({ id, version }) => [id, version]),
        [["skill-project-goal", "0.3.0"]],
      );
      assert.equal(await readFile(userFile, "utf8"), "my own notes\n");
      const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
      assert.ok(
        !state.aiArtifacts.some(({ path }) => path.startsWith(tokens.destination)),
        JSON.stringify(state.aiArtifacts),
      );

      await rm(tokens.destination, { recursive: true, force: true });
      const installed = await runArtifactCommand(
        parseArgs(calaveraArguments(tokens.installCommand, "npm")),
        releases,
      );
      assert.deepEqual(
        installed.artifacts.map(({ id, version }) => [id, version]),
        [
          ["skill-project-goal", "0.3.0"],
          ["skill-css-tokens", "0.3.0"],
        ],
      );
    },
  );
});

test("a targeted update of an unlocked selection installs only that selection", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-css-tokens", "skill-code-review"],
      locked: [{ id: "skill-project-goal", version: "0.2.1" }],
    },
    async () => {
      const updated = await runArtifactCommand(
        {
          config: "calavera.config.json",
          dryRun: false,
          artifactAction: "update",
          artifactId: "skill-css-tokens",
        },
        stubRegistry(
          new Map([
            ["skill-project-goal", "0.3.0"],
            ["skill-css-tokens", "0.3.0"],
            ["skill-code-review", "0.3.0"],
          ]),
        ),
      );
      assert.deepEqual(
        updated.artifacts.map(({ id, version }) => [id, version]),
        [
          ["skill-project-goal", "0.2.1"],
          ["skill-css-tokens", "0.3.0"],
        ],
      );
    },
  );
});

test("a targeted update dry run reports only the artifact it names", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-css-tokens"],
      locked: [{ id: "skill-project-goal", version: "0.2.1" }],
    },
    async () => {
      const before = await snapshotDirectory();
      const planned = await runArtifactCommand(
        {
          config: "calavera.config.json",
          dryRun: true,
          artifactAction: "update",
          artifactId: "skill-project-goal",
        },
        stubRegistry(
          new Map([
            ["skill-project-goal", "0.3.0"],
            ["skill-css-tokens", "0.3.0"],
          ]),
        ),
      );
      assert.deepEqual(
        planned.artifacts.map(({ id, version }) => [id, version]),
        [["skill-project-goal", "0.3.0"]],
      );
      assert.ok(
        !planned.changes.some(({ path }) => path.includes("css-tokens")),
        JSON.stringify(planned.changes),
      );
      assert.deepEqual(await snapshotDirectory(), before);
    },
  );
});

test("update every artifact installs the unlocked selections on its channel, as status says", async () => {
  await inProject(
    {
      ids: ["skill-project-goal", "skill-css-tokens"],
      locked: [{ id: "skill-project-goal", version: "0.3.0-next.0", tag: "next" }],
    },
    async () => {
      const result = await runArtifactCommand(
        statusOptions(),
        statusRegistry({
          "skill-project-goal": { next: "0.3.0-next.1" },
          "skill-css-tokens": { latest: "0.2.1", next: "0.3.0-next.1" },
        }),
      );
      const [goal] = result.artifacts;
      assert.ok(goal.updateCommand.endsWith("-- --tag next"), goal.updateCommand);
      assert.ok(result.updateAllCommand.endsWith("-- --all --tag next"), result.updateAllCommand);
      const releases = new Map([
        ["skill-project-goal", "0.3.0-next.1"],
        ["skill-css-tokens", "0.3.0-next.1"],
      ]);
      const targeted = await runArtifactCommand(
        parseArgs(calaveraArguments(goal.updateCommand, "npm")),
        stubRegistry(releases),
      );
      assert.deepEqual(
        targeted.artifacts.map(({ id, tag }) => [id, tag]),
        [["skill-project-goal", "next"]],
      );
      const all = await runArtifactCommand(
        parseArgs(calaveraArguments(result.updateAllCommand, "npm")),
        stubRegistry(releases),
      );
      assert.deepEqual(
        all.artifacts.map(({ id, tag }) => [id, tag]),
        [
          ["skill-project-goal", "next"],
          ["skill-css-tokens", "next"],
        ],
      );
    },
  );
});

test("generated commands parse to the update they describe for every package manager", async () => {
  for (const packageManager of /** @type {const} */ (["npm", "pnpm", "yarn", "bun"])) {
    await inProject(
      {
        ids: ["skill-project-goal", "skill-release-with-confidence"],
        locked: [
          { id: "skill-project-goal", version: "0.3.0-next.0", tag: "next" },
          { id: "skill-release-with-confidence", version: "0.3.0-next.0", tag: "next" },
        ],
        packageManager,
        config: "recipes/calavera.json",
      },
      async () => {
        const result = await runArtifactCommand(
          statusOptions({ config: "recipes/calavera.json" }),
          statusRegistry({
            "skill-project-goal": { next: "0.3.0-next.1" },
            "skill-release-with-confidence": { next: "0.3.0-next.1" },
          }),
        );
        const targeted = parseArgs(
          calaveraArguments(result.artifacts[0].updateCommand, packageManager),
        );
        assert.deepEqual(
          [targeted.artifactAction, targeted.artifactId, targeted.artifactTag, targeted.config],
          ["update", "skill-project-goal", "next", "recipes/calavera.json"],
          packageManager,
        );
        const all = parseArgs(calaveraArguments(result.updateAllCommand, packageManager));
        assert.deepEqual(
          [all.artifactAction, all.artifactAll, all.artifactTag, all.config],
          ["update", true, "next", "recipes/calavera.json"],
          packageManager,
        );
      },
    );
  }
});

// #992 (owner decision, 2026-11-17): warn, then drop. The recipe is the source of truth, so
// `artifacts install` and `artifacts update` remove the lock entry of an artifact the recipe no
// longer selects, and status and the update, its dry run included, name that entry first.
const NOT_SELECTED =
  "  Not selected: the recipe no longer selects this artifact, so the next artifacts install or artifacts update removes its lock entry and leaves its installed files in place.";

test("status names a locked artifact the recipe no longer selects, online and offline", async () => {
  await inProject(
    {
      // skill-code-review is selected but not locked yet, so it is selected and has no lock entry.
      ids: ["skill-project-goal", "skill-code-review"],
      locked: [
        { id: "skill-project-goal", version: "0.2.1" },
        { id: "skill-css-tokens", version: "0.2.1" },
      ],
    },
    async () => {
      for (const checkUpdates of [false, true]) {
        const result = await runArtifactCommand(
          statusOptions({ checkUpdates }),
          statusRegistry({
            "skill-project-goal": { latest: "0.2.1" },
            "skill-css-tokens": { latest: "0.2.1" },
            "skill-code-review": { latest: "0.2.1" },
          }),
        );
        const byId = new Map(result.artifacts.map((artifact) => [artifact.id, artifact]));
        assert.equal(byId.get("skill-project-goal")?.selected, true);
        assert.equal(byId.get("skill-code-review")?.selected, true);
        assert.equal(byId.get("skill-css-tokens")?.selected, false);
        const printed = messages(formatArtifactStatus(result));
        const tokens = printed.findIndex((line) => line.startsWith("skill-css-tokens  0.2.1"));
        assert.ok(tokens >= 0, printed.join("\n"));
        assert.equal(printed[tokens + 1], NOT_SELECTED, printed.join("\n"));
        assert.equal(printed.filter((line) => line === NOT_SELECTED).length, 1, printed.join("\n"));
      }
    },
  );
});

test("status output names an unselected artifact even when it has an update", () => {
  const lines = messages(
    formatArtifactStatus({
      offline: false,
      updateAllCommand: null,
      checkUpdatesCommand: null,
      updateAllBlockedBy: [],
      artifacts: [
        entry({ id: "skill-code-review", latestVersion: "0.2.1" }),
        entry({ latestVersion: "0.3.0", updateAvailable: true, selected: false }),
      ],
    }),
  );
  assert.deepEqual(lines, [
    "skill-code-review  0.2.1, up to date (latest)",
    "skill-project-goal  0.2.1 → 0.3.0 (latest)",
    NOT_SELECTED,
    "  Release notes: none, because the package metadata names no GitHub repository and package directory to link to",
    "  Update: the recipe does not select this artifact, so artifacts update cannot update it",
  ]);
});

for (const artifactAction of ["update", "install"]) {
  test(`artifacts ${artifactAction} names the lock entries it drops, dry run first`, async () => {
    await inProject(
      {
        ids: ["skill-project-goal"],
        locked: [
          { id: "skill-project-goal", version: "0.2.1" },
          { id: "skill-css-tokens", version: "0.2.1" },
        ],
      },
      async () => {
        const status = await runArtifactCommand(statusOptions({ checkUpdates: false }), {
          resolve: async () => assert.fail("Offline status contacts no registry."),
          extract: async () => assert.fail("Status never extracts a package."),
        });
        const tokens = status.artifacts.find(({ id }) => id === "skill-css-tokens");
        assert.ok(tokens);
        const releases = stubRegistry(new Map([["skill-project-goal", "0.3.0"]]));
        const options = {
          config: "calavera.config.json",
          artifactAction,
          ...(artifactAction === "update" ? { artifactId: "skill-project-goal" } : {}),
        };

        const before = await snapshotDirectory();
        const planned = await runArtifactCommand({ ...options, dryRun: true }, releases);
        assert.deepEqual(await snapshotDirectory(), before);
        assert.deepEqual(planned.removedLockEntries, [
          { id: "skill-css-tokens", version: "0.2.1", tag: "latest" },
        ]);
        assert.deepEqual(formatRemovedLockEntries(planned), [
          "Would remove the lock entry for skill-css-tokens 0.2.1 (latest), because the recipe no longer selects it. Its installed files stay in place.",
        ]);

        const applied = await runArtifactCommand({ ...options, dryRun: false }, releases);
        assert.deepEqual(applied.removedLockEntries, planned.removedLockEntries);
        assert.deepEqual(formatRemovedLockEntries(applied), [
          "Removed the lock entry for skill-css-tokens 0.2.1 (latest), because the recipe no longer selects it. Its installed files stay in place.",
        ]);
        const lock = JSON.parse(await readFile(".calavera/artifacts.lock.json", "utf8"));
        assert.deepEqual(
          lock.artifacts.map(({ id }) => id),
          ["skill-project-goal"],
        );
        // The installed files stay, as status and the warning say: the outputs, the package
        // directory, and the state records that let `clean` remove them later.
        const tokenFiles = (/** @type {Record<string, string>} */ snapshot) =>
          Object.entries(snapshot).filter(
            ([path]) =>
              path.startsWith(tokens.destination) ||
              path.startsWith(join(".calavera", "packages", "skill-css-tokens")),
          );
        assert.ok(tokenFiles(before).some(([path]) => path.startsWith(".calavera")));
        assert.ok(tokenFiles(before).some(([path]) => path.startsWith(tokens.destination)));
        assert.deepEqual(tokenFiles(await snapshotDirectory()), tokenFiles(before));
        const state = JSON.parse(await readFile(".calavera/state.json", "utf8"));
        assert.ok(
          state.aiArtifacts.some(({ path }) => path.startsWith(tokens.destination)),
          JSON.stringify(state.aiArtifacts),
        );

        const again = await runArtifactCommand({ ...options, dryRun: true }, releases);
        assert.deepEqual(again.removedLockEntries, []);
        assert.deepEqual(formatRemovedLockEntries(again), []);
      },
    );
  });
}

test("status names only install when the recipe selects no artifact, which update refuses", async () => {
  await inProject({ ids: [], locked: [{ id: "skill-css-tokens", version: "0.2.1" }] }, async () => {
    const result = await runArtifactCommand(statusOptions({ checkUpdates: false }), {
      resolve: async () => assert.fail("Offline status contacts no registry."),
      extract: async () => assert.fail("Status never extracts a package."),
    });
    assert.equal(result.artifacts[0].selected, false);
    assert.deepEqual(messages(formatArtifactStatus(result)).slice(0, 2), [
      "skill-css-tokens  0.2.1 (latest)",
      "  Not selected: the recipe selects no artifacts, so the next artifacts install removes its lock entry and leaves its installed files in place.",
    ]);
    await assert.rejects(
      runArtifactCommand(
        {
          config: "calavera.config.json",
          dryRun: true,
          artifactAction: "update",
          artifactAll: true,
        },
        stubRegistry(new Map()),
      ),
      /requires an artifact ID or --all/,
    );
    const planned = await runArtifactCommand(
      { config: "calavera.config.json", dryRun: true, artifactAction: "install" },
      stubRegistry(new Map()),
    );
    assert.deepEqual(
      planned.removedLockEntries.map(({ id }) => id),
      ["skill-css-tokens"],
    );
  });
});

test("status without a recipe does not claim the recipe deselected its artifacts", async () => {
  await inProject(
    { ids: ["skill-css-tokens"], locked: [{ id: "skill-css-tokens", version: "0.2.1" }] },
    async () => {
      await rm("calavera.config.json");
      const result = await runArtifactCommand(statusOptions({ checkUpdates: false }), {
        resolve: async () => assert.fail("Offline status contacts no registry."),
        extract: async () => assert.fail("Status never extracts a package."),
      });
      assert.equal(result.artifacts[0].selected, null);
      const printed = messages(formatArtifactStatus(result));
      assert.ok(!printed.some((line) => line.includes("Not selected")), printed.join("\n"));
    },
  );
});

test("a 401 or 403 names the origin, the setting, and the layer, and says Calavera sends no credentials", async () => {
  const fields = {
    setting: "@schalkneethling:registry",
    layer: "project .npmrc",
    registryOrigin: "https://npm.example.com",
  };
  const failures = {
    "skill-project-goal": registryError("401 Unauthorized", {
      code: "E401",
      statusCode: 401,
      origin: "https://npm.example.com",
      ...fields,
    }),
    // A redirect can end on another origin, which is then "the host", not the registry.
    "skill-code-review": registryError("403 Forbidden", {
      code: "E403",
      statusCode: 403,
      origin: "https://cdn.example.com",
      ...fields,
    }),
  };
  const ids = Object.keys(failures);
  await inProject({ ids, locked: ids.map((id) => ({ id, version: "0.2.1" })) }, async () => {
    const result = await runArtifactCommand(statusOptions(), statusRegistry({}, {}, failures));
    const rerun = "npm create project-calavera artifacts status -- --check-updates";
    const byId = Object.fromEntries(
      result.artifacts.map(({ id, updateCheckFailure }) => [id, updateCheckFailure]),
    );
    const remedy = `If this registry requires authentication, point @schalkneethling:registry in the project .npmrc at a registry that serves Calavera's packages without authentication, then run: ${rerun}`;
    assert.deepEqual(
      [byId["skill-project-goal"]?.reason, byId["skill-project-goal"]?.remedy],
      [
        "the registry https://npm.example.com answered 401 (E401), and Calavera sends no credentials to any registry",
        remedy,
      ],
    );
    assert.equal(byId["skill-project-goal"]?.origin, "https://npm.example.com");
    assert.deepEqual(
      [byId["skill-code-review"]?.reason, byId["skill-code-review"]?.remedy],
      [
        "the host https://cdn.example.com answered 403 (E403) for a lookup that started at the registry https://npm.example.com, and Calavera sends no credentials to any registry or host",
        remedy,
      ],
    );
    assert.equal(byId["skill-code-review"]?.origin, "https://cdn.example.com");
  });
});

test("a 401 from a real registry behind a loader diagnostic keeps the origin, setting, and layer in the report and --json", async () => {
  const token = "fake-update-check-token-0123456789";
  /** @type {(string | undefined)[]} */
  const authorizations = [];
  const server = createServer((request, response) => {
    authorizations.push(request.headers.authorization);
    response.writeHead(401, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "registry text" }));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", () => done(undefined)));
  const { port } = /** @type {import("node:net").AddressInfo} */ (server.address());
  const origin = `http://127.0.0.1:${port}`;
  try {
    await inProject(
      { ids: ["skill-project-goal"], locked: [{ id: "skill-project-goal", version: "0.2.1" }] },
      async () => {
        const userconfig = join(process.cwd(), "user.npmrc");
        await writeFile(
          userconfig,
          `@schalkneethling:registry=${origin}/\n//127.0.0.1:${port}/:_authToken=${token}\n`,
        );
        // A project proxy is ignored with a warning, so the loader has a diagnostic.
        await writeFile(
          ".npmrc",
          `https-proxy=http://proxy.example.com/\n//127.0.0.1:${port}/:_authToken=${token}\n`,
        );
        const env = { npm_config_userconfig: userconfig, HOME: process.cwd() };
        const registry = {
          resolve: (/** @type {Parameters<typeof resolveArtifactPackage>[0]} */ request) =>
            resolveArtifactPackage({ ...request, cwd: process.cwd(), env }),
          extract: async () => {
            throw new Error("Status never extracts a package.");
          },
        };
        const result = await runArtifactCommand(statusOptions(), registry);
        const failure = result.artifacts[0]?.updateCheckFailure;
        assert.equal(
          failure?.reason,
          `the registry ${origin} answered 401 (E401), and Calavera sends no credentials to any registry`,
        );
        assert.match(
          failure?.remedy ?? "",
          /^If this registry requires authentication, point @schalkneethling:registry in the user \.npmrc at a registry/,
        );
        assert.equal(failure?.origin, origin);
        assert.match(
          failure?.npmDiagnostics.join("\n") ?? "",
          /^Ignored https-proxy in the project \.npmrc/,
        );
        const json = JSON.parse(JSON.stringify(result));
        assert.equal(json.artifacts[0].updateCheckFailure.origin, origin);
        const report = JSON.stringify(result) + messages(formatArtifactStatus(result)).join("\n");
        assert.ok(!report.includes(token), "the report must not contain the planted token");
        assert.ok(!report.includes("registry text"), "the report must not contain registry text");
        assert.deepEqual(authorizations, [undefined]);
      },
    );
  } finally {
    await new Promise((done) => server.close(() => done(undefined)));
  }
});
