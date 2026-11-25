// @ts-check
// How a person runs Calavera in their project. This module imports no catalog, so the menu-bar
// app's webview can share the command builder without bundling the CLI (#995).
import { isPlainObject } from "./utils/guards.js";
import { quoteShellToken } from "./utils/shell.js";

/** The recipe path Calavera reads when `--config` names no other. */
export const CONFIG_FILE = "calavera.config.json";

export const projectLocalCommandCatalog = Object.freeze({
  npm: Object.freeze({
    label: "npm",
    runCalavera: "npm create project-calavera",
    // npm create passes flags on to Calavera only after a `--` separator.
    flagsAfterSeparator: true,
    agentBootstrap: "npm create project-calavera -- --init",
    applyDryRun: "npm create project-calavera apply -- --dry-run",
    applyRecipe: "npm create project-calavera apply",
  }),
  pnpm: Object.freeze({
    label: "pnpm",
    runCalavera: "pnpm dlx create-project-calavera",
    flagsAfterSeparator: false,
    agentBootstrap: "pnpm dlx create-project-calavera --init",
    applyDryRun: "pnpm dlx create-project-calavera apply --dry-run",
    applyRecipe: "pnpm dlx create-project-calavera apply",
  }),
  yarn: Object.freeze({
    label: "Yarn",
    runCalavera: "yarn dlx create-project-calavera",
    flagsAfterSeparator: false,
    agentBootstrap: "yarn dlx create-project-calavera --init",
    applyDryRun: "yarn dlx create-project-calavera apply --dry-run",
    applyRecipe: "yarn dlx create-project-calavera apply",
  }),
  bun: Object.freeze({
    label: "Bun",
    runCalavera: "bunx create-project-calavera",
    flagsAfterSeparator: false,
    agentBootstrap: "bunx create-project-calavera --init",
    applyDryRun: "bunx create-project-calavera apply --dry-run",
    applyRecipe: "bunx create-project-calavera apply",
  }),
});

/**
 * A Calavera command run through one package manager's runner, with each token quoted for the
 * shell.
 *
 * @param {{ runCalavera: string, flagsAfterSeparator: boolean }} commands
 * @param {string[]} positionals
 * @param {string[]} flags
 */
export function runnerCommand(commands, positionals, flags) {
  const separator = flags.length > 0 && commands.flagsAfterSeparator ? ["--"] : [];
  return [
    commands.runCalavera,
    ...[...positionals, ...separator, ...flags].map(quoteShellToken),
  ].join(" ");
}

/**
 * A `create-project-calavera artifacts` command as `artifacts status` prints it: run through the
 * recipe's package manager (npm when the recipe names none), and naming the recipe when it is not
 * at the default path, so the command runs as printed from the project directory. The menu-bar
 * app copies the same command (#995).
 *
 * @param {unknown} recipe The parsed recipe.
 * @param {string} config The recipe path, as `--config` names it.
 * @param {string[]} positionals Words after `artifacts`, such as `["update", id]`.
 * @param {string[]} [flags]
 */
export function artifactCommand(recipe, config, positionals, flags = []) {
  return calaveraCommand(recipe, config, ["artifacts", ...positionals], flags);
}

/**
 * A `create-project-calavera` command, such as `apply` or `init`, built as `artifactCommand`
 * builds an `artifacts` command: through the recipe's package manager, npm when it names none,
 * and naming the recipe when it is not at the default path.
 *
 * @param {unknown} recipe The parsed recipe, or undefined when there is none.
 * @param {string} config The recipe path, as `--config` names it.
 * @param {string[]} positionals Words after the runner, such as `["apply"]`.
 * @param {string[]} [flags]
 */
export function calaveraCommand(recipe, config, positionals, flags = []) {
  const packageManager =
    isPlainObject(recipe) &&
    Object.hasOwn(projectLocalCommandCatalog, String(recipe.packageManager))
      ? /** @type {keyof typeof projectLocalCommandCatalog} */ (String(recipe.packageManager))
      : "npm";
  const configFlags = config === CONFIG_FILE ? [] : ["--config", config];
  return runnerCommand(projectLocalCommandCatalog[packageManager], positionals, [
    ...flags,
    ...configFlags,
  ]);
}

/**
 * The flags that keep an update on `tag`. `artifacts update` follows `latest` unless `--tag`
 * names another channel.
 *
 * @param {string | undefined} tag
 */
export function artifactTagFlags(tag) {
  return tag === "next" ? ["--tag", "next"] : [];
}

/**
 * The command that updates artifact `id` on channel `tag`.
 *
 * @param {unknown} recipe
 * @param {string} config
 * @param {string} id
 * @param {string | undefined} tag
 */
export function artifactUpdateCommand(recipe, config, id, tag) {
  return artifactCommand(recipe, config, ["update", id], artifactTagFlags(tag));
}
