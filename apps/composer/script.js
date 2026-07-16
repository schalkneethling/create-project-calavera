import {
  buildRecipe,
  composeRecipeResponse,
  describeIntegrationResponse,
  explainRecipeResponse,
  listAiArtifactsResponse,
  listAiArtifactOptions,
  listIntegrationOptions,
  listIntegrationsResponse,
  listProfilesResponse,
  normalizeAiTarget,
  packageManagerIdsForRecipe,
  projectLocalCommandNotes,
  projectLocalCommandSteps,
  profileDefaults,
  profileIdsForRecipe,
  recipeToolDescriptions,
  recipeToolInputDescriptions,
  validateRecipe,
  validateRecipeResponse,
} from "../../packages/cli/src/recipe.js";
import { DEFAULT_AI_TARGET } from "../../packages/cli/src/ai/catalog.js";
import {
  baselineMetadata,
  describeBaselineTarget,
  listBaselineTargets,
  recommendBaselineTarget,
  searchBaselineFeatures,
} from "../../packages/baseline-core/src/index.js";

const form = document.querySelector("#composer");
const integrations = document.querySelector("#integrations");
const aiArtifacts = document.querySelector("#ai-artifacts");
const output = document.querySelector("#output");
const nextCommands = document.querySelector("#next-commands");
const nextCommandsNote = document.querySelector("#next-commands-note");
const webMcpBanner = document.querySelector("#webmcp-banner");
const baselineOptions = document.querySelector("#baseline-options");
const baselineAvailable = document.querySelector("#baseline-available");
const profiles = profileIdsForRecipe();
const packageManagers = packageManagerIdsForRecipe();
const aiArtifactOptions = listAiArtifactOptions();

for (
  let year = baselineMetadata.currentYear;
  year >= baselineMetadata.firstBaselineYear;
  year -= 1
) {
  const option = document.createElement("option");
  option.value = String(year);
  option.textContent = `Baseline ${year}`;
  baselineAvailable.append(option);
}

function selectedProfile() {
  return new FormData(form).get("profile");
}

function visibleCatalog(profile = selectedProfile()) {
  return listIntegrationOptions(profile);
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

  const groups = aiArtifactOptions.reduce((grouped, item) => {
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
          <small>${artifact.status} · v${artifact.version}</small>
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

function selectIntegrations(integrationIds) {
  for (const checkbox of form.querySelectorAll('[name="integration"]')) {
    checkbox.checked = integrationIds.includes(checkbox.value);
  }
}

function syncAiTargetStates() {
  for (const targetInput of form.querySelectorAll("[data-ai-target]")) {
    const checkbox = form.querySelector(
      `[name="aiArtifact"][value="${targetInput.dataset.aiTarget}"]`,
    );
    targetInput.disabled = !checkbox?.checked;
  }
}

function syncIntegrationOptions() {
  const enabled = Boolean(
    form.querySelector('[name="integration"][value="stylelint-baseline"]:checked'),
  );
  baselineOptions.hidden = !enabled;
}

function selectedAiItems() {
  return [...form.querySelectorAll('[name="aiArtifact"]:checked')].map((checkbox, index) => {
    const artifact = aiArtifactOptions.find(({ id }) => id === checkbox.value);
    const item = { id: artifact.id };

    if (artifact.defaultTarget) {
      const targetInput = form.querySelector(`[data-ai-target="${artifact.id}"]`);
      item.target =
        normalizeAiTarget(targetInput?.value ?? DEFAULT_AI_TARGET, index) || DEFAULT_AI_TARGET;
    }

    return item;
  });
}

function recipe() {
  const data = new FormData(form);
  const packageManager = data.get("packageManager");

  const hasBaseline = data.getAll("integration").includes("stylelint-baseline");
  const integrationOptions = hasBaseline
    ? {
        "stylelint-baseline": {
          available: /^\d{4}$/.test(String(data.get("baselineAvailable")))
            ? Number(data.get("baselineAvailable"))
            : data.get("baselineAvailable"),
          severity: data.get("baselineSeverity"),
        },
      }
    : undefined;

  return buildRecipe(
    String(data.get("profile") ?? ""),
    data.getAll("integration").map(String),
    packageManager ? String(packageManager) : undefined,
    selectedAiItems(),
    integrationOptions,
  );
}

function selectedPackageManager() {
  const packageManager = new FormData(form).get("packageManager");
  return packageManager ? String(packageManager) : "npm";
}

function renderNextCommands() {
  nextCommands.replaceChildren();
  nextCommandsNote.textContent = projectLocalCommandNotes.projectDirectory;

  for (const step of projectLocalCommandSteps(selectedPackageManager())) {
    const item = document.createElement("li");
    const label = document.createElement("strong");
    const description = document.createElement("span");
    const command = document.createElement("code");

    label.textContent = step.label;
    description.textContent = step.description;
    command.textContent = step.command;

    item.append(label, description, command);
    nextCommands.append(item);
  }
}

function render() {
  output.textContent = JSON.stringify(recipe(), null, 2);
  renderNextCommands();
}

function setDefaults() {
  const profile = selectedProfile();

  renderIntegrations();
  selectIntegrations(profileDefaults[profile]);
  syncAiTargetStates();
  syncIntegrationOptions();
  render();
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

function downloadRecipe({ recipe: recipeInput } = {}) {
  const recipeContents = recipeInput === undefined ? recipe() : validateRecipe(recipeInput);
  downloadFile(recipeContents);

  return {
    downloaded: true,
    filename: "calavera.config.json",
    mimeType: "application/json",
    recipe: recipeContents,
    browserConstraint:
      "WebMCP can download recipes from the browser, but cannot dry-run or apply them to a project filesystem.",
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
      name: "list_profiles",
      description: recipeToolDescriptions.list_profiles,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async () => listProfilesResponse({ browser: true }),
    });

    navigator.modelContext.registerTool({
      name: "list_integrations",
      description: recipeToolDescriptions.list_integrations,
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: profiles,
            description: recipeToolInputDescriptions.profileFilter,
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async (input) => listIntegrationsResponse(input),
    });

    navigator.modelContext.registerTool({
      name: "describe_integration",
      description: recipeToolDescriptions.describe_integration,
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: recipeToolInputDescriptions.integrationId,
          },
        },
        required: ["id"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async (input) => describeIntegrationResponse(input.id),
    });

    navigator.modelContext.registerTool({
      name: "list_ai_artifacts",
      description: recipeToolDescriptions.list_ai_artifacts,
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async () => listAiArtifactsResponse(recipe().ai ?? []),
    });

    navigator.modelContext.registerTool({
      name: "list_baseline_targets",
      description: recipeToolDescriptions.list_baseline_targets,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async () => ({ metadata: baselineMetadata, targets: listBaselineTargets() }),
    });

    navigator.modelContext.registerTool({
      name: "describe_baseline_target",
      description: recipeToolDescriptions.describe_baseline_target,
      inputSchema: {
        type: "object",
        properties: {
          target: {
            oneOf: [{ type: "string", enum: ["widely", "newly"] }, { type: "integer" }],
            description: recipeToolInputDescriptions.baselineTarget,
          },
        },
        required: ["target"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async ({ target }) => describeBaselineTarget(target),
    });

    navigator.modelContext.registerTool({
      name: "search_baseline_features",
      description: recipeToolDescriptions.search_baseline_features,
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: recipeToolInputDescriptions.baselineQuery },
          limit: {
            type: "integer",
            minimum: 1,
            maximum: 100,
            description: recipeToolInputDescriptions.baselineLimit,
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async ({ query, limit }) => ({
        metadata: baselineMetadata,
        features: searchBaselineFeatures(query, { limit }),
      }),
    });

    navigator.modelContext.registerTool({
      name: "recommend_baseline_target",
      description: recipeToolDescriptions.recommend_baseline_target,
      inputSchema: {
        type: "object",
        properties: {
          features: {
            type: "array",
            minItems: 1,
            items: { type: "string" },
            description: recipeToolInputDescriptions.baselineFeatures,
          },
        },
        required: ["features"],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: async ({ features }) => recommendBaselineTarget(features),
    });

    navigator.modelContext.registerTool({
      name: "compose_recipe",
      description: recipeToolDescriptions.compose_recipe,
      inputSchema: {
        type: "object",
        properties: {
          profile: {
            type: "string",
            enum: profiles,
            description: recipeToolInputDescriptions.profile,
          },
          packageManager: {
            type: "string",
            enum: packageManagers,
            default: "npm",
            description: recipeToolInputDescriptions.packageManager,
          },
          tools: {
            type: "array",
            items: {
              type: "string",
            },
            description: recipeToolInputDescriptions.tools,
          },
          aiArtifacts: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                  description: recipeToolInputDescriptions.aiArtifactId,
                },
                target: {
                  type: "string",
                  description: recipeToolInputDescriptions.aiArtifactTarget,
                },
              },
              required: ["id"],
              additionalProperties: false,
            },
            description: recipeToolInputDescriptions.aiArtifacts,
          },
          integrationOptions: {
            type: "object",
            description: recipeToolInputDescriptions.integrationOptions,
            additionalProperties: false,
            properties: {
              "stylelint-baseline": {
                type: "object",
                additionalProperties: false,
                required: ["available", "severity"],
                properties: {
                  available: {
                    oneOf: [{ type: "string", enum: ["widely", "newly"] }, { type: "integer" }],
                  },
                  severity: { type: "string", enum: ["warning", "error"] },
                },
              },
            },
          },
        },
        required: ["profile"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async (input) => composeRecipeResponse(input, { browser: true }),
    });

    navigator.modelContext.registerTool({
      name: "validate_recipe",
      description: recipeToolDescriptions.validate_recipe,
      inputSchema: {
        type: "object",
        properties: {
          recipe: {
            type: "object",
            description: recipeToolInputDescriptions.recipe,
          },
        },
        required: ["recipe"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async (input) => validateRecipeResponse(input.recipe),
    });

    navigator.modelContext.registerTool({
      name: "explain_recipe",
      description: recipeToolDescriptions.explain_recipe,
      inputSchema: {
        type: "object",
        properties: {
          recipe: {
            type: "object",
            description: recipeToolInputDescriptions.recipe,
          },
        },
        required: ["recipe"],
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: true,
        untrustedContentHint: false,
      },
      execute: async (input) => explainRecipeResponse(input.recipe),
    });

    navigator.modelContext.registerTool({
      name: "download_recipe",
      description: recipeToolDescriptions.download_recipe,
      inputSchema: {
        type: "object",
        properties: {
          recipe: {
            type: "object",
            description: recipeToolInputDescriptions.optionalDownloadRecipe,
          },
        },
        additionalProperties: false,
      },
      annotations: {
        readOnlyHint: false,
        untrustedContentHint: false,
      },
      execute: async (input) => downloadRecipe(input),
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
    syncIntegrationOptions();
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
