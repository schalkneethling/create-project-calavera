// The JavaScript and TypeScript toolchain integration ids removed under
// decision C2, shared by the removal tests and the Vite+ project flow test so
// the flow test cannot drift from what each removal took out.

// The fourteen Oxlint plugin packs ADR-0002 lists by name, with the parent entry.
export const removedOxlintIds = Object.freeze([
  "oxlint",
  "oxlint-eslint",
  "oxlint-typescript",
  "oxlint-unicorn",
  "oxlint-oxc",
  "oxlint-import",
  "oxlint-react",
  "oxlint-jsx-a11y",
  "oxlint-node",
  "oxlint-promise",
  "oxlint-vitest",
  "oxlint-jest",
  "oxlint-nextjs",
  "oxlint-vue",
  "oxlint-jsdoc",
]);

export const removedEslintIds = Object.freeze([
  "eslint",
  "typescript-eslint",
  "eslint-config-prettier",
  "eslint-react",
  "eslint-jsx-a11y",
  "eslint-import",
  "eslint-n",
  "eslint-promise",
  "eslint-unicorn",
  "eslint-sonarjs",
  "eslint-vitest",
  "eslint-jest",
]);

export const removedPrettierIds = Object.freeze([
  "prettier",
  "prettier-tailwind",
  "prettier-svelte",
  "prettier-astro",
]);

export const removedTypeScriptConfigId = "typescript";

/** @param {string} id */
export function isOxlintId(id) {
  return id.startsWith("oxlint");
}

/** @param {string} id */
export function isOxfmtId(id) {
  return id.startsWith("oxfmt");
}

/** @param {string} id */
export function isRemovedToolchainId(id) {
  return (
    removedEslintIds.includes(id) ||
    removedPrettierIds.includes(id) ||
    id === removedTypeScriptConfigId ||
    isOxlintId(id) ||
    isOxfmtId(id)
  );
}
