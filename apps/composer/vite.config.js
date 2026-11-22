import { defineConfig } from "vite";

import { webMcpSchemasPlugin } from "./webmcp-schemas-plugin.js";

export default defineConfig({
  plugins: [
    webMcpSchemasPlugin(),
    {
      name: "browser-only-module-graph",
      enforce: "pre",
      resolveId(source, importer) {
        if (source.startsWith("node:")) {
          this.error(`Node-only module ${source} reached the Composer from ${importer}.`);
        }
        if (source === "zod" || source.startsWith("zod/")) {
          this.error(
            `${source} reached the Composer from ${importer}. The build generates the WebMCP schemas, so the page needs no Zod.`,
          );
        }
      },
    },
  ],
  build: {
    emptyOutDir: true,
    outDir: "../../dist-web",
  },
});
