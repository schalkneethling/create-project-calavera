import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileWriteError } from "../utils/file-write-error.js";
import { logger } from "../utils/logger.js";

const configureESLint = async (rootFolderPath) => {
  const dependencies = ["eslint", "@eslint/js", "globals"];
  const packageJSONPath = resolve(rootFolderPath, "package.json");

  const eslintConfig = `import js from "@eslint/js";
import globals from "globals";

export default [
  js.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.nodeBuiltin,
      },
    },
    rules: {
      "no-console": ["error", { allow: ["clear", "info"] }],
    },
  },
];\n`;

  try {
    const packageJSON = JSON.parse(await readFile(packageJSONPath));
    packageJSON.scripts["lint:js"] = "eslint .";

    logger.info("🧶 Adding ESLint to the project...");

    await writeFile(resolve(rootFolderPath, "eslint.config.js"), eslintConfig);

    const updatedPackageJSON = JSON.stringify(packageJSON, null, 2);
    await writeFile(packageJSONPath, `${updatedPackageJSON}\n`);
  } catch (error) {
    throw new FileWriteError("Failed to add ESLint configuration.", {
      cause: error,
    });
  }

  return dependencies;
};

export default configureESLint;
