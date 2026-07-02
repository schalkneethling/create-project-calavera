import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "./ai/catalog.js";
import { integrationCatalog } from "./catalog.js";
import {
  assertKnownValue,
  assertObjectArray,
  assertString,
  assertStringArray,
} from "./utils/assertions.js";

export const CONFIG_SCHEMA_URL = "https://calavera.schalkneethling.com/calavera.config.schema.json";

/**
 * @typedef {"npm" | "pnpm" | "yarn" | "bun"} PackageManager
 */

export const profileCatalog = [
  {
    id: "modern",
    label: "modern",
    description: "Newer, faster JavaScript, TypeScript, CSS linting, and formatting defaults.",
  },
  {
    id: "classic",
    label: "classic",
    description: "Widely used JavaScript, TypeScript, CSS linting, and formatting defaults.",
  },
  {
    id: "minimal",
    label: "minimal",
    description: "Only basic editor consistency settings.",
  },
];

export const packageManagerCatalog = [
  {
    id: "npm",
    label: "npm",
    description: "npm, the default Node.js package manager.",
  },
  {
    id: "pnpm",
    label: "pnpm",
    description: "pnpm, a fast disk-efficient package manager.",
  },
  {
    id: "yarn",
    label: "yarn",
    description: "Yarn package manager.",
  },
  {
    id: "bun",
    label: "bun",
    description: "Bun package manager and runtime.",
  },
];

export const projectLocalCommandCatalog = Object.freeze({
  npm: Object.freeze({
    label: "npm",
    agentBootstrap: "npm create project-calavera -- --init",
    applyDryRun: "npm create project-calavera apply -- --dry-run",
    applyRecipe: "npm create project-calavera apply",
  }),
  pnpm: Object.freeze({
    label: "pnpm",
    agentBootstrap: "pnpm dlx create-project-calavera --init",
    applyDryRun: "pnpm dlx create-project-calavera apply --dry-run",
    applyRecipe: "pnpm dlx create-project-calavera apply",
  }),
  yarn: Object.freeze({
    label: "Yarn",
    agentBootstrap: "yarn dlx create-project-calavera --init",
    applyDryRun: "yarn dlx create-project-calavera apply --dry-run",
    applyRecipe: "yarn dlx create-project-calavera apply",
  }),
  bun: Object.freeze({
    label: "Bun",
    agentBootstrap: "bunx create-project-calavera --init",
    applyDryRun: "bunx create-project-calavera apply --dry-run",
    applyRecipe: "bunx create-project-calavera apply",
  }),
});

export const projectLocalCommandNotes = Object.freeze({
  projectDirectory:
    "Run these commands from the project folder where you saved calavera.config.json.",
  agentBootstrap:
    "Optional. Bootstrap Calavera guidance when you want an agent to inspect, compose, preview, and apply recipes with approval.",
  applyDryRun: "Preview the saved recipe before changing files or installing dependencies.",
  applyRecipe: "Apply the saved recipe after reviewing and approving the dry-run output.",
});

export const aiArtifactTypes = ["skill", "hook", "agent"];

export const recipeCompositionToolNames = Object.freeze([
  "list_profiles",
  "list_integrations",
  "describe_integration",
  "list_ai_artifacts",
  "compose_recipe",
  "validate_recipe",
  "explain_recipe",
]);

export const standardMcpToolNames = Object.freeze([
  ...recipeCompositionToolNames,
  "dry_run_apply",
  "apply_recipe",
]);

export const webMcpToolNames = Object.freeze([...recipeCompositionToolNames, "download_recipe"]);

export const recipeToolDescriptions = Object.freeze({
  list_profiles:
    "List Calavera profiles, package managers, and default integrations. Use this first when composing a recipe.",
  list_integrations:
    "List available Calavera integration options. Pass a profile to see only integrations valid for that profile.",
  describe_integration:
    "Describe one Calavera integration, including its profile availability, dependency packages, and included parent integrations.",
  list_ai_artifacts:
    "List bundled AI skills, hooks, and agents that can be included in a Calavera recipe.",
  compose_recipe:
    "Compose a schema-valid Calavera recipe from a profile, package manager, integration IDs or labels, and optional AI artifacts.",
  validate_recipe:
    "Validate a Calavera recipe object before previewing, applying, or downloading it. Returns validation status and errors instead of writing files.",
  explain_recipe:
    "Explain the integrations selected by a Calavera recipe, including profile defaults and automatically included parent integrations.",
  dry_run_apply:
    "Preview applying a Calavera recipe in the current project. This does not write files or install packages, and should be shown to the user before apply_recipe.",
  apply_recipe:
    "Apply an approved Calavera recipe in the current project. Call only after presenting dry_run_apply output and receiving explicit user approval.",
  download_recipe:
    "Download a Calavera recipe as calavera.config.json. Pass a recipe from compose_recipe, or omit recipe to download the current visible composer recipe.",
});

export const recipeToolInputDescriptions = Object.freeze({
  profile: "Base Calavera tooling profile.",
  profileFilter: "Optional profile filter.",
  packageManager: "Package manager used for dependency installation and generated scripts.",
  tools: "Integration IDs or labels. Omit to use the selected profile defaults from list_profiles.",
  integrationId: "Integration ID or label from list_integrations.",
  aiArtifactId: "AI artifact ID, source, or label from list_ai_artifacts.",
  aiArtifactTarget: "Optional target directory for hook and agent artifacts.",
  aiArtifacts: "Bundled AI skills, hooks, and agents to include in the recipe.",
  recipe: "A Calavera recipe object.",
  packageManagerOverride: "Optional package manager override.",
  config: "Recipe file path to write before applying.",
  writeConfig: "Write the approved recipe to the config path before applying.",
  noInstall: "Skip package manager dependency installation.",
  optionalDownloadRecipe:
    "Optional Calavera recipe object. When omitted, the current visible composer recipe is downloaded.",
});

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

const profileIds = profileCatalog.map(({ id }) => id);
const packageManagerIds = packageManagerCatalog.map(({ id }) => id);

const profileSpecificIntegrations = {
  oxlint: ["modern"],
  "oxlint-eslint": ["modern"],
  "oxlint-typescript": ["modern"],
  "oxlint-unicorn": ["modern"],
  "oxlint-oxc": ["modern"],
  "oxlint-import": ["modern"],
  "oxlint-react": ["modern"],
  "oxlint-jsx-a11y": ["modern"],
  "oxlint-node": ["modern"],
  "oxlint-promise": ["modern"],
  "oxlint-vitest": ["modern"],
  "oxlint-jest": ["modern"],
  "oxlint-nextjs": ["modern"],
  "oxlint-vue": ["modern"],
  "oxlint-jsdoc": ["modern"],
  oxfmt: ["modern"],
  "react-doctor": ["modern", "classic"],
  eslint: ["classic"],
  "typescript-eslint": ["classic"],
  "eslint-config-prettier": ["classic"],
  "eslint-react": ["classic"],
  "eslint-jsx-a11y": ["classic"],
  "eslint-import": ["classic"],
  "eslint-n": ["classic"],
  "eslint-promise": ["classic"],
  "eslint-unicorn": ["classic"],
  "eslint-sonarjs": ["classic"],
  "eslint-vitest": ["classic"],
  "eslint-jest": ["classic"],
  prettier: ["classic"],
  "prettier-tailwind": ["classic"],
  "prettier-svelte": ["classic"],
  "prettier-astro": ["classic"],
};

export const defaultScriptFlags = {
  lint: true,
  "lint:fix": true,
  format: true,
  "format:check": true,
  typecheck: true,
  quality: true,
};

function normalizedToken(value) {
  return value.trim().toLowerCase();
}

function integrationProfiles(id) {
  return profileSpecificIntegrations[id] ?? profileIds;
}

function integrationIdForInput(value, integrationOptions = integrationCatalog) {
  const token = normalizedToken(value);
  const match = integrationOptions.find(
    ({ id, label }) => normalizedToken(id) === token || normalizedToken(label) === token,
  );

  return match?.id;
}

function aiArtifactIdForInput(value) {
  const token = normalizedToken(value);
  const match = aiArtifactCatalog.find(
    ({ id, label, src }) =>
      normalizedToken(id) === token ||
      normalizedToken(label) === token ||
      normalizedToken(src) === token,
  );

  return match?.id;
}

export function normalizeAiTarget(target, index) {
  assertString(`aiArtifacts[${index}].target`, target);

  const normalizedTarget = target.trim();

  if (
    normalizedTarget === "." ||
    normalizedTarget === ".." ||
    normalizedTarget.includes("/") ||
    normalizedTarget.includes("\\")
  ) {
    throw new Error(
      `Invalid aiArtifacts[${index}].target: ${normalizedTarget}. Targets must be a single directory name without path separators or traversal.`,
    );
  }

  return normalizedTarget;
}

export function profileIdsForRecipe() {
  return [...profileIds];
}

export function packageManagerIdsForRecipe() {
  return [...packageManagerIds];
}

export function projectLocalCommandsForPackageManager(packageManager = "npm") {
  assertKnownValue("packageManager", packageManager, packageManagerIds);
  return projectLocalCommandCatalog[packageManager];
}

export function projectLocalCommandSteps(packageManager = "npm") {
  const commands = projectLocalCommandsForPackageManager(packageManager);

  return [
    {
      id: "agentBootstrap",
      label: "Optional agent bootstrap",
      command: commands.agentBootstrap,
      description: projectLocalCommandNotes.agentBootstrap,
    },
    {
      id: "applyDryRun",
      label: "Review recipe changes",
      command: commands.applyDryRun,
      description: projectLocalCommandNotes.applyDryRun,
    },
    {
      id: "applyRecipe",
      label: "Apply approved recipe",
      command: commands.applyRecipe,
      description: projectLocalCommandNotes.applyRecipe,
    },
  ];
}

export function listIntegrationOptions(profile) {
  return integrationCatalog
    .map((integration) => ({
      ...integration,
      profiles: integrationProfiles(integration.id),
      description: `${integration.label}. Category: ${integration.group}. Status: ${integration.status}.`,
    }))
    .filter((integration) => !profile || integration.profiles.includes(profile));
}

export function listAiArtifactOptions() {
  return aiArtifactCatalog.map(({ id, type, src, group, label, status, defaultTarget }) => ({
    id,
    type,
    src,
    label,
    group,
    status,
    defaultTarget,
    description: `${label}. Type: ${type}. Source: ${src}.`,
  }));
}

export function normalizeIntegrationInputs(integrationInputs, profile) {
  assertStringArray("tools", integrationInputs);

  const integrationOptions = profile ? listIntegrationOptions(profile) : integrationCatalog;

  return integrationInputs.map(
    (value) => integrationIdForInput(value, integrationOptions) ?? value,
  );
}

export function normalizeAiArtifactInputs(artifactInputs = []) {
  assertObjectArray("aiArtifacts", artifactInputs);

  return artifactInputs.map((item, index) => {
    assertString(`aiArtifacts[${index}].id`, item.id);

    const id = aiArtifactIdForInput(item.id) ?? item.id;
    const artifact = aiArtifactCatalog.find((candidate) => candidate.id === id);

    if (!artifact) {
      throw new Error(
        `Invalid aiArtifacts[${index}].id: ${item.id}. Use artifact IDs, labels, or sources from list_ai_artifacts.`,
      );
    }

    let target;

    if (item.target !== undefined) {
      target = normalizeAiTarget(item.target, index);
    }

    if (artifact.type === "skill" && item.target !== undefined) {
      throw new Error(`Invalid aiArtifacts[${index}].target: skill artifacts do not use target.`);
    }

    return {
      id,
      target: artifact.defaultTarget ? target || artifact.defaultTarget : undefined,
    };
  });
}

export function aiArtifactRecipeItems(artifactInputs = []) {
  return normalizeAiArtifactInputs(artifactInputs).map(({ id, target }) => {
    const artifact = aiArtifactCatalog.find((candidate) => candidate.id === id);
    const item = {
      type: artifact.type,
      src: artifact.src,
    };

    if (artifact.defaultTarget) {
      item.target = target ?? artifact.defaultTarget;
    }

    return item;
  });
}

export function validateRecipeCompositionInput({
  profile,
  packageManager = "npm",
  tools,
  aiArtifacts,
} = {}) {
  assertKnownValue("profile", profile, profileIds);
  assertKnownValue("packageManager", packageManager, packageManagerIds);

  const allowedIntegrationIds = listIntegrationOptions(profile).map(({ id }) => id);
  const integrationIds = tools
    ? normalizeIntegrationInputs(tools, profile)
    : [...profileDefaults[profile]];
  const invalidIntegrationIds = integrationIds.filter((id) => !allowedIntegrationIds.includes(id));

  if (invalidIntegrationIds.length > 0) {
    throw new Error(
      `Invalid tools for the ${profile} profile: ${invalidIntegrationIds.join(", ")}. Use tool IDs or labels from list_integrations. Allowed IDs: ${allowedIntegrationIds.join(", ")}.`,
    );
  }

  return {
    profile,
    packageManager,
    tools: integrationIds,
    aiArtifacts: aiArtifacts ? normalizeAiArtifactInputs(aiArtifacts) : undefined,
  };
}

export function composeRecipe(configurationInput = {}) {
  const { profile, packageManager, tools, aiArtifacts } =
    validateRecipeCompositionInput(configurationInput);

  return buildRecipe(
    profile,
    tools,
    packageManager,
    aiArtifacts ? aiArtifactRecipeItems(aiArtifacts) : [],
  );
}

export function resolveRecipeIntegrations(recipe) {
  const selected = new Set(recipe.integrations ?? []);
  const queue = [...selected];

  for (let index = 0; index < queue.length; index += 1) {
    const integration = integrationCatalog.find(({ id }) => id === queue[index]);

    for (const includedId of integration?.includes ?? []) {
      if (!selected.has(includedId)) {
        selected.add(includedId);
        queue.push(includedId);
      }
    }
  }

  return integrationCatalog.filter((integration) => selected.has(integration.id));
}

export function explainRecipeIntegrations(recipe) {
  const selected = new Set(recipe.integrations ?? []);
  const defaults = new Set(profileDefaults[recipe.profile] ?? []);
  const reasons = new Map();

  for (const id of selected) {
    reasons.set(
      id,
      defaults.has(id)
        ? `Included by the ${recipe.profile} profile defaults.`
        : "Explicitly selected in the recipe.",
    );
  }

  for (const integration of integrationCatalog) {
    if (!selected.has(integration.id)) {
      continue;
    }

    for (const includedId of integration.includes ?? []) {
      if (!reasons.has(includedId)) {
        reasons.set(includedId, `Included because ${integration.label} requires it.`);
      }
    }
  }

  return resolveRecipeIntegrations(recipe).map(({ id, label, group, status }) => ({
    id,
    label,
    group,
    status,
    reason: reasons.get(id) ?? "Selected by the composed recipe.",
  }));
}

export function validateRecipe(recipe) {
  if (recipe === null || typeof recipe !== "object" || Array.isArray(recipe)) {
    throw new TypeError("Recipe must be an object.");
  }

  assertKnownValue("profile", recipe.profile, profileIds);
  assertKnownValue("packageManager", recipe.packageManager, packageManagerIds);
  assertStringArray("integrations", recipe.integrations);

  const knownIntegrationIds = integrationCatalog.map(({ id }) => id);
  const unknownIntegrationIds = recipe.integrations.filter(
    (id) => !knownIntegrationIds.includes(id),
  );

  if (unknownIntegrationIds.length > 0) {
    throw new Error(`Unknown integrations: ${unknownIntegrationIds.join(", ")}.`);
  }

  if (Object.hasOwn(recipe, "ai")) {
    assertObjectArray("ai", recipe.ai);
  }

  return recipe;
}

export function recipeWorkflow({ browser = false } = {}) {
  return browser ? [...webMcpToolNames] : [...standardMcpToolNames];
}

export function listProfilesResponse(options = {}) {
  return {
    profiles: profileCatalog.map(({ id, label, description }) => ({
      id,
      label,
      description,
      defaultIntegrations: [...profileDefaults[id]],
    })),
    packageManagers: packageManagerCatalog,
    workflow: recipeWorkflow(options),
  };
}

export function listIntegrationsResponse({ profile } = {}) {
  return {
    profile: profile ?? null,
    integrations: listIntegrationOptions(profile),
  };
}

export function describeIntegrationResponse(id) {
  const token = normalizedToken(String(id));
  const integration = listIntegrationOptions().find(
    ({ id: candidateId, label }) =>
      normalizedToken(candidateId) === token || normalizedToken(label) === token,
  );

  if (!integration) {
    throw new Error(`Unknown integration: ${String(id)}.`);
  }

  return integration;
}

export function composeRecipeResponse(configurationInput = {}, options = {}) {
  return {
    recipe: composeRecipe(configurationInput),
    workflow: recipeWorkflow(options),
  };
}

export function validateRecipeResponse(recipe) {
  try {
    validateRecipe(recipe);
    return { ok: true, recipe };
  } catch (error) {
    return {
      ok: false,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export function dependencyListForRecipe(recipe) {
  return [
    ...new Set(
      resolveRecipeIntegrations(recipe).flatMap((integration) => integration.dependencies ?? []),
    ),
  ];
}

export function explainRecipeResponse(recipeInput) {
  const recipe = validateRecipe(recipeInput);

  return {
    integrations: explainRecipeIntegrations(recipe),
    dependencies: dependencyListForRecipe(recipe),
    aiArtifacts: listAiArtifactOptions().filter((artifact) =>
      Array.isArray(recipe.ai)
        ? recipe.ai.some((item) => item.type === artifact.type && item.src === artifact.src)
        : false,
    ),
  };
}

export function catalogResponse(currentConfiguration) {
  return {
    profiles: profileCatalog.map(({ id, label, description }) => ({
      id,
      label,
      description,
      defaultIntegrations: profileDefaults[id],
    })),
    packageManagers: packageManagerCatalog,
    integrations: listIntegrationOptions(),
    aiArtifacts: listAiArtifactOptions(),
    toolInput: {
      accepts:
        "Use either an integration id or its label in the compose_recipe tools array. Matching is case-insensitive.",
      examples: ["typescript", "Stylelint", "JSX-A11y"],
    },
    defaults: profileDefaults,
    currentConfiguration,
  };
}

export function aiArtifactsResponse(currentConfiguration = []) {
  return {
    defaultTarget: DEFAULT_AI_TARGET,
    artifactTypes: aiArtifactTypes,
    artifacts: listAiArtifactOptions(),
    input: {
      accepts:
        "Use artifact IDs, labels, or sources in compose_recipe aiArtifacts. Add target for hook and agent artifacts when the default target is not correct.",
      examples: [
        { id: "skill-semantic-html" },
        { id: "hooks/block-dangerous-commands", target: "claude-code" },
        { id: "Technical devil's advocate", target: "claude-code" },
      ],
    },
    currentConfiguration,
  };
}

export function listAiArtifactsResponse(currentConfiguration = []) {
  return aiArtifactsResponse(currentConfiguration);
}

/**
 * @param {string} profile
 * @param {string[]} integrations
 * @param {PackageManager} [packageManager]
 * @param {{ type: string, src: string, target?: string }[]} [ai]
 */
export function buildRecipe(profile, integrations, packageManager = "npm", ai = []) {
  const recipe = {
    $schema: CONFIG_SCHEMA_URL,
    version: 1,
    profile,
    packageManager,
    integrations,
    scripts: { ...defaultScriptFlags },
  };

  if (ai.length > 0) {
    recipe.ai = ai;
  }

  return recipe;
}
