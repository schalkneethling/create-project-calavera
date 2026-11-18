import { defineConfig } from "@playwright/test";

// Every run starts its own preview server on a port the operating system picks
// (`--port 0`), so two worktrees running the suite at once never reach each
// other's server. Playwright reads the port from the line Vite prints, stores
// the named group in `process.env.COMPOSER_PREVIEW_PORT`, and only then starts
// the workers, which load this file again and see the port in `baseURL`.
const previewPort = process.env.COMPOSER_PREVIEW_PORT;

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.spec.mjs",
  use: {
    baseURL: previewPort ? `http://127.0.0.1:${previewPort}` : undefined,
    trace: "retain-on-failure",
  },
  webServer: {
    command: "pnpm build && pnpm preview --port 0 --strictPort",
    wait: {
      stdout: /Local:\s+http:\/\/127\.0\.0\.1:(?<composer_preview_port>\d+)\//,
    },
  },
});
