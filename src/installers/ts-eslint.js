import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as prettier from "prettier";

import { FileWriteError } from "../utils/file-write-error.js";
import { logger } from "../utils/logger.js";

const configureTSESLint = async (withPrettier = false) => {
  const dependencies = withPrettier
    ? [
        "eslint",
        "@eslint/js",
        "globals",
        "typescript-eslint",
        "eslint-config-prettier",
      ]
    : ["eslint", "@eslint/js", "globals", "typescript-eslint"];
  const packageJSONPath = resolve("package.json");

  const tsEslintConfig = `import js from "@eslint/js";
import globals from "globals";
import tseslint from 'typescript-eslint';
%PRETTIER_IMPORT%

export default tseslint.config(
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,%PRETTIER_CONFIG%
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.nodeBuiltin,
      },

      // https://typescript-eslint.io/getting-started/typed-linting
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "no-console": ["error", { allow: ["clear", "info"] }],
    },
  },
);\n`
    .replace(
      /%PRETTIER_IMPORT%/,
      withPrettier
        ? 'import eslintConfigPrettier from "eslint-config-prettier";'
        : "",
    )
    .replace(/%PRETTIER_CONFIG%/, withPrettier ? "eslintConfigPrettier," : "");

  try {
    const packageJSON = JSON.parse(await readFile(packageJSONPath));
    packageJSON.scripts["lint:ts"] = "eslint .";

    logger.info("🧶 Adding typescript-eslint to the project...");

    const formattedConfig = await prettier.format(tsEslintConfig, {
      parser: "babel",
    });
    await writeFile("eslint.config.js", formattedConfig);

    const updatedPackageJSON = JSON.stringify(packageJSON, null, 2);
    await writeFile(packageJSONPath, `${updatedPackageJSON}\n`);
  } catch (error) {
    throw new FileWriteError("Failed to add ESLint configuration.", {
      cause: error,
    });
  }

  return dependencies;
};

export default configureTSESLint;
