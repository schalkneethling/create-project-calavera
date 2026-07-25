import { defineConfig } from "vite";

export default defineConfig({
  plugins: [
    {
      name: "browser-only-module-graph",
      enforce: "pre",
      resolveId(source, importer) {
        if (source.startsWith("node:")) {
          this.error(`Node-only module ${source} reached the Composer from ${importer}.`);
        }
      },
    },
  ],
  build: {
    emptyOutDir: true,
    outDir: "../../dist-web",
  },
});
