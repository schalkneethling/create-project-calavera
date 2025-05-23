#!/usr/bin/env node
import { access, constants } from "node:fs/promises";
import { resolve } from "node:path";

import {
  cancel,
  confirm,
  isCancel,
  intro,
  multiselect,
  spinner,
} from "@clack/prompts";
import { execa } from "execa";

import { FileWriteError } from "./utils/file-write-error.js";
import { logger } from "./utils/logger.js";

import configureEditorConfig from "./installers/editorconfig.js";
import configureESLint from "./installers/eslint.js";
import configurePrettier from "./installers/prettier.js";
import configureStylelint from "./installers/stylelint.js";
import configureTSConfig from "./installers/tsconfig.js";
import configureTSESLint from "./installers/ts-eslint.js";

/**
 * Checks for the presence of an existing package.json file.
 * If not found, prompts the user to create a default package.json.
 * Exits the process if the user cancels the creation.
 * @returns {Promise<void>}
 */
async function checkPrerequisites() {
  logger.info("Checking for presence of an existing package.json...");

  const packageJSON = resolve("package.json");

  let createPackageJSON;
  try {
    await access(packageJSON, constants.F_OK);
  } catch {
    createPackageJSON = await confirm({
      message:
        "No package.json found. You will need one to continue, create a default?",
    });

    if (!createPackageJSON) {
      cancel("Setup cancelled 👋");
      process.exit(0);
    }

    const spin = spinner();

    spin.start("📦 Creating package.json...");
    await execa("npm", ["init", "-y"], {
      stderr: "inherit",
    });

    spin.stop("📦 Created package.json");
  }
}

const main = async () => {
  console.clear();

  intro("Let's get you linting and formatting! 🧶");

  await checkPrerequisites();

  const options = [
    { value: "editorconfig", label: "EditorConfig", hint: "Recommended" },
    {
      value: "prettier",
      label: "Prettier",
      hint: "You probably want Prettier",
    },
    {
      value: "eslint",
      label: "ESLint",
      hint: "Writing JavaScript or TypeScript? You need this",
    },
    {
      value: "tsconfig",
      label: "TSConfig",
      hint: "Writing Bundleless TypeScript? Type the spacebar",
    },
    {
      value: "tsconfig-noemit",
      label: "TSConfig (noEmit)",
      hint: "Writing TypeScript but also use a bunler? Bundle up to this one",
    },
    {
      value: "stylelint",
      label: "Stylelint",
      hint: "Writing CSS? input:checked",
    },
    {
      value: "eslint-html",
      label: "ESLint HTML",
      hint: "Writing HTML? Of course you are [x]",
    },
  ];

  const tools = await multiselect({
    message: "Choose your tools from the skeleton closet",
    options,
    required: true,
  });

  if (isCancel(tools)) {
    cancel("Setup cancelled 👋");
    process.exit(0);
  }

  let dependencies = [];
  let withPrettier = tools.includes("prettier");
  let withTypeScript =
    tools.includes("tsconfig") || tools.includes("tsconfig-noemit");

  if (tools.includes("prettier")) {
    const prettierDeps = await configurePrettier();
    dependencies = [...dependencies, ...prettierDeps];
  }

  if (tools.includes("editorconfig")) {
    await configureEditorConfig();
  }

  if (tools.includes("eslint") || tools.includes("eslint-html")) {
    const withHTML = tools.includes("eslint-html");
    const eslintDeps = withTypeScript
      ? await configureTSESLint(withPrettier, withHTML)
      : await configureESLint(withPrettier, withHTML);
    dependencies = [...dependencies, ...eslintDeps];
  }

  if (tools.includes("tsconfig")) {
    const tsConfigDeps = await configureTSConfig();
    dependencies = [...dependencies, ...tsConfigDeps];
  }

  if (tools.includes("tsconfig-noemit")) {
    const tsConfigDeps = await configureTSConfig(/* noEmit */ true);
    dependencies = [...dependencies, ...tsConfigDeps];
  }

  if (tools.includes("stylelint")) {
    const stylelintDeps = await configureStylelint();
    dependencies = [...dependencies, ...stylelintDeps];
  }

  if (dependencies.length > 0) {
    const spin = spinner();
    spin.start("📦 Installing dependencies...");
    await execa("npm", ["install", "--save-dev", ...dependencies], {
      stderr: "inherit",
    });
    spin.stop("Dependencies installed 👍");
  }

  logger.info("\nAll done! 🎉 Happy coding 🙌");
};

main().catch((error) => {
  if (error instanceof FileWriteError) {
    logger.error(error.message);
    logger.error(error.cause);
  } else {
    logger.error(error);
  }
});
