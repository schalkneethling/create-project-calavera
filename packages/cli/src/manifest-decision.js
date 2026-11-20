// @ts-check
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

/**
 * @typedef {import("./vite-plus-detection.js").VitePlusDetection} VitePlusDetection
 * @typedef {"create-here" | "apply-at-ancestor" | "abandon"} ManifestChoice
 * @typedef {{
 *   directory: string,
 *   ancestor: { manifestPath: string, status: "managed" | "unmanaged" },
 *   options: { choice: ManifestChoice, description: string }[],
 *   choice?: ManifestChoice,
 * }} ManifestDecision
 * @typedef {(decision: ManifestDecision) => Promise<ManifestChoice>} AskForManifestChoice
 */

/** The choices, in the order they are offered (ADR-0001, #430). */
export const manifestChoices = Object.freeze(
  /** @type {ManifestChoice[]} */ (["create-here", "apply-at-ancestor", "abandon"]),
);

/** @param {"managed" | "unmanaged"} status */
function verdictPhrase(status) {
  return status === "managed" ? "managed by Vite+" : "not managed by Vite+";
}

/**
 * The decision apply offers when `directory` has no readable package.json of its own but the
 * detection walk found a manifest above it (ADR-0001, the pure-function contract), or nothing
 * when there is no such decision to make.
 *
 * @param {string} directory The inspected directory.
 * @param {VitePlusDetection} detection Detection for `directory`.
 * @returns {ManifestDecision | undefined}
 */
export function manifestDecision(directory, detection) {
  if (detection.status !== "unknown" || !detection.ancestor) {
    return undefined;
  }

  const { ancestor } = detection;
  const ancestorDirectory = dirname(ancestor.manifestPath);

  return {
    directory,
    ancestor: { manifestPath: ancestor.manifestPath, status: ancestor.status },
    options: [
      {
        choice: "create-here",
        description: `Create package.json in ${directory} and apply the recipe there, as a project ${verdictPhrase(ancestor.status)}, which is the verdict of ${ancestor.manifestPath}.`,
      },
      {
        choice: "apply-at-ancestor",
        description: `Apply the recipe in ${ancestorDirectory} instead, after inspecting that directory again so the verdict is its own. Nothing in ${directory} changes.`,
      },
      { choice: "abandon", description: "Change nothing." },
    ],
  };
}

/**
 * The sentence that states the decision, which the terminal prompt asks.
 *
 * @param {ManifestDecision} decision
 */
export function manifestDecisionQuestion(decision) {
  return `${decision.directory} has no package.json of its own. The nearest manifest above it, ${decision.ancestor.manifestPath}, is ${verdictPhrase(decision.ancestor.status)}. Calavera does not choose for you; choose one of:`;
}

/**
 * The lines that state the decision and its choices, for the terminal and for the error a run
 * that cannot ask stops with.
 *
 * @param {ManifestDecision} decision
 * @returns {string[]}
 */
export function manifestDecisionLines(decision) {
  return [
    manifestDecisionQuestion(decision),
    ...decision.options.map(({ choice, description }) => `- ${choice}: ${description}`),
  ];
}

/**
 * The error a run that cannot ask stops with when no choice was given.
 *
 * @param {ManifestDecision} decision
 */
export function manifestChoiceRequiredError(decision) {
  return new Error(
    [
      ...manifestDecisionLines(decision),
      "Run apply again with --manifest-choice <choice>, or pass manifestChoice to dry_run_apply and apply_recipe. Calavera stopped before writing anything.",
    ].join("\n"),
  );
}

/**
 * The error for a choice given where there is no decision to make. A choice is never ignored,
 * because ignoring "abandon" would apply the recipe.
 *
 * @param {string} directory
 * @param {VitePlusDetection} detection
 */
export function manifestChoiceNotApplicableError(directory, detection) {
  return new Error(
    detection.status === "unknown"
      ? `${directory} has no package.json and no manifest above it was found, so there is no manifest choice to make. Remove --manifest-choice (manifestChoice), then run apply again. Calavera stopped before writing anything.`
      : `${directory} has its own package.json, so there is no manifest choice to make. Remove --manifest-choice (manifestChoice), then run apply again. Calavera stopped before writing anything.`,
  );
}

/**
 * Where `path`, given relative to the inspected directory or absolute, points once apply runs in
 * the ancestor's directory: a path inside the inspected directory moves to the same place under
 * the ancestor's directory, and any other path stays where it is. The result is absolute.
 *
 * @param {ManifestDecision} decision
 * @param {string} path
 */
export function pathAtAncestor(decision, path) {
  const absolute = resolve(decision.directory, path);
  const inside = relative(decision.directory, absolute);
  const outside = inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside);
  return inside === "" || outside
    ? absolute
    : join(dirname(decision.ancestor.manifestPath), inside);
}

/**
 * The error `init --apply` stops with before it writes the recipe, when the directory has no
 * package.json of its own but a manifest above it: only create-here applies where init writes the
 * recipe, so any other choice, or none, would leave the recipe in a directory apply does not use.
 *
 * @param {ManifestDecision} decision
 */
export function initApplyManifestChoiceError(decision) {
  return new Error(
    [
      ...manifestDecisionLines(decision),
      `init --apply writes calavera.config.json in ${decision.directory} before it applies, so it runs only with --manifest-choice create-here. To apply at the ancestor or to choose later, run init without --apply, then run apply, which offers the choices. Calavera stopped before writing anything.`,
    ].join("\n"),
  );
}

/**
 * The error apply-at-ancestor stops with when the ancestor's directory already has a Calavera
 * recipe or state, because applying this recipe there would replace another project's recipe or
 * state. The message names what was found: the bootstrap that `--init` runs writes the state
 * file without a recipe, so state alone does not show that the directory has a recipe (#1038).
 *
 * @param {ManifestDecision} decision
 * @param {string} existing The recipe or state file found in the ancestor's directory.
 * @param {"recipe" | "state"} kind Whether `existing` is a recipe or the state file.
 */
export function ancestorAlreadyManagedError(decision, existing, kind) {
  const ancestorDirectory = dirname(decision.ancestor.manifestPath);
  const [found, remedy] =
    kind === "recipe"
      ? ["the directory has a Calavera recipe of its own", "with its own recipe"]
      : [
          "Calavera has already recorded state for that directory",
          "with a recipe for that directory",
        ];
  return new Error(
    `apply-at-ancestor would apply this recipe in ${ancestorDirectory}, but ${existing} already exists there, so ${found}. Run apply in ${ancestorDirectory} ${remedy} instead, or choose create-here. Calavera stopped before writing anything.`,
  );
}
