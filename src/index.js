import {
  cancel,
  isCancel,
  intro,
  multiselect,
  outro,
  text,
} from "@clack/prompts";
import { execa } from "execa";

import { FileWriteError } from "./utils/file-write-error.js";
import { findProjectRoot } from "./utils/filesystem.js";
import { logger } from "./utils/logger.js";

import configureEditorConfig from "./installers/editorconfig.js";
import configureESLint from "./installers/eslint.js";
import configurePrettier from "./installers/prettier.js";
import configureStylelint from "./installers/stylelint.js";

const main = async () => {
  let dependencies = [];

  console.clear();

  intro("Let's get you linting and formatting! 🧶");

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
      hint: "Writing JavaScript? You need this",
    },
    {
      value: "stylelint",
      label: "Stylelint",
      hint: "Writing CSS? input:checked",
    },
  ];

  const rootFolderName = await text({
    message: "What is the name of the root folder?",
    validate(input) {
      if (input.length === 0) {
        return "Please enter a valid folder name.";
      }
    },
  });

  const tools = await multiselect({
    message: "Choose your tools from the skeleton closet",
    options,
    required: true,
  });

  const rootFolderPath = findProjectRoot(rootFolderName);
  if (tools.includes("prettier")) {
    const prettierDeps = await configurePrettier(rootFolderPath);
    dependencies = [...dependencies, ...prettierDeps];
  }

  if (tools.includes("editorconfig")) {
    await configureEditorConfig(rootFolderPath);
  }

  if (tools.includes("eslint")) {
    const eslintDeps = await configureESLint(rootFolderPath);
    dependencies = [...dependencies, ...eslintDeps];
  }

  if (tools.includes("stylelint")) {
    const stylelintDeps = await configureStylelint(rootFolderPath);
    dependencies = [...dependencies, ...stylelintDeps];
  }

  if (dependencies.length > 0) {
    logger.info("📦 Installing dependencies...");
    await execa("npm", ["install", "--save-dev", ...dependencies], {
      stderr: "inherit",
    });
  }

  outro("All done! 🎉 Happy coding 👩‍💻");

  if (isCancel(rootFolderName) || isCancel(tools)) {
    cancel("Setup cancelled 👋");
    process.exit(0);
  }
};

main().catch((error) => {
  if (error instanceof FileWriteError) {
    logger.error(error.message);
    logger.error(error.cause);
  } else {
    logger.error(error);
  }
});
