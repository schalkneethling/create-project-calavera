import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

import { FileWriteError } from "../utils/file-write-error.js";
import { logger } from "../utils/logger.js";

const configureStylelint = async (rootFolderPath) => {
  const dependencies = [
    "stylelint",
    "stylelint-config-standard",
    "stylelint-order",
  ];
  const packageJSONPath = resolve(rootFolderPath, "package.json");

  const stylelintConfig = {
    extends: "stylelint-config-standard",
    plugins: ["stylelint-order"],
    rules: {
      "order/properties-alphabetical-order": true,
    },
  };

  try {
    const packageJSON = JSON.parse(await readFile(packageJSONPath));
    packageJSON.scripts["lint:css"] = "stylelint **/*.css";

    logger.info("🧶 Adding Stylelint to the project...");

    const stylelintConfigString = JSON.stringify(stylelintConfig, null, 2);
    await writeFile(
      resolve(rootFolderPath, ".stylelintrc.json"),
      `${stylelintConfigString}\n`,
    );

    const updatedPackageJSON = JSON.stringify(packageJSON, null, 2);
    await writeFile(packageJSONPath, `${updatedPackageJSON}\n`);
  } catch (error) {
    throw new FileWriteError("Failed to add Stylelint configuration.", {
      cause: error,
    });
  }

  return dependencies;
};

export default configureStylelint;
