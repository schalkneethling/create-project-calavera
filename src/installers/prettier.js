import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileWriteError } from "../utils/file-write-error.js";
import { logger } from "../utils/logger.js";

const configurePrettier = async () => {
  const dependencies = ["prettier"];
  const packageJSONPath = resolve("package.json");

  const prettierIgnore = `# Package Managers
package-lock.json
pnpm-lock.yaml
yarn.lock\n`;

  try {
    const packageJSON = JSON.parse(await readFile(packageJSONPath));
    packageJSON.scripts["prettier:lint"] = "prettier .";
    packageJSON.scripts["prettier:format"] = "prettier --write .";

    logger.info("🧶 Adding Prettier to the project...");

    await writeFile(".prettierignore", prettierIgnore);
    await writeFile(".prettierrc.json", `{}\n`);

    const updatedPackageJSON = JSON.stringify(packageJSON, null, 2);
    await writeFile(packageJSONPath, `${updatedPackageJSON}\n`);
  } catch (error) {
    throw new FileWriteError("Failed to add Prettier configuration.", {
      cause: error,
    });
  }

  return dependencies;
};

export default configurePrettier;
