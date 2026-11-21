// @ts-check
// The human-readable output of `init` around the apply dry run (#1022). With --apply, init prints
// the apply dry run with the grouped summary `apply --dry-run` prints (#617), so the recipe summary
// before it and the closing lines after it leave out what that summary names: the package
// manager, each integration with its packages, each artifact, and the notes. The `--json` result
// keeps its shape.
import { applySummaryBody } from "./apply-summary.js";
import { ITEM, info, pushGroup } from "./summary-lines.js";
import { pluralizeCount, style } from "./utils/text.js";

/**
 * @typedef {import("./index.js").InitResult} InitResult
 * @typedef {import("./summary-lines.js").SummaryLine} SummaryLine
 */

/**
 * The body of the recipe summary note. With --apply, only the profile, the one fact the apply dry
 * run that follows does not state.
 *
 * @param {import("./index.js").Recipe} recipe
 * @param {{ dependencies: string[], aiArtifacts: unknown[] }} explanation
 * @param {boolean} apply
 * @returns {string}
 */
export function initRecipeSummary(recipe, explanation, apply) {
  const profile = `${style("bold", "Profile")}: ${recipe.profile}`;
  if (apply) return profile;
  return [
    profile,
    `${style("bold", "Package manager")}: ${recipe.packageManager}`,
    `${style("bold", "Integrations")}: ${pluralizeCount((recipe.integrations ?? []).length, "item")}`,
    `${style("bold", "Dependencies")}: ${
      explanation.dependencies.length > 0 ? explanation.dependencies.join(", ") : "none"
    }`,
    `${style("bold", "AI artifacts")}: ${explanation.aiArtifacts.length}`,
  ].join("\n");
}

/**
 * One line for each input whose value came from the default, because nobody was asked for it, with
 * where the recipe records it (#846). With --apply, they sit under a heading and name the input by
 * its place in the recipe, not by its artifact, because the apply dry run that follows names the
 * artifact with the same input under Artifacts.
 *
 * @param {import("./ai/artifact-inputs.js").ResolvedInput[]} artifactInputs
 * @param {import("./integration-inputs.js").ResolvedIntegrationInput[]} integrationInputs
 * @param {string} config The recipe file.
 * @param {boolean} apply
 * @returns {SummaryLine[]}
 */
export function initDefaultInputLines(artifactInputs, integrationInputs, config, apply) {
  const defaults = [
    ...artifactInputs
      .filter(({ source }) => source === "default")
      .map(({ artifact, index, name, value }) => ({
        subject: `${artifact} ${name}`,
        path: `ai[${index}].inputs.${name}`,
        value,
      })),
    ...integrationInputs
      .filter(({ source }) => source === "default")
      .map(({ integration, name, path, value }) => ({
        subject: `${integration} ${name}`,
        path,
        value,
      })),
  ];
  if (!apply) {
    return defaults.map(({ subject, path, value }) =>
      info(
        `Input: ${subject} = ${value}, the default, recorded as ${path} in ${config}. Change it there if it is wrong.`,
      ),
    );
  }
  /** @type {SummaryLine[]} */
  const lines = [];
  pushGroup(
    lines,
    "Defaults recorded in the recipe",
    defaults.map(({ path, value }) =>
      info(`${ITEM}${path} = ${value} in ${config}. Change it there if it is wrong.`),
    ),
  );
  // The apply dry run headline follows, so a blank line keeps it out of this group.
  if (lines.length > 0) lines.push(info(""));
  return lines;
}

/**
 * The apply dry run as `apply --dry-run` prints it, with a headline that says init has already
 * written the recipe file, unless init itself is a dry run.
 *
 * @param {import("./index.js").ApplyResult} applyDryRun
 * @param {{ config: string, dryRun: boolean, noInstall: boolean }} init
 * @returns {SummaryLine[]}
 */
export function initApplyDryRunLines(applyDryRun, { config, dryRun, noInstall }) {
  return [
    info(
      dryRun
        ? "Calavera apply dry run complete. No files were changed."
        : `Calavera apply dry run complete. Apply has not changed any files yet; init wrote only ${config}.`,
    ),
    ...applySummaryBody(applyDryRun, { noInstall }),
  ];
}

/**
 * The lines init prints after its outro, in order. The caller prints a line with the logger
 * method its level names.
 *
 * @param {InitResult} result
 * @returns {SummaryLine[]}
 */
export function initSummaryLines(result) {
  const { recipe, applyDryRun, applyResult } = result;
  /** @type {SummaryLine[]} */
  const lines = [
    result.dryRun
      ? info(`Calavera recipe dry run complete. Would write ${result.config}.`)
      : { level: "success", text: `Wrote ${result.config}.` },
  ];

  // With --apply, the recipe summary and the apply dry run already named these.
  if (applyDryRun === undefined) {
    lines.push(
      info(`Profile: ${recipe.profile}`),
      info(`Package manager: ${recipe.packageManager}`),
      info(`Integrations: ${(recipe.integrations ?? []).join(", ") || "none"}`),
    );
    if (Array.isArray(recipe.ai) && recipe.ai.length > 0) {
      lines.push(info(`AI artifacts: ${recipe.ai.length}`));
    }
  } else if (applyResult === undefined) {
    lines.push(info("Apply was previewed but not run."));
  } else {
    // init applies only after its dry run, whose Notes group already printed the pointers the
    // two share.
    const printed = new Set(applyDryRun.pointers);
    lines.push(
      { level: "success", text: "Calavera apply complete." },
      ...applyResult.pointers.filter((pointer) => !printed.has(pointer)).map(info),
    );
  }

  return lines;
}
