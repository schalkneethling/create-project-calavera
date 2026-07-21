// @ts-check

/**
 * @typedef {object} GroupedPromptSourceOption
 * @property {string} id
 * @property {string} [group]
 * @property {string} [label]
 * @property {string} [status]
 * @property {string} [type]
 * @property {string} [defaultTarget]
 */

/**
 * @param {GroupedPromptSourceOption[]} options
 * @returns {Record<string, Array<{ value: string, label: string, hint: string }>>}
 */
export function groupedPromptOptions(options) {
  /** @type {Record<string, Array<{ value: string, label: string, hint: string }>>} */
  const groups = {};

  for (const option of options) {
    const group = option.group ?? "Other";
    groups[group] ??= [];
    groups[group].push({
      value: option.id,
      label: option.label ?? option.id,
      hint: [
        option.status,
        option.type,
        option.defaultTarget ? `target: ${option.defaultTarget}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
    });
  }

  return groups;
}
