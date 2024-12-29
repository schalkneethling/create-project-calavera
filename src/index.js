#!/usr/bin/env node
import { cancel, isCancel, intro, multiselect, spinner } from "@clack/prompts";
import { execa } from "execa";

import { FileWriteError } from "./utils/file-write-error.js";
import { logger } from "./utils/logger.js";

import configureEditorConfig from "./installers/editorconfig.js";
import configureESLint from "./installers/eslint.js";
import configurePrettier from "./installers/prettier.js";
import configureStylelint from "./installers/stylelint.js";
import configureTSConfig from "./installers/tsconfig.js";

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
  ];

  const tools = await multiselect({
    message: "Choose your tools from the skeleton closet",
    options,
    required: true,
  });

  let withPrettier = false;
  if (tools.includes("prettier")) {
    const prettierDeps = await configurePrettier();
    dependencies = [...dependencies, ...prettierDeps];
    withPrettier = true;
  }

  if (tools.includes("editorconfig")) {
    await configureEditorConfig();
  }

  if (tools.includes("eslint")) {
    const eslintDeps = await configureESLint(withPrettier || false);
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

  const spin = spinner();
  if (dependencies.length > 0) {
    spin.start("📦 Installing dependencies...");
    await execa("npm", ["install", "--save-dev", ...dependencies], {
      stderr: "inherit",
    });
  }

  spin.stop("All done! 🎉 Happy coding 🙌");

  if (isCancel(tools)) {
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
