import {
  aiArtifactsResponse as buildAiArtifactsResponse,
  buildRecipe,
  catalogResponse as buildCatalogResponse,
  listAiArtifactOptions,
  listIntegrationOptions,
  normalizeAiArtifactInputs,
  packageManagerIdsForRecipe,
  profileDefaults,
  profileIdsForRecipe,
  validateRecipeCompositionInput,
} from "../src/recipe.js";
import { DEFAULT_AI_TARGET } from "../src/ai/catalog.js";

const form = document.querySelector("#composer");
const integrations = document.querySelector("#integrations");
const aiArtifacts = document.querySelector("#ai-artifacts");
const output = document.querySelector("#output");
const webMcpBanner = document.querySelector("#webmcp-banner");
const profiles = profileIdsForRecipe();
const packageManagers = packageManagerIdsForRecipe();
const aiArtifactOptions = listAiArtifactOptions();

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
    const artifact = aiArtifactOptions.find(({ id }) => id === checkbox.value);
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
  selectIntegrations(profileDefaults[profile]);
  syncAiTargetStates();
  render();
}

function validateConfigurationInput({ profile, packageManager = "npm", tools, aiArtifacts } = {}) {
  const validated = validateRecipeCompositionInput({ profile, packageManager, tools, aiArtifacts });
  return {
    profile: validated.profile,
    packageManager: validated.packageManager,
    tools: validated.tools,
    aiArtifacts: validated.aiArtifacts,
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
  return buildCatalogResponse(recipe());
}

function aiArtifactsResponse() {
  return buildAiArtifactsResponse(recipe().ai ?? []);
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
