export const NPM_LATEST_CLI_URL = "https://registry.npmjs.org/create-project-calavera/latest";
export const SAFE_CLI_FALLBACK_VERSION = "2.2.0";

const fallbackIntegrationIds = new Set([
  "editorconfig",
  "typescript",
  "oxlint",
  "oxlint-eslint",
  "oxlint-typescript",
  "oxlint-unicorn",
  "oxlint-oxc",
  "oxlint-import",
  "oxlint-react",
  "react-doctor",
  "oxlint-jsx-a11y",
  "oxlint-node",
  "oxlint-promise",
  "oxlint-vitest",
  "oxlint-jest",
  "oxlint-nextjs",
  "oxlint-vue",
  "oxlint-jsdoc",
  "oxfmt",
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
  "stylelint",
  "stylelint-standard",
  "stylelint-order",
  "stylelint-baseline",
  "stylelint-scss",
  "stylelint-stylistic",
  "css-property-type-validator",
  "prettier",
  "prettier-tailwind",
  "prettier-svelte",
  "prettier-astro",
]);

function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/.exec(version);
  if (!match) throw new Error(`Invalid Calavera CLI version: ${version}.`);

  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: Boolean(match[4]),
  };
}

export function versionMeetsMinimum(version, minimumVersion) {
  const current = parseVersion(version);
  const minimum = parseVersion(minimumVersion);

  for (let index = 0; index < current.numbers.length; index += 1) {
    if (current.numbers[index] !== minimum.numbers[index]) {
      return current.numbers[index] > minimum.numbers[index];
    }
  }

  return !current.prerelease || minimum.prerelease;
}

export function minimumCliVersionForIntegration(integration) {
  if (integration.minimumCliVersion) return integration.minimumCliVersion;
  if (fallbackIntegrationIds.has(integration.id)) return SAFE_CLI_FALLBACK_VERSION;

  throw new Error(
    `Integration ${integration.id} must declare minimumCliVersion before the hosted Composer can offer it.`,
  );
}

export function filterIntegrationsForCli(integrations, cliVersion) {
  return integrations.filter((integration) =>
    versionMeetsMinimum(cliVersion, minimumCliVersionForIntegration(integration)),
  );
}

export function integrationResponseForCli(response, cliVersion) {
  return {
    ...response,
    integrations: filterIntegrationsForCli(response.integrations, cliVersion),
  };
}

export function assertRecipeIntegrationsSupported(recipe, integrations, cliVersion) {
  const supportedIds = new Set(
    filterIntegrationsForCli(integrations, cliVersion).map(({ id }) => id),
  );
  const unsupportedIds = recipe.integrations.filter((id) => !supportedIds.has(id));

  if (unsupportedIds.length > 0) {
    throw new Error(
      `The published Calavera CLI v${cliVersion} does not support: ${unsupportedIds.join(
        ", ",
      )}. Wait for the required CLI release before downloading this recipe.`,
    );
  }

  return recipe;
}

export async function loadPublishedCliCompatibility(fetchLatest = globalThis.fetch) {
  try {
    const response = await fetchLatest(NPM_LATEST_CLI_URL, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new Error(`npm registry returned ${response.status}.`);

    const metadata = await response.json();
    parseVersion(metadata.version);
    return { version: metadata.version, source: "npm" };
  } catch {
    return { version: SAFE_CLI_FALLBACK_VERSION, source: "fallback" };
  }
}
