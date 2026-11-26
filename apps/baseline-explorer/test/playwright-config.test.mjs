import assert from "node:assert/strict";
import test from "node:test";
import { stripVTControlCharacters } from "node:util";

const configUrl = new URL("../playwright.config.js", import.meta.url);

// What `vite preview --host 127.0.0.1` prints once it listens, with the
// terminal colors that Playwright strips before it matches `wait.stdout`.
const vitePreviewOutput =
  "  \u001b[32m➜\u001b[39m  \u001b[1mLocal\u001b[22m:   \u001b[36mhttp://127.0.0.1:\u001b[1m54107\u001b[22m/\u001b[39m\n";

async function loadConfig(env) {
  const saved = { ...process.env };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    // A fresh query string re-evaluates the module, as a Playwright worker does.
    const module = await import(`${configUrl.href}?run=${Math.random()}`);
    return module.default;
  } finally {
    for (const key of Object.keys(process.env)) {
      if (!(key in saved)) delete process.env[key];
    }
    Object.assign(process.env, saved);
  }
}

test("the Baseline Explorer preview server never reuses a server that is already running", async () => {
  const { use, webServer } = await loadConfig({ BASELINE_EXPLORER_PREVIEW_PORT: undefined });

  assert.notEqual(webServer.reuseExistingServer, true);
  assert.equal(webServer.url, undefined, "a fixed URL lets a run find another worktree's server");
  assert.equal(webServer.port, undefined, "a fixed port lets a run find another worktree's server");
  assert.match(webServer.command, /pnpm preview --port 0$/);
  assert.equal(
    use.baseURL,
    undefined,
    "a fallback URL would point at a server this run did not start",
  );
});

test("the tests run against the port the preview server reports, not a fixed one", async () => {
  const { webServer } = await loadConfig({});
  assert.ok(webServer.wait?.stdout instanceof RegExp, "the server must report its own port");
  const match = webServer.wait.stdout.exec(stripVTControlCharacters(vitePreviewOutput));

  assert.ok(match, "the wait pattern must match what vite preview prints");
  const [[group, port]] = Object.entries(match.groups);
  assert.equal(port, "54107");
  // Playwright ignores the server's stdout by default, so a pattern that stops
  // matching would otherwise fail as a bare timeout with nothing to read.
  assert.equal(webServer.stdout, "pipe", "the server's output must stay visible");

  // Playwright stores the named group, uppercased, in the environment before it
  // starts the workers, and each worker loads this config again.
  const workerConfig = await loadConfig({ [group.toUpperCase()]: port });
  assert.equal(workerConfig.use.baseURL, "http://127.0.0.1:54107");
});
