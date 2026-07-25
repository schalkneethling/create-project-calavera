import assert from "node:assert/strict";
import test from "node:test";
import {
  inspectAppUpdate,
  inspectUpdates,
  snapshotDiagnostics,
  unseenUpdates,
  updateCommand,
} from "../src/update-core.js";

const fetcher = async () => ({
  ok: true,
  json: async () => ({ "dist-tags": { latest: "2.0.0", next: "3.0.0-beta.1" } }),
});

test("checks multiple locked components and prepares exact non-executed commands", async () => {
  const updates = await inspectUpdates(
    { path: "/project", tag: "latest", cliVersion: "1.0.0" },
    {
      lock: {
        artifacts: [
          { id: "skill-project-goal", package: "example", version: "1.0.0", tag: "latest" },
        ],
      },
    },
    fetcher,
  );
  assert.equal(updates.length, 2);
  assert.equal(updates[0].command, updateCommand("skill-project-goal", "latest"));
  assert.deepEqual(unseenUpdates(updates, [updates[0].key]), [updates[1]]);
  assert.equal(
    updateCommand("artifact; malicious-command", "latest && malicious-command"),
    "create-project-calavera artifacts update 'artifact; malicious-command' --tag 'latest && malicious-command'",
  );
});

test("uses an explicitly selected prerelease channel", async () => {
  const [update] = await inspectUpdates(
    { path: "/project", tag: "next" },
    {
      lock: {
        artifacts: [
          { id: "skill-project-goal", package: "example", version: "2.0.0", tag: "latest" },
        ],
      },
    },
    fetcher,
  );
  assert.equal(update.available, "3.0.0-beta.1");
  assert.match(update.command, /--tag 'next'$/);
});

test("compares the app version with stable GitHub releases", async () => {
  const update = await inspectAppUpdate("0.1.0", async () => ({
    ok: true,
    json: async () => [
      { tag_name: "menu-bar-v0.2.0", draft: true },
      {
        tag_name: "menu-bar-v0.1.1",
        draft: false,
        prerelease: false,
        html_url:
          "https://github.com/schalkneethling/create-project-calavera/releases/tag/menu-bar-v0.1.1",
      },
      {
        tag_name: "menu-bar-v0.3.0",
        draft: false,
        prerelease: false,
        html_url:
          "https://github.com/schalkneethling/create-project-calavera/releases/tag/menu-bar-v0.3.0",
      },
      {
        tag_name: "menu-bar-v0.2.0",
        draft: false,
        prerelease: false,
        html_url:
          "https://github.com/schalkneethling/create-project-calavera/releases/tag/menu-bar-v0.2.0",
      },
    ],
  }));
  assert.equal(update.available, "0.3.0");
  assert.equal(update.kind, "app");
});

test("names missing and incompatible project-state components", () => {
  assert.deepEqual(snapshotDiagnostics({ recipe: null, lock: null, state: null }), [
    "Missing recipe (calavera.config.json)",
    "Missing artifact lock (.calavera/artifacts.lock.json)",
    "Missing managed state (.calavera/state.json)",
  ]);
  assert.deepEqual(
    snapshotDiagnostics({
      recipe: { version: 1, integrations: [], scripts: {} },
      lock: { schemaVersion: 2, artifacts: [] },
      state: { version: 1, managedFiles: [], aiArtifacts: [] },
    }),
    ["Incompatible artifact lock (.calavera/artifacts.lock.json)"],
  );
});
