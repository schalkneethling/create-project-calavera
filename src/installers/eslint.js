import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import * as prettier from "prettier";

import { FileWriteError } from "../utils/file-write-error.js";
import { logger } from "../utils/logger.js";

const configureESLint = async (withPrettier = false, withHTML = false) => {
  const dependencies = withPrettier
    ? ["eslint", "@eslint/js", "globals", "eslint-config-prettier"]
    : ["eslint", "@eslint/js", "globals"];

  if (withHTML) {
    dependencies.push(...["@html-eslint/parser", "@html-eslint/eslint-plugin"]);
  }

  const packageJSONPath = resolve("package.json");

  const eslintConfig = `import js from "@eslint/js";
import globals from "globals";
%PRETTIER_IMPORT%%HTML_IMPORT%

export default [
  js.configs.recommended,%PRETTIER_CONFIG%%HTML_CONFIG%
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
];\n`
    .replace(
      /%PRETTIER_IMPORT%/,
      withPrettier
        ? 'import eslintConfigPrettier from "eslint-config-prettier";'
        : "",
    )
    .replace(
      /%HTML_IMPORT%/,
      withHTML ? 'import html from "@html-eslint/eslint-plugin";' : "",
    )
    .replace(/%PRETTIER_CONFIG%/, withPrettier ? "eslintConfigPrettier," : "")
    .replace(
      /%HTML_CONFIG%/,
      withHTML
        ? '{...html.configs["flat/recommended"],files: ["**/*.html"],},'
        : "",
    );

  try {
    const packageJSON = JSON.parse(await readFile(packageJSONPath));
    packageJSON.scripts["lint:js"] = "eslint .";

    logger.info("🧶 Adding ESLint to the project...");

    const formattedConfig = await prettier.format(eslintConfig, {
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

export default configureESLint;
