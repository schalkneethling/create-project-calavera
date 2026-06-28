import { buildRecipe } from "../src/recipe.js";
import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "../src/ai/catalog.js";

const catalog = [
  entry("editorconfig", "Project consistency", "EditorConfig", "recommended"),
  entry("typescript", "Type checking", "TypeScript type checking", "recommended"),
  entry("oxlint", "Modern JS/TS linting", "Oxlint", "recommended", ["modern"]),
  entry("oxlint-eslint", "Modern JS/TS linting", "Oxc ESLint compatibility rules", "recommended", [
    "modern",
  ]),
  entry("oxlint-typescript", "Modern JS/TS linting", "Oxc TypeScript rules", "recommended", [
    "modern",
  ]),
  entry("oxlint-unicorn", "Modern JS/TS linting", "Oxc Unicorn rules", "recommended", ["modern"]),
  entry("oxlint-oxc", "Modern JS/TS linting", "Oxc native rules", "recommended", ["modern"]),
  entry("oxlint-import", "Imports and modules", "Oxc import rules", "optional", ["modern"]),
  entry("oxlint-react", "React best practices", "Oxc React rules", "framework-specific", [
    "modern",
  ]),
  entry("react-doctor", "React best practices", "React Doctor", "framework-specific", [
    "modern",
    "classic",
  ]),
  entry("oxlint-jsx-a11y", "Accessibility", "Oxc JSX accessibility rules", "optional", ["modern"]),
  entry("oxlint-node", "Node package rules", "Oxc Node rules", "optional", ["modern"]),
  entry("oxlint-promise", "Promise safety", "Oxc Promise rules", "optional", ["modern"]),
  entry("oxlint-vitest", "Test rules", "Oxc Vitest rules", "optional", ["modern"]),
  entry("oxlint-jest", "Test rules", "Oxc Jest rules", "optional", ["modern"]),
  entry("oxlint-nextjs", "Framework rules", "Oxc Next.js rules", "framework-specific", ["modern"]),
  entry("oxlint-vue", "Framework rules", "Oxc Vue rules", "framework-specific", ["modern"]),
  entry("oxlint-jsdoc", "Documentation rules", "Oxc JSDoc rules", "optional", ["modern"]),
  entry("oxfmt", "Formatting", "Oxfmt", "experimental", ["modern"]),
  entry("eslint", "Classic JS/TS linting", "ESLint flat config", "recommended", ["classic"]),
  entry("typescript-eslint", "Classic JS/TS linting", "TypeScript ESLint", "recommended", [
    "classic",
  ]),
  entry("eslint-config-prettier", "Formatting", "Prettier compatibility", "recommended", [
    "classic",
  ]),
  entry("eslint-react", "React best practices", "ESLint React rules", "framework-specific", [
    "classic",
  ]),
  entry("eslint-jsx-a11y", "Accessibility", "ESLint JSX accessibility rules", "optional", [
    "classic",
  ]),
  entry("eslint-import", "Imports and modules", "ESLint import rules", "optional", ["classic"]),
  entry("eslint-n", "Node package rules", "ESLint Node rules", "optional", ["classic"]),
  entry("eslint-promise", "Promise safety", "ESLint Promise rules", "optional", ["classic"]),
  entry("eslint-unicorn", "Classic JS/TS linting", "Unicorn rules", "optional", ["classic"]),
  entry("eslint-sonarjs", "Classic JS/TS linting", "SonarJS rules", "optional", ["classic"]),
  entry("eslint-vitest", "Test rules", "ESLint Vitest rules", "optional", ["classic"]),
  entry("eslint-jest", "Test rules", "ESLint Jest rules", "optional", ["classic"]),
  entry("stylelint", "CSS linting", "Stylelint", "recommended"),
  entry("stylelint-standard", "CSS linting", "Stylelint standard config", "recommended"),
  entry("stylelint-order", "CSS property ordering", "CSS property ordering", "optional"),
  entry("stylelint-baseline", "CSS Baseline", "CSS Baseline", "recommended"),
  entry("stylelint-scss", "CSS linting", "SCSS support", "framework-specific"),
  entry("stylelint-stylistic", "CSS linting", "Stylelint stylistic rules", "optional"),
  entry(
    "css-property-type-validator",
    "CSS property type validation",
    "CSS property type validation",
    "experimental",
  ),
  entry("prettier", "Formatting", "Prettier", "recommended", ["classic"]),
  entry("prettier-tailwind", "Formatting", "Tailwind class sorting", "optional", ["classic"]),
  entry("prettier-svelte", "Formatting", "Svelte formatting", "framework-specific", ["classic"]),
  entry("prettier-astro", "Formatting", "Astro formatting", "framework-specific", ["classic"]),
];

function entry(id, group, label, status, profiles = ["modern", "classic", "minimal"]) {
  return { id, group, label, status, profiles };
}

const defaults = {
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

const form = document.querySelector("#composer");
const integrations = document.querySelector("#integrations");
const aiArtifacts = document.querySelector("#ai-artifacts");
const output = document.querySelector("#output");
const webMcpBanner = document.querySelector("#webmcp-banner");
const profiles = Object.keys(defaults);
const packageManagers = ["npm", "pnpm", "yarn", "bun"];
const aiArtifactTypes = ["skill", "hook", "agent"];
const profileDescriptions = {
  modern: "Newer, faster JavaScript, TypeScript, CSS linting, and formatting defaults.",
  classic: "Widely used JavaScript, TypeScript, CSS linting, and formatting defaults.",
  minimal: "Only basic editor consistency settings.",
};
const packageManagerDescriptions = {
  npm: "npm, the default Node.js package manager.",
  pnpm: "pnpm, a fast disk-efficient package manager.",
  yarn: "Yarn package manager.",
  bun: "Bun package manager and runtime.",
};

function selectedProfile() {
  return new FormData(form).get("profile");
}

function visibleCatalog(profile = selectedProfile()) {
  return catalog.filter(({ profiles }) => profiles.includes(profile));
}

function integrationIdsForProfile(profile) {
  return visibleCatalog(profile).map(({ id }) => id);
}

function normalizedToolToken(value) {
  return value.trim().toLowerCase();
}

function integrationIdForTool(value) {
  const token = normalizedToolToken(value);
  const match = catalog.find(
    ({ id, label }) => normalizedToolToken(id) === token || normalizedToolToken(label) === token,
  );

  return match?.id;
}

function aiArtifactIdForInput(value) {
  const token = normalizedToolToken(value);
  const match = aiArtifactCatalog.find(
    ({ id, label, src }) =>
      normalizedToolToken(id) === token ||
      normalizedToolToken(label) === token ||
      normalizedToolToken(src) === token,
  );

  return match?.id;
}

function renderIntegrations() {
  integrations.replaceChildren();

  const groups = visibleCatalog().reduce((grouped, item) => {
    grouped.set(item.group, [...(grouped.get(item.group) ?? []), item]);
    return grouped;
  }, new Map());

  for (const [group, items] of groups) {
    const section = document.createElement("section");
    section.className = "integration-group";
    section.innerHTML = `<h2>${group}</h2>`;

    for (const { id, label, status } of items) {
      const option = document.createElement("label");
      option.htmlFor = `integration-${id}`;
      option.innerHTML = `
        <input id="integration-${id}" type="checkbox" name="integration" value="${id}" />
        <span>${label}</span>
        <small>${status}</small>
      `;
      section.append(option);
    }

    integrations.append(section);
  }
}

function renderAiArtifacts() {
  aiArtifacts.replaceChildren();

  const groups = aiArtifactCatalog.reduce((grouped, item) => {
    grouped.set(item.group, [...(grouped.get(item.group) ?? []), item]);
    return grouped;
  }, new Map());

  for (const [group, items] of groups) {
    const section = document.createElement("section");
    section.className = "integration-group";
    section.innerHTML = `<h2>${group}</h2>`;

    for (const artifact of items) {
      const option = document.createElement("div");
      option.className = "artifact-option";
      option.innerHTML = `
        <label for="ai-artifact-${artifact.id}">
          <input id="ai-artifact-${artifact.id}" type="checkbox" name="aiArtifact" value="${artifact.id}" />
          <span>${artifact.label}</span>
          <small>${artifact.status}</small>
        </label>
      `;

      if (artifact.defaultTarget) {
        const targetField = document.createElement("label");
        targetField.className = "artifact-target";
        targetField.htmlFor = `ai-target-${artifact.id}`;
        targetField.innerHTML = `
          Target for ${artifact.label}
          <input id="ai-target-${artifact.id}" type="text" value="${artifact.defaultTarget}" data-ai-target="${artifact.id}" disabled />
        `;
        option.append(targetField);
      }

      section.append(option);
    }

    aiArtifacts.append(section);
  }
}

function selectProfile(profile) {
  const radio = form.querySelector(`[name="profile"][value="${profile}"]`);
  radio.checked = true;
}

function selectPackageManager(packageManager) {
  form.querySelector('[name="packageManager"]').value = packageManager;
}

function selectIntegrations(integrationIds) {
  for (const checkbox of form.querySelectorAll('[name="integration"]')) {
    checkbox.checked = integrationIds.includes(checkbox.value);
  }
}

function selectAiArtifacts(artifactInputs) {
  const selectedArtifacts = new Map(artifactInputs.map((item) => [item.id, item]));

  for (const checkbox of form.querySelectorAll('[name="aiArtifact"]')) {
    checkbox.checked = selectedArtifacts.has(checkbox.value);
  }

  for (const targetInput of form.querySelectorAll("[data-ai-target]")) {
    const selectedArtifact = selectedArtifacts.get(targetInput.dataset.aiTarget);
    targetInput.value = selectedArtifact?.target ?? DEFAULT_AI_TARGET;
  }

  syncAiTargetStates();
}

function syncAiTargetStates() {
  for (const targetInput of form.querySelectorAll("[data-ai-target]")) {
    const checkbox = form.querySelector(
      `[name="aiArtifact"][value="${targetInput.dataset.aiTarget}"]`,
    );
    targetInput.disabled = !checkbox?.checked;
  }
}

function selectedAiItems() {
  return [...form.querySelectorAll('[name="aiArtifact"]:checked')].map((checkbox) => {
    const artifact = aiArtifactCatalog.find(({ id }) => id === checkbox.value);
    const item = {
      type: artifact.type,
      src: artifact.src,
    };

    if (artifact.defaultTarget) {
      const targetInput = form.querySelector(`[data-ai-target="${artifact.id}"]`);
      item.target = targetInput?.value.trim() || DEFAULT_AI_TARGET;
    }

    return item;
  });
}

function recipe() {
  const data = new FormData(form);
  const packageManager = data.get("packageManager");

  return buildRecipe(
    String(data.get("profile") ?? ""),
    data.getAll("integration").map(String),
    packageManager ? String(packageManager) : undefined,
    selectedAiItems(),
  );
}

function render() {
  output.textContent = JSON.stringify(recipe(), null, 2);
}

function setDefaults() {
  const profile = selectedProfile();

  renderIntegrations();
  selectIntegrations(defaults[profile]);
  syncAiTargetStates();
  render();
}

function assertString(name, value) {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string.`);
  }
}

function assertStringArray(name, value) {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) {
    throw new TypeError(`${name} must be an array of strings.`);
  }
}

function assertObjectArray(name, value) {
  if (
    !Array.isArray(value) ||
    value.some((item) => item === null || typeof item !== "object" || Array.isArray(item))
  ) {
    throw new TypeError(`${name} must be an array of objects.`);
  }
}

function assertKnownValue(name, value, allowedValues) {
  assertString(name, value);

  if (!allowedValues.includes(value)) {
    throw new Error(`Invalid ${name}: ${value}. Allowed values: ${allowedValues.join(", ")}.`);
  }
}

function normalizeIntegrationInputs(integrationInputs) {
  assertStringArray("tools", integrationInputs);

  return integrationInputs.map((value) => integrationIdForTool(value) ?? value);
}

function assertValidAiTarget(target, index) {
  assertString(`aiArtifacts[${index}].target`, target);

  if (target === "." || target === ".." || target.includes("/") || target.includes("\\")) {
    throw new Error(
      `Invalid aiArtifacts[${index}].target: ${target}. Targets must be a single directory name without path separators or traversal.`,
    );
  }
}

function normalizeAiArtifactInputs(artifactInputs = []) {
  assertObjectArray("aiArtifacts", artifactInputs);

  return artifactInputs.map((item, index) => {
    assertString(`aiArtifacts[${index}].id`, item.id);

    const id = aiArtifactIdForInput(item.id) ?? item.id;
    const artifact = aiArtifactCatalog.find((candidate) => candidate.id === id);

    if (!artifact) {
      throw new Error(
        `Invalid aiArtifacts[${index}].id: ${item.id}. Use artifact IDs, labels, or sources from get_ai_artifact_options.`,
      );
    }

    let target;

    if (item.target !== undefined) {
      assertString(`aiArtifacts[${index}].target`, item.target);
      target = item.target.trim();
      assertValidAiTarget(target, index);
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

function validateConfigurationInput({ profile, packageManager = "npm", tools, aiArtifacts } = {}) {
  assertKnownValue("profile", profile, profiles);
  assertKnownValue("packageManager", packageManager, packageManagers);

  const allowedIntegrationIds = integrationIdsForProfile(profile);
  const integrationIds = tools ? normalizeIntegrationInputs(tools) : defaults[profile];

  const invalidIntegrationIds = integrationIds.filter((id) => !allowedIntegrationIds.includes(id));

  if (invalidIntegrationIds.length > 0) {
    throw new Error(
      `Invalid tools for the ${profile} profile: ${invalidIntegrationIds.join(", ")}. Use tool IDs or labels from get_project_tooling_options. Allowed IDs: ${allowedIntegrationIds.join(", ")}.`,
    );
  }

  return {
    profile,
    packageManager,
    tools: integrationIds,
    aiArtifacts: aiArtifacts ? normalizeAiArtifactInputs(aiArtifacts) : undefined,
  };
}

function applyRecipeState(configurationInput = {}) {
  const { profile, packageManager, tools, aiArtifacts } =
    validateConfigurationInput(configurationInput);

  selectProfile(profile);
  renderIntegrations();
  selectPackageManager(packageManager);
  selectIntegrations(tools);
  if (aiArtifacts) {
    selectAiArtifacts(aiArtifacts);
  }
  render();

  return recipe();
}

async function saveFile() {
  const contents = JSON.stringify(recipe(), null, 2);

  if (!globalThis.showSaveFilePicker) {
    downloadFile();
    return;
  }

  const handle = await showSaveFilePicker({
    suggestedName: "calavera.config.json",
    types: [
      {
        description: "JSON",
        accept: { "application/json": [".json"] },
      },
    ],
  });
  const writable = await handle.createWritable();
  await writable.write(`${contents}\n`);
  await writable.close();
}

function downloadFile(recipeContents = recipe()) {
  const blob = new Blob([`${JSON.stringify(recipeContents, null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = "calavera.config.json";
  document.body.append(link);
  link.click();

  setTimeout(() => {
    link.remove();
    URL.revokeObjectURL(url);
  }, 100);
}

function catalogResponse() {
  return {
    profiles: profiles.map((id) => ({
      id,
      label: id,
      description: profileDescriptions[id],
      defaultIntegrations: defaults[id],
    })),
    packageManagers: packageManagers.map((id) => ({
      id,
      label: id,
      description: packageManagerDescriptions[id],
    })),
    integrations: catalog.map(({ id, group, label, status, profiles }) => ({
      id,
      label,
      group,
      status,
      profiles,
      description: `${label}. Category: ${group}. Status: ${status}.`,
    })),
    aiArtifacts: aiArtifactCatalog.map(
      ({ id, type, src, group, label, status, defaultTarget }) => ({
        id,
        type,
        src,
        label,
        group,
        status,
        defaultTarget,
        description: `${label}. Type: ${type}. Source: ${src}.`,
      }),
    ),
    toolInput: {
      accepts:
        "Use either an integration id or its label in the configure_project_tooling tools array. Matching is case-insensitive.",
      examples: ["typescript", "Stylelint", "Oxc JSX accessibility rules"],
    },
    defaults,
    currentConfiguration: recipe(),
  };
}

function aiArtifactsResponse() {
  return {
    defaultTarget: DEFAULT_AI_TARGET,
    artifactTypes: aiArtifactTypes,
    artifacts: aiArtifactCatalog.map(({ id, type, src, group, label, status, defaultTarget }) => ({
      id,
      type,
      src,
      label,
      group,
      status,
      defaultTarget,
      description: `${label}. Type: ${type}. Source: ${src}.`,
    })),
    input: {
      accepts:
        "Use artifact IDs, labels, or sources in configure_ai_artifacts. Add target for hook and agent artifacts when the default target is not correct.",
      examples: [
        { id: "skill-semantic-html" },
        { id: "hooks/block-dangerous-commands", target: "claude-code" },
        { id: "Technical devil's advocate", target: "claude-code" },
      ],
    },
    currentConfiguration: recipe().ai ?? [],
  };
}

function configureProjectTooling({ profile, packageManager, tools, aiArtifacts } = {}) {
  return applyRecipeState({ profile, packageManager, tools, aiArtifacts });
}

function configureAiArtifacts({ aiArtifacts = [] } = {}) {
  const normalizedAiArtifacts = normalizeAiArtifactInputs(aiArtifacts);

  selectAiArtifacts(normalizedAiArtifacts);
  render();

  return recipe();
}

function downloadConfigurationJson() {
  const recipeContents = recipe();
  downloadFile(recipeContents);

  return {
    downloaded: true,
    filename: "calavera.config.json",
    mimeType: "application/json",
    configuration: recipeContents,
  };
}

function revealWebMcpBanner() {
  webMcpBanner.hidden = false;
}

function registerWebMcpTools() {
  if (!navigator.modelContext?.registerTool) {
    return;
  }

  try {
    navigator.modelContext.registerTool({
      name: "get_project_tooling_options",
      description:
        "Read available package managers, preset profiles, linting options, formatting options, and the current project tooling configuration. Use this before updating the form when you need valid option IDs.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async () => catalogResponse(),
    });

    navigator.modelContext.registerTool({
      name: "get_ai_artifact_options",
      description:
        "Read available bundled AI skills, hooks, and agents for the Calavera recipe ai array. Use this before configuring AI artifacts when you need valid artifact IDs, sources, labels, types, or default hook and agent targets.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async () => aiArtifactsResponse(),
    });

    navigator.modelContext.registerTool({
      name: "configure_project_tooling",
      description:
        "Update the visible form for a project tooling configuration. Choose a preset profile, package manager, and optional tools for linters, formatters, TypeScript, CSS tooling, accessibility checks, and test rules. Returns the configuration JSON shown on the page.",
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: profiles,
            description:
              "Preset configuration to start from: modern uses newer fast tools, classic uses widely adopted tools, and minimal uses only basic editor consistency settings.",
          },
          packageManager: {
            type: "string",
            enum: packageManagers,
            default: "npm",
            description: "Package manager used to install and run the selected project tooling.",
          },
          tools: {
            type: "array",
            items: {
              type: "string",
            },
            description:
              "Tool IDs or labels to include in the configuration, such as linters, formatters, TypeScript support, CSS checks, accessibility checks, and test rules. Omit this field to use the selected profile defaults. Use get_project_tooling_options to see valid IDs and labels.",
          },
          aiArtifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "AI artifact ID, label, or source from get_ai_artifact_options, such as skill-semantic-html or hooks/block-dangerous-commands.",
                },
                target: {
                  type: "string",
                  description:
                    "Optional target directory for hook and agent artifacts. Skills do not use target.",
                },
              },
              required: ["id"],
              additionalProperties: false,
            },
            description:
              "Bundled AI skills, hooks, and agents to include in the recipe ai array. Omit to keep current AI selections unchanged.",
          },
        },
        required: ["profile"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false,
      },
      execute: async (input) => configureProjectTooling(input),
    });

    navigator.modelContext.registerTool({
      name: "configure_ai_artifacts",
      description:
        "Update only the AI artifact selections for the Calavera recipe ai array. Choose bundled skills, hooks, and agents from get_ai_artifact_options. Returns the full configuration JSON shown on the page.",
      inputSchema: {
        type: "object",
        properties: {
          aiArtifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description:
                    "AI artifact ID, label, or source from get_ai_artifact_options, such as skill-semantic-html or hooks/block-dangerous-commands.",
                },
                target: {
                  type: "string",
                  description:
                    "Optional target directory for hook and agent artifacts. Skills do not use target.",
                },
              },
              required: ["id"],
              additionalProperties: false,
            },
            default: [],
            description:
              "Bundled AI artifact selections. Pass an empty array to clear the recipe ai array.",
          },
        },
        required: ["aiArtifacts"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false,
      },
      execute: async (input) => configureAiArtifacts(input),
    });

    navigator.modelContext.registerTool({
      name: "download_configuration_json",
      description:
        "Download the current project tooling configuration as calavera.config.json. Use configure_project_tooling first when you need to change the selected profile, package manager, linters, formatters, or code quality tools before downloading.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false,
      },
      execute: async () => downloadConfigurationJson(),
    });

    revealWebMcpBanner();
  } catch (error) {
    console.info("WebMCP tool registration failed.", error);
  }
}

form.addEventListener("change", (event) => {
  if (event.target.name === "profile") {
    setDefaults();
  } else {
    syncAiTargetStates();
    render();
  }
});

document.querySelector("#save").addEventListener("click", () => {
  saveFile().catch((error) => {
    if (error.name !== "AbortError") {
      console.info(error);
    }
  });
});
document.querySelector("#download").addEventListener("click", () => {
  downloadFile();
});

renderAiArtifacts();
setDefaults();
registerWebMcpTools();
