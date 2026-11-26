import { defineConfig } from "@playwright/test";

// Every run starts its own preview server on a port the operating system picks
// (`--port 0`), so two worktrees running the suite at once never reach each
// other's server. Playwright reads the port from the line Vite prints, stores
// the named group in `process.env.BASELINE_EXPLORER_PREVIEW_PORT`, and only
// then starts the workers, which load this file again and see the port in
// `baseURL`. The pattern names the host that the `preview` script in
// package.json passes to Vite; change both together.
const previewPort = process.env.BASELINE_EXPLORER_PREVIEW_PORT;

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.mjs",
  use: {
    baseURL: previewPort ? `http://127.0.0.1:${previewPort}` : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm preview --port 0",
    wait: {
      stdout: /Local:\s+http:\/\/127\.0\.0\.1:(?<baseline_explorer_preview_port>\d+)\//,
    },
    // Without the server's output, a pattern that no longer matches looks the
    // same as a server that never started: a bare timeout.
    stdout: "pipe",
  },
});
