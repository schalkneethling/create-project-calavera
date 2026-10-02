import {
  composeRecipeResponse,
  describeIntegrationResponse,
  explainRecipeResponse,
  listAiArtifactsResponse,
  listAiArtifactOptions,
  listIntegrationOptions,
  listIntegrationsResponse,
  listProfilesResponse,
  packageManagerIdsForRecipe,
  profileCatalog,
  profileDefaults,
  profileIdsForRecipe,
  recipeToolDescriptions,
  recipeToolInputDescriptions,
  validateRecipeResponse,
} from "../../packages/cli/src/recipe.js";
import { aiArtifactCatalog, DEFAULT_AI_TARGET } from "../../packages/cli/src/ai/catalog.js";
import {
  baselineMetadata,
  describeBaselineTarget,
  listBaselineTargets,
  recommendBaselineTarget,
  searchBaselineFeatures,
} from "../../packages/baseline-core/src/index.js";
import {
  artifactResponseForCli,
  filterArtifactsForCli,
  filterIntegrationsForCli,
  filterProfilesForCli,
  integrationResponseForCli,
  loadPublishedCliCompatibility,
  SAFE_CLI_FALLBACK_VERSION,
  versionSatisfiesCompatibility,
} from "./cli-compatibility.js";
import {
  assertPublishedCliCompatibility,
  commaSeparatedValues,
  composerNextCommands,
  composerRecipe,
} from "./recipe-builder.js";
import { releaseEnvironmentInputSchema } from "./repository-controls-input-schema.js";

const form = document.querySelector("#composer");
const integrations = document.querySelector("#integrations");
const cssRows = document.querySelector("#css-rows");
const aiArtifacts = document.querySelector("#ai-artifacts");
const artifactTabs = document.querySelector("#artifact-tabs");
const aiTargetAll = document.querySelector("#ai-target-all");
const output = document.querySelector("#output");
const recipeSummary = document.querySelector("#recipe-summary");
const nextCommands = document.querySelector("#next-commands");
const optionalCommand = document.querySelector("#optional-command");
const webMcpBanner = document.querySelector("#webmcp-banner");
const newProject = document.querySelector("#new-project");
const baselineOptions = document.querySelector("#baseline-options");
const baselineAvailable = document.querySelector("#baseline-available");
const repositoryControlsOptions = document.querySelector("#repository-controls-options");
const cliVersionBadge = document.querySelector("#cli-version");
const cliCompatibilityNote = document.querySelector("#cli-compatibility");
const profiles = profileIdsForRecipe();
const packageManagers = packageManagerIdsForRecipe();
const allAiArtifactOptions = listAiArtifactOptions();
const NEW_PROJECT_CLI_RANGE = ">=4.0.0";
const statusLabels = {
  recommended: "Recommended",
  optional: "Optional",
  "framework-specific": "Framework",
  experimental: "Experimental",
};
const statusChipClasses = {
  recommended: "chip-recommended",
  optional: "chip-optional",
  "framework-specific": "chip-framework",
  experimental: "chip-experimental",
};
const targetLabels = {
  "claude-code": "Claude Code",
  codex: "Codex",
  cursor: "Cursor",
  opencode: "OpenCode",
};
let cliCompatibility = {
  version: SAFE_CLI_FALLBACK_VERSION,
  source: "fallback",
};
let selectedArtifactGroup;
// Artifacts whose own target select the user changed; re-selecting one keeps that target.
const targetOverrides = new Set();

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

/**
 * Creates an element with attributes and children. Text children are set as text, never as HTML.
 *
 * @param {string} tagName
 * @param {Record<string, string | boolean | undefined>} [attributes]
 * @param {(Node | string)[]} [children]
 */
function element(tagName, attributes = {}, children = []) {
  const node = document.createElement(tagName);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(name, value === true ? "" : value);
  }
  node.append(...children);
  return node;
}

function chevron() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "chevron");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M5 8l5 5 5-5");
  svg.append(path);
  return svg;
}

/**
 * A selectable row: the checkbox and its label select the item; the disclosure beside them only
 * shows or hides the details, so the two never toggle each other.
 *
 * @param {{ name: string, id: string, label: string, chip?: HTMLElement, details?: Node[] }} row
 */
function selectableRow({ name, id, label, chip, details }) {
  const inputId = `${name}-${id}`;
  const row = element("li", { class: "row" }, [
    element("div", { class: "row-head" }, [
      element("input", { id: inputId, type: "checkbox", name, value: id }),
      element("label", { for: inputId }, [label]),
      ...(chip ? [chip] : []),
    ]),
  ]);

  if (details && details.length > 0) {
    row.append(
      element("details", {}, [
        element("summary", {}, [
          element("span", { class: "visually-hidden" }, [`Details for ${label}`]),
          chevron(),
        ]),
        element("div", { class: "row-details" }, details),
      ]),
    );
  }

  return row;
}

/** @param {string} url */
function linkText(url) {
  const { hostname, pathname } = new URL(url);
  const host = hostname.replace(/^www\./, "");
  return pathname === "/" ? host : `${host}${pathname.replace(/\/$/, "")}`;
}

function selectedProfile() {
  return new FormData(form).get("profile");
}

function selectedPackageManager() {
  const packageManager = new FormData(form).get("packageManager");
  return packageManager ? String(packageManager) : undefined;
}

function visibleCatalog(profile = selectedProfile()) {
  return filterIntegrationsForCli(listIntegrationOptions(profile), cliCompatibility.version);
}

function supportedIntegrationIds() {
  return new Set(visibleCatalog().map(({ id }) => id));
}

function visibleAiArtifacts() {
  return filterArtifactsForCli(allAiArtifactOptions, cliCompatibility.version);
}

function visibleProfiles() {
  return filterProfilesForCli(profileCatalog, cliCompatibility.version);
}

function renderCliCompatibility() {
  const allIntegrations = listIntegrationOptions();
  const availableIntegrations = filterIntegrationsForCli(allIntegrations, cliCompatibility.version);
  const hiddenIntegrationCount = allIntegrations.length - availableIntegrations.length;
  const hiddenArtifactCount = allAiArtifactOptions.length - visibleAiArtifacts().length;
  const hiddenProfileCount = profileCatalog.length - visibleProfiles().length;
  const hidden = [
    hiddenProfileCount > 0
      ? `${hiddenProfileCount} profile${hiddenProfileCount === 1 ? "" : "s"}`
      : undefined,
    hiddenIntegrationCount > 0
      ? `${hiddenIntegrationCount} integration${hiddenIntegrationCount === 1 ? "" : "s"}`
      : undefined,
    hiddenArtifactCount > 0
      ? `${hiddenArtifactCount} AI artifact${hiddenArtifactCount === 1 ? "" : "s"}`
      : undefined,
  ].filter(Boolean);

  cliVersionBadge.textContent =
    cliCompatibility.source === "npm"
      ? `create-project-calavera ${cliCompatibility.version} on npm`
      : `create-project-calavera ${cliCompatibility.version}, safe fallback`;
  cliCompatibilityNote.hidden = hidden.length === 0;
  cliCompatibilityNote.textContent =
    hidden.length > 0 ? `${hidden.join(" and ")} waiting for a newer CLI release.` : "";
  newProject.hidden = !versionSatisfiesCompatibility(
    cliCompatibility.version,
    NEW_PROJECT_CLI_RANGE,
  );
}

function syncProfileAvailability() {
  const supportedIds = new Set(visibleProfiles().map(({ id }) => id));

  for (const radio of form.querySelectorAll('[name="profile"]')) {
    const supported = supportedIds.has(radio.value);
    radio.disabled = !supported;
    radio.closest("label").hidden = !supported;
  }

  if (!supportedIds.has(selectedProfile())) {
    const firstSupportedId = profiles.find((id) => supportedIds.has(id));
    if (firstSupportedId) {
      form.querySelector(`[name="profile"][value="${firstSupportedId}"]`).checked = true;
    }
  }
}

/** @param {ReturnType<typeof listIntegrationOptions>[number]} integration */
function integrationRow(integration) {
  const details = [];
  if (integration.summary) details.push(element("p", {}, [integration.summary]));
  if (integration.homepage) {
    details.push(element("a", { href: integration.homepage }, [linkText(integration.homepage)]));
  }

  return selectableRow({
    name: "integration",
    id: integration.id,
    label: integration.label,
    chip: element(
      "span",
      { class: `chip ${statusChipClasses[integration.status] ?? "chip-optional"}` },
      [statusLabels[integration.status] ?? integration.status],
    ),
    details,
  });
}

/**
 * Groups catalog entries by their `group`, in the order each group first appears. This is the
 * order the Composer has always listed, and so recorded, integrations and AI artifacts in.
 *
 * @template {{ group: string }} T
 * @param {T[]} items
 * @returns {Map<string, T[]>}
 */
function groupedByCatalogGroup(items) {
  return items.reduce((grouped, item) => {
    grouped.set(item.group, [...(grouped.get(item.group) ?? []), item]);
    return grouped;
  }, new Map());
}

const integrationOrder = [...groupedByCatalogGroup(listIntegrationOptions()).values()]
  .flat()
  .map(({ id }) => id);

/**
 * Stylelint-based integrations share the CSS section; every other catalog group gets its own.
 *
 * @param {ReturnType<typeof listIntegrationOptions>[number]} integration
 */
function isCssIntegration(integration) {
  return integration.platform.startsWith("stylelint");
}

function renderIntegrations() {
  syncProfileAvailability();
  integrations.replaceChildren();
  cssRows.replaceChildren();
  renderCliCompatibility();

  const groups = groupedByCatalogGroup(visibleCatalog());
  let cssItemCount = 0;

  for (const [group, items] of groups) {
    if (items.every(isCssIntegration)) {
      cssRows.append(...items.map(integrationRow));
      cssItemCount += items.length;
      continue;
    }

    const section = element("section", { class: "group" }, [
      element("h3", { class: "group-heading" }, [group]),
      element("ul", { class: "rows" }, items.map(integrationRow)),
    ]);
    if (items.some(({ appliesAt }) => appliesAt === "repository-root")) {
      section.append(element("p", { class: "hint" }, ["Applies at the repository root."]));
    }
    integrations.append(section);
  }

  cssRows.closest("section").hidden = cssItemCount === 0;
}

function artifactTargets(artifactId) {
  return aiArtifactCatalog.find(({ id }) => id === artifactId)?.targets ?? [];
}

/** @param {string[]} targets */
function targetOptions(targets) {
  return targets.map((target) =>
    element("option", { value: target, selected: target === aiTargetAll.value || undefined }, [
      targetLabels[target] ?? target,
    ]),
  );
}

/** @param {ReturnType<typeof listAiArtifactOptions>[number]} artifact */
function artifactRow(artifact) {
  const npmUrl = `https://www.npmjs.com/package/${artifact.packageName}`;
  const details = [
    element("dl", { class: "facts" }, [
      element("div", {}, [element("dt", {}, ["Type"]), element("dd", {}, [artifact.type])]),
      element("div", {}, [
        element("dt", {}, ["Package"]),
        element("dd", {}, [element("a", { href: npmUrl }, [artifact.packageName])]),
      ]),
    ]),
  ];

  if (artifact.defaultTarget) {
    details.push(
      element("div", { class: "inline-field" }, [
        element("label", { for: `ai-target-${artifact.id}` }, [`Install ${artifact.label} into`]),
        element(
          "select",
          { id: `ai-target-${artifact.id}`, "data-ai-target": artifact.id, disabled: true },
          targetOptions(artifactTargets(artifact.id)),
        ),
      ]),
    );
  }

  return selectableRow({ name: "aiArtifact", id: artifact.id, label: artifact.label, details });
}

/** @param {string} group */
function selectArtifactGroup(group) {
  selectedArtifactGroup = group;
  for (const tab of artifactTabs.querySelectorAll('[role="tab"]')) {
    const selected = tab.dataset.group === group;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of aiArtifacts.querySelectorAll('[role="tabpanel"]')) {
    panel.hidden = panel.dataset.group !== group;
  }
}

function renderAiTargetAll() {
  const targets = [...new Set(visibleAiArtifacts().flatMap(({ id }) => artifactTargets(id)))];
  const current = aiTargetAll.value || DEFAULT_AI_TARGET;
  aiTargetAll.replaceChildren(
    ...targets.map((target) =>
      element("option", { value: target }, [targetLabels[target] ?? target]),
    ),
  );
  aiTargetAll.value = targets.includes(current) ? current : (targets[0] ?? "");
  aiTargetAll.closest(".inline-field").hidden = targets.length === 0;
}

function renderAiArtifacts() {
  const selectedIds = new Set(
    [...form.querySelectorAll('[name="aiArtifact"]:checked')].map(({ value }) => value),
  );
  const targets = new Map(
    [...form.querySelectorAll("[data-ai-target]")].map((select) => [
      select.dataset.aiTarget,
      select.value,
    ]),
  );
  renderAiTargetAll();
  aiArtifacts.replaceChildren();
  artifactTabs.replaceChildren();

  const groups = groupedByCatalogGroup(visibleAiArtifacts());

  for (const [group, items] of groups) {
    const slug = group.toLowerCase().replace(/[^a-z0-9]+/g, "-");
    artifactTabs.append(
      element(
        "button",
        {
          type: "button",
          class: "tab",
          role: "tab",
          id: `artifact-tab-${slug}`,
          "aria-controls": `artifact-panel-${slug}`,
          "data-group": group,
        },
        [`${group} (${items.length})`],
      ),
    );
    aiArtifacts.append(
      element(
        "div",
        {
          role: "tabpanel",
          id: `artifact-panel-${slug}`,
          "aria-labelledby": `artifact-tab-${slug}`,
          "data-group": group,
        },
        [element("ul", { class: "rows rows-grid" }, items.map(artifactRow))],
      ),
    );
  }

  for (const checkbox of form.querySelectorAll('[name="aiArtifact"]')) {
    checkbox.checked = selectedIds.has(checkbox.value);
  }
  for (const select of form.querySelectorAll("[data-ai-target]")) {
    const target = targets.get(select.dataset.aiTarget);
    if (target) select.value = target;
  }

  const [firstGroup] = groups.keys();
  selectArtifactGroup(groups.has(selectedArtifactGroup) ? selectedArtifactGroup : firstGroup);
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

/**
 * Sets the target of every selected artifact that installs through a target adapter.
 *
 * @param {string} target
 */
function applyTargetToSelectedArtifacts(target) {
  for (const checkbox of form.querySelectorAll('[name="aiArtifact"]:checked')) {
    const select = form.querySelector(`[data-ai-target="${checkbox.value}"]`);
    if (select && artifactTargets(checkbox.value).includes(target)) {
      select.value = target;
      targetOverrides.delete(checkbox.value);
    }
  }
}

function syncIntegrationOptions() {
  const enabled = Boolean(
    form.querySelector('[name="integration"][value="stylelint-baseline"]:checked'),
  );
  baselineOptions.hidden = !enabled;
  repositoryControlsOptions.hidden = !form.querySelector(
    '[name="integration"][value="github-repository-controls"]:checked',
  );
}

function selectedAiArtifacts() {
  return [...form.querySelectorAll('[name="aiArtifact"]:checked')].map((checkbox) => {
    const targetInput = form.querySelector(`[data-ai-target="${checkbox.value}"]`);
    return targetInput ? { id: checkbox.value, target: targetInput.value } : { id: checkbox.value };
  });
}

function recipe() {
  const data = new FormData(form);

  return composerRecipe({
    profile: String(data.get("profile") ?? ""),
    packageManager: data.get("packageManager") ? String(data.get("packageManager")) : undefined,
    integrations: integrationOrder.filter((id) => data.getAll("integration").includes(id)),
    aiArtifacts: selectedAiArtifacts(),
    baseline: {
      available: data.get("baselineAvailable"),
      severity: data.get("baselineSeverity"),
    },
    repositoryControls: {
      repository: data.get("repositoryControlsRepository"),
      requiredChecks: commaSeparatedValues(data.get("repositoryControlsRequiredChecks")),
    },
  });
}

/**
 * @param {{ label: string, command: string }} step
 * @param {string} copyLabel
 */
function commandStep({ label, command }, copyLabel) {
  return [
    element("span", { class: "hint" }, [label]),
    element("div", { class: "command" }, [
      element("code", {}, [command]),
      element("button", { type: "button", "data-copy": true, "aria-label": copyLabel }, ["Copy"]),
    ]),
  ];
}

function renderNextCommands() {
  const steps = composerNextCommands(selectedPackageManager());
  const step = (id) => steps.find((candidate) => candidate.id === id);

  nextCommands.replaceChildren(
    element(
      "li",
      { class: "command-step" },
      commandStep(step("applyDryRun"), "Copy the dry run command"),
    ),
    element(
      "li",
      { class: "command-step" },
      commandStep(step("applyRecipe"), "Copy the apply command"),
    ),
  );
  optionalCommand.replaceChildren(
    ...commandStep(step("agentBootstrap"), "Copy the agent bootstrap command"),
  );
}

/**
 * @param {number} count
 * @param {string} noun
 */
function counted(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function renderRecipeSummary() {
  const data = new FormData(form);
  const profile = String(data.get("profile") ?? "");
  recipeSummary.replaceChildren(
    ...[
      `${profile.charAt(0).toUpperCase()}${profile.slice(1)} profile`,
      selectedPackageManager() ?? "npm",
      counted(data.getAll("integration").length, "integration"),
      counted(data.getAll("aiArtifact").length, "artifact"),
    ].map((text) => element("li", { class: "chip chip-summary" }, [text])),
  );
}

function render() {
  try {
    output.textContent = JSON.stringify(recipe(), null, 2);
  } catch (error) {
    output.textContent = error instanceof Error ? error.message : String(error);
  }
  renderRecipeSummary();
  renderNextCommands();
}

function setDefaults() {
  renderIntegrations();
  const profile = selectedProfile();
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
  const recipeContents = assertPublishedCliCompatibility(
    recipeInput === undefined ? recipe() : recipeInput,
    cliCompatibility.version,
  );
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
      execute: async () => {
        const response = listProfilesResponse({ browser: true });
        const supportedIds = new Set(
          filterIntegrationsForCli(listIntegrationOptions(), cliCompatibility.version).map(
            ({ id }) => id,
          ),
        );

        return {
          ...response,
          profiles: response.profiles.map((profile) => ({
            ...profile,
            defaultIntegrations: profile.defaultIntegrations.filter((id) => supportedIds.has(id)),
          })),
        };
      },
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
      execute: async (input) => {
        const response = listIntegrationsResponse(input);
        return integrationResponseForCli(response, cliCompatibility.version);
      },
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
      execute: async (input) => {
        const integration = describeIntegrationResponse(input.id);
        const [supportedIntegration] = filterIntegrationsForCli(
          [integration],
          cliCompatibility.version,
        );
        if (!supportedIntegration) {
          throw new Error(
            `${integration.id} is not available in the published Calavera CLI v${cliCompatibility.version}.`,
          );
        }
        return supportedIntegration;
      },
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
      execute: async () =>
        artifactResponseForCli(
          listAiArtifactsResponse(recipe().ai ?? []),
          cliCompatibility.version,
        ),
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
              "github-repository-controls": {
                type: "object",
                additionalProperties: false,
                required: ["repository"],
                properties: {
                  repository: {
                    type: "string",
                    pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$",
                  },
                  requiredChecks: {
                    type: "array",
                    items: { type: "string" },
                  },
                  defaultBranch: { type: "string" },
                  mergeMethods: {
                    type: "array",
                    items: { type: "string", enum: ["merge", "squash", "rebase"] },
                  },
                  wiki: { type: "boolean" },
                  projects: { type: "boolean" },
                  autoMerge: { type: "boolean" },
                  deleteBranchOnMerge: { type: "boolean" },
                  updateBranch: { type: "boolean" },
                  dependabotEcosystems: {
                    type: "array",
                    items: { type: "string", enum: ["npm", "github-actions"] },
                  },
                  codeqlLanguages: {
                    type: "array",
                    items: {
                      type: "string",
                      enum: [
                        "actions",
                        "c-cpp",
                        "csharp",
                        "go",
                        "java-kotlin",
                        "javascript-typescript",
                        "python",
                        "ruby",
                        "swift",
                      ],
                    },
                  },
                  codeqlQuerySuite: { type: "string", enum: ["default", "extended"] },
                  releaseEnvironment: releaseEnvironmentInputSchema,
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
      execute: async (input) => {
        const response = composeRecipeResponse(input, { browser: true });
        assertPublishedCliCompatibility(response.recipe, cliCompatibility.version);
        return response;
      },
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
      execute: async (input) => {
        const validation = validateRecipeResponse(input.recipe);
        if (!validation.ok) return validation;

        try {
          return {
            ok: true,
            recipe: assertPublishedCliCompatibility(input.recipe, cliCompatibility.version),
          };
        } catch (error) {
          return {
            ok: false,
            errors: [error instanceof Error ? error.message : String(error)],
          };
        }
      },
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
      execute: async (input) =>
        explainRecipeResponse(
          assertPublishedCliCompatibility(input.recipe, cliCompatibility.version),
        ),
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
    return;
  }
  if (event.target === aiTargetAll) {
    applyTargetToSelectedArtifacts(aiTargetAll.value);
  } else if (event.target.dataset.aiTarget) {
    targetOverrides.add(event.target.dataset.aiTarget);
  } else if (
    event.target.name === "aiArtifact" &&
    event.target.checked &&
    !targetOverrides.has(event.target.value)
  ) {
    const select = form.querySelector(`[data-ai-target="${event.target.value}"]`);
    if (select && artifactTargets(event.target.value).includes(aiTargetAll.value)) {
      select.value = aiTargetAll.value;
    }
  }
  syncAiTargetStates();
  syncIntegrationOptions();
  render();
});

artifactTabs.addEventListener("click", (event) => {
  const tab = event.target.closest('[role="tab"]');
  if (tab) selectArtifactGroup(tab.dataset.group);
});

artifactTabs.addEventListener("keydown", (event) => {
  const tabs = [...artifactTabs.querySelectorAll('[role="tab"]')];
  const currentIndex = tabs.indexOf(event.target);
  if (currentIndex === -1) return;

  const nextIndex = {
    ArrowLeft: (currentIndex - 1 + tabs.length) % tabs.length,
    ArrowRight: (currentIndex + 1) % tabs.length,
    Home: 0,
    End: tabs.length - 1,
  }[event.key];
  if (nextIndex === undefined) return;

  event.preventDefault();
  selectArtifactGroup(tabs[nextIndex].dataset.group);
  tabs[nextIndex].focus();
});

document.addEventListener("click", (event) => {
  const button = event.target.closest("[data-copy]");
  if (!button) return;

  // navigator.clipboard is undefined outside secure contexts.
  if (!navigator.clipboard?.writeText) {
    console.info("Copying the command failed: the Clipboard API is not available.");
    return;
  }

  const command = button.closest(".command").querySelector("code").textContent;
  navigator.clipboard.writeText(command).then(
    () => {
      button.textContent = "Copied";
      setTimeout(() => {
        button.textContent = "Copy";
      }, 1500);
    },
    (error) => {
      console.info("Copying the command failed.", error);
    },
  );
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

loadPublishedCliCompatibility().then((compatibility) => {
  const selectedIds = new FormData(form).getAll("integration").map(String);
  cliCompatibility = compatibility;
  renderIntegrations();
  renderAiArtifacts();
  const supportedIds = supportedIntegrationIds();
  selectIntegrations(selectedIds.filter((id) => supportedIds.has(id)));
  syncAiTargetStates();
  syncIntegrationOptions();
  render();
});
