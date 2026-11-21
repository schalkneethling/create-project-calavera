// @ts-check
// The human-readable output of `init` around the apply dry run (#1022). With --apply, init prints
// the apply dry run with the grouped summary `apply --dry-run` prints (#617), so the recipe summary
// before it and the closing lines after it leave out what that summary names: the package
// manager, each integration with its packages, each artifact, and the notes. The `--json` result
// keeps its shape.
import { info } from "./summary-lines.js";
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
      info(`Integrations: ${(recipe.integrations ?? []).join(", ")}`),
    );
    if (Array.isArray(recipe.ai) && recipe.ai.length > 0) {
      lines.push(info(`AI artifacts: ${recipe.ai.length}`));
    }
  } else if (applyResult === undefined) {
    lines.push(info("Apply was previewed but not run."));
  }

  if (applyResult !== undefined) {
    lines.push({ level: "success", text: "Calavera apply complete." });
    // The dry run's Notes group already printed the pointers it shares with the apply.
    const printed = new Set(applyDryRun?.pointers);
    lines.push(...applyResult.pointers.filter((pointer) => !printed.has(pointer)).map(info));
  }

  return lines;
}
