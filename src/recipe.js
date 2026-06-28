export const CONFIG_SCHEMA_URL = "https://calavera.schalkneethling.com/calavera.config.schema.json";

/**
 * @typedef {"npm" | "pnpm" | "yarn" | "bun"} PackageManager
 */

/** @type {Record<string, string[]>} */
export const profileDefaults = {
  modern: [
    "editorconfig",
    "typescript",
    "oxlint",
    "oxlint-eslint",
    "oxlint-typescript",
    "oxlint-unicorn",
    "oxlint-oxc",
    "oxfmt",
    "stylelint",
    "stylelint-standard",
    "stylelint-baseline",
  ],
  classic: [
    "editorconfig",
    "typescript",
    "eslint",
    "typescript-eslint",
    "eslint-config-prettier",
    "prettier",
    "stylelint",
    "stylelint-standard",
    "stylelint-baseline",
  ],
  minimal: ["editorconfig"],
};

/**
 * @param {string} profile
 * @param {string[]} integrations
 * @param {PackageManager} [packageManager]
 */
export function buildRecipe(profile, integrations, packageManager = "npm") {
  return {
    $schema: CONFIG_SCHEMA_URL,
    version: 1,
    profile,
    packageManager,
    integrations,
    scripts: {
      lint: true,
      "lint:fix": true,
      format: true,
      "format:check": true,
      typecheck: true,
      quality: true,
    },
  };
}
