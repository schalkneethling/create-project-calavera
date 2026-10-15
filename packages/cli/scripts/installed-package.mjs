// Locates packages installed in the workspace, so a test can link them into a
// temporary project and run the real tools without a network install.
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

const require = createRequire(import.meta.url);

/**
 * The directory of an installed package, found by walking up from its entry
 * point, as not every package exports its package.json.
 *
 * @param {string} name
 */
export async function packageDirectory(name) {
  let directory = dirname(require.resolve(name));

  while (directory !== dirname(directory)) {
    try {
      const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
      if (manifest.name === name) {
        return directory;
      }
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
    directory = dirname(directory);
  }

  throw new Error(`Could not find the installed ${name} package.`);
}
