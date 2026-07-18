export const NPM_LATEST_CLI_URL = "https://registry.npmjs.org/create-project-calavera/latest";
export const SAFE_CLI_FALLBACK_VERSION = "2.2.0";
export const CLI_VERSION_PATTERN =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

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
  const match = CLI_VERSION_PATTERN.exec(version);
  if (!match) throw new Error(`Invalid Calavera CLI version: ${version}.`);

  return {
    numbers: match.slice(1, 4).map(Number),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function comparePrereleaseIdentifiers(current, minimum) {
  const length = Math.max(current.length, minimum.length);

  for (let index = 0; index < length; index += 1) {
    const currentIdentifier = current[index];
    const minimumIdentifier = minimum[index];
    if (currentIdentifier === undefined) return -1;
    if (minimumIdentifier === undefined) return 1;
    if (currentIdentifier === minimumIdentifier) continue;

    const currentIsNumeric = /^\d+$/.test(currentIdentifier);
    const minimumIsNumeric = /^\d+$/.test(minimumIdentifier);
    if (currentIsNumeric && minimumIsNumeric) {
      return Number(currentIdentifier) > Number(minimumIdentifier) ? 1 : -1;
    }
    if (currentIsNumeric !== minimumIsNumeric) return currentIsNumeric ? -1 : 1;
    return currentIdentifier > minimumIdentifier ? 1 : -1;
  }

  return 0;
}

export function versionMeetsMinimum(version, minimumVersion) {
  const current = parseVersion(version);
  const minimum = parseVersion(minimumVersion);

  for (let index = 0; index < current.numbers.length; index += 1) {
    if (current.numbers[index] !== minimum.numbers[index]) {
      return current.numbers[index] > minimum.numbers[index];
    }
  }

  if (current.prerelease.length === 0) return true;
  if (minimum.prerelease.length === 0) return false;
  return comparePrereleaseIdentifiers(current.prerelease, minimum.prerelease) >= 0;
}

export function isFallbackCliIntegration(id) {
  return fallbackIntegrationIds.has(id);
}

function minimumCliVersionForIntegration(integration) {
  if (integration.minimumCliVersion) return integration.minimumCliVersion;
  if (isFallbackCliIntegration(integration.id)) return SAFE_CLI_FALLBACK_VERSION;

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
