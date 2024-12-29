import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileWriteError } from "../utils/file-write-error.js";
import { logger } from "../utils/logger.js";

/**
 * Configures the TypeScript configuration for the project.
 *
 * @param {boolean} [noEmit=false] - If true, uses the noEmit configuration option.
 * @returns {Promise<string[]>} - A promise that resolves to an array of dependencies to be installed.
 * @throws {FileWriteError} - Throws an error if writing the TypeScript configuration files fails.
 */
const configureTSConfig = async (noEmit = false) => {
  const dependencies = ["typescript"];
  const packageJSONPath = resolve("package.json");

  const rootTSConfig = {
    extends: "./.project-calavera/tsconfig.json",
  };

  const baseConfig = {
    include: ["src/**/*.ts*"],
    exclude: ["node_modules"],
  };

  const tsConfig = {
    ...baseConfig,
    compilerOptions: {
      allowImportingTsExtensions: true,
      allowJs: true, // Allow JavaScript files to be imported
      esModuleInterop: true, // Properly support importing CJS modules in ESM
      forceConsistentCasingInFileNames: true,
      module: "ESNext",
      target: "ESNext",
      moduleResolution: "node",
      noUncheckedIndexedAccess: true, // https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess
      resolveJsonModule: true, // Enable JSON imports.
      skipLibCheck: true,
      sourceMap: true,
      strict: true,
    },
  };

  const tsConfigNoEmit = {
    ...baseConfig,
    compilerOptions: {
      noEmit: true,
      allowImportingTsExtensions: true,
      allowJs: true, // Allow JavaScript files to be imported
      esModuleInterop: true, // Properly support importing CJS modules in ESM
      forceConsistentCasingInFileNames: true,
      target: "ESNext",
      moduleResolution: "bundler",
      noUncheckedIndexedAccess: true, // https://www.typescriptlang.org/tsconfig/#noUncheckedIndexedAccess
      resolveJsonModule: true, // Enable JSON imports.
      skipLibCheck: true,
      strict: true,
      isolatedModules: true,
      verbatimModuleSyntax: true,
    },
  };

  const config = noEmit ? tsConfigNoEmit : tsConfig;

  try {
    const packageJSON = JSON.parse(await readFile(packageJSONPath));
    packageJSON.scripts["build:ts"] = "tsc";

    logger.info("🧶 Adding TypeScript to the project...");

    const tsConfigString = JSON.stringify(config, null, 2);

    await mkdir(".project-calavera", { recursive: true });
    await writeFile(".project-calavera/tsconfig.json", `${tsConfigString}\n`);

    await writeFile(
      "tsconfig.json",
      `${JSON.stringify(rootTSConfig, null, 2)}\n`,
    );

    const updatedPackageJSON = JSON.stringify(packageJSON, null, 2);
    await writeFile(packageJSONPath, `${updatedPackageJSON}\n`);
  } catch (error) {
    throw new FileWriteError("Failed to add TypeScript configuration.", {
      cause: error,
    });
  }

  return dependencies;
};

export default configureTSConfig;
