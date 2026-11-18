// @ts-check

/**
 * @typedef {object} ArtifactTarget
 * @property {string} id
 * @property {string} label
 */

/**
 * @typedef {object} GroupedPromptSourceOption
 * @property {string} id
 * @property {string} [group]
 * @property {string} [label]
 * @property {string} [statusLabel]
 * @property {string} [type]
 * @property {ArtifactTarget[]} [targets]
 * @property {string} [defaultTarget]
 */

/**
 * The hint shows the catalog's display labels, never raw IDs (#990). An option without a
 * `statusLabel`, such as an AI artifact, shows no status, as in the Composer.
 *
 * @param {GroupedPromptSourceOption[]} options
 * @returns {Record<string, Array<{ value: string, label: string, hint: string }>>}
 */
export function groupedPromptOptions(options) {
  /** @type {Record<string, Array<{ value: string, label: string, hint: string }>>} */
  const groups = {};

  for (const option of options) {
    const group = option.group ?? "Other";
    const defaultTargetLabel = option.targets?.find(({ id }) => id === option.defaultTarget)?.label;
    groups[group] ??= [];
    groups[group].push({
      value: option.id,
      label: option.label ?? option.id,
      hint: [
        option.statusLabel,
        option.type,
        defaultTargetLabel ? `target: ${defaultTargetLabel}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  return groups;
}

/**
 * The choices for an artifact's target prompt: only the targets the catalog lists for it, by
 * label, so every answer passes recipe validation (#990).
 *
 * @param {{ targets: ArtifactTarget[] }} artifact
 * @returns {Array<{ value: string, label: string }>}
 */
export function artifactTargetPromptOptions({ targets }) {
  return targets.map(({ id, label }) => ({ value: id, label }));
}
