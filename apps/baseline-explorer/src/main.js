import {
  baselineConfiguration,
  baselineMetadata,
  describeBaselineTarget,
  listBaselineTargets,
  recommendBaselineTarget,
  searchBaselineFeatures,
} from "@schalkneethling/calavera-baseline-core";

import "./styles.css";
import { tabFocusIndex } from "./tabs.js";

const browserLabels = {
  chrome: "Chrome",
  chrome_android: "Chrome Android",
  edge: "Edge",
  firefox: "Firefox",
  firefox_android: "Firefox Android",
  safari: "Safari",
  safari_ios: "Safari iOS",
};
const featuredIds = ["nesting", "container-queries", "has", "subgrid", "view-transitions", "oklab"];
const params = new URLSearchParams(location.search);
const state = {
  mode: params.get("features") ? "features" : "target",
  target: params.get("target") ?? "widely",
  featureIds: new Set((params.get("features") ?? "").split(",").filter(Boolean)),
  output: "calavera",
};

const elements = Object.fromEntries(
  [
    "feature-count",
    "dataset-version",
    "dataset-date",
    "target-controls",
    "feature-controls",
    "target",
    "target-note",
    "feature-search",
    "feature-results",
    "selected-features",
    "result-title",
    "result-status",
    "result-description",
    "browser-runway",
    "result-details",
    "output-section",
  ].map((id) => [id, document.getElementById(id)]),
);
const outputTabs = [...document.querySelectorAll('[role="tab"][data-output]')];
const outputPanels = [...document.querySelectorAll('[role="tabpanel"][data-output-panel]')];
const generatedOutputs = Object.fromEntries(
  [...document.querySelectorAll("[data-generated-output]")].map((element) => [
    element.dataset.generatedOutput,
    element,
  ]),
);

function targetLabel(target) {
  if (target === "widely") return "Widely available";
  if (target === "newly") return "Newly available";
  return `Baseline ${target}`;
}

function writeUrl() {
  const next = new URL(location.href);
  next.search = "";
  if (state.mode === "target") {
    next.searchParams.set("target", state.target);
  } else if (state.featureIds.size > 0) {
    next.searchParams.set("features", [...state.featureIds].sort().join(","));
  }
  history.replaceState(null, "", next);
}

function renderBrowsers(versions) {
  elements["browser-runway"].replaceChildren();
  for (const [browser, details] of Object.entries(versions ?? {})) {
    const item = document.createElement("div");
    item.className = "browser-marker";
    item.innerHTML = `<span>${browserLabels[browser] ?? browser}</span><strong>${details.version}</strong>`;
    elements["browser-runway"].append(item);
  }
}

function renderOutput(target) {
  const output = baselineConfiguration(target);
  const values = {
    calavera: output.calaveraRecipe,
    rule: output.stylelintRule,
    config: output.stylelintConfig,
  };
  for (const [format, value] of Object.entries(values)) {
    generatedOutputs[format].textContent = JSON.stringify(value, null, 2);
  }
  selectOutput(state.output);
  elements["output-section"].hidden = false;
}

function selectOutput(output) {
  state.output = output;
  for (const tab of outputTabs) {
    const selected = tab.dataset.output === output;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
  }
  for (const panel of outputPanels) {
    panel.hidden = panel.dataset.outputPanel !== output;
  }
}

function renderTarget() {
  const result = describeBaselineTarget(state.target);
  elements["result-title"].textContent = targetLabel(result.target);
  elements["result-status"].textContent = result.fixed ? "Fixed target" : "Moving target";
  elements["result-status"].dataset.kind = result.fixed ? "fixed" : "moving";
  elements["result-description"].textContent = result.description;
  elements["target-note"].textContent = result.evolving
    ? "This target evolves as browser and feature data changes."
    : "This target remains stable over time.";
  renderBrowsers(result.browserVersions);
  elements["result-details"].innerHTML =
    `<p><strong>${result.featureCount}</strong> CSS-focused WebDX features are inside this line.</p>`;
  renderOutput(result.target);
}

function renderRecommendation() {
  if (state.featureIds.size === 0) {
    elements["result-title"].textContent = "Select features to begin";
    elements["result-status"].textContent = "No target yet";
    elements["result-description"].textContent =
      "Choose the CSS capabilities your project needs. The latest-arriving feature sets the earliest fixed target.";
    elements["browser-runway"].replaceChildren();
    elements["result-details"].replaceChildren();
    elements["output-section"].hidden = true;
    return;
  }

  const recommendation = recommendBaselineTarget([...state.featureIds]);
  if (recommendation.recommendedTarget === null) {
    elements["result-title"].textContent = "No complete Baseline target";
    elements["result-status"].textContent = "Limited availability";
    elements["result-status"].dataset.kind = "limited";
    elements["result-description"].textContent =
      "At least one selected feature is not interoperable across the Baseline core browser set yet.";
    renderBrowsers(null);
    elements["result-details"].innerHTML =
      `<p>Blocking features: <strong>${recommendation.limitedFeatures.map(({ name }) => name).join(", ")}</strong></p>`;
    elements["output-section"].hidden = true;
    return;
  }

  elements["result-title"].textContent = `Baseline ${recommendation.recommendedTarget}`;
  elements["result-status"].textContent = recommendation.compatibleWithWidely
    ? "Also widely available"
    : "Fixed target";
  elements["result-status"].dataset.kind = "fixed";
  elements["result-description"].textContent =
    "This is the earliest fixed Baseline year that includes every selected feature.";
  renderBrowsers(recommendation.browserVersions);
  elements["result-details"].innerHTML =
    `<p>The compatibility line is set by <strong>${recommendation.limitingFeatures.map(({ name }) => name).join(", ")}</strong>.</p>`;
  renderOutput(recommendation.recommendedTarget);
}

function featureResult(feature) {
  const label = document.createElement("label");
  label.className = "feature-option";
  const checked = state.featureIds.has(feature.id);
  label.innerHTML = `
    <input type="checkbox" value="${feature.id}" ${checked ? "checked" : ""} />
    <span><strong>${feature.name}</strong><small>${feature.availability}</small></span>
  `;
  label.querySelector("input").addEventListener("change", ({ currentTarget }) => {
    if (currentTarget.checked) state.featureIds.add(feature.id);
    else state.featureIds.delete(feature.id);
    renderSelectedFeatures();
    renderRecommendation();
    writeUrl();
  });
  return label;
}

function renderFeatureResults() {
  const query = elements["feature-search"].value.trim();
  const results = query
    ? searchBaselineFeatures(query, { limit: 40 })
    : searchBaselineFeatures("", { limit: baselineMetadata.featureCount })
        .filter(({ id }) => featuredIds.includes(id))
        .sort((left, right) => featuredIds.indexOf(left.id) - featuredIds.indexOf(right.id));
  elements["feature-results"].replaceChildren(...results.map(featureResult));
}

function renderSelectedFeatures() {
  const selected = searchBaselineFeatures("", { limit: baselineMetadata.featureCount }).filter(
    ({ id }) => state.featureIds.has(id),
  );
  elements["selected-features"].replaceChildren();
  for (const feature of selected) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = `${feature.name} ×`;
    button.addEventListener("click", () => {
      state.featureIds.delete(feature.id);
      renderSelectedFeatures();
      renderFeatureResults();
      renderRecommendation();
      writeUrl();
    });
    elements["selected-features"].append(button);
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const button of document.querySelectorAll("[data-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.mode === mode));
  }
  elements["target-controls"].hidden = mode !== "target";
  elements["feature-controls"].hidden = mode !== "features";
  if (mode === "target") renderTarget();
  else renderRecommendation();
  writeUrl();
}

elements["feature-count"].textContent = baselineMetadata.featureCount.toLocaleString();
elements["dataset-version"].textContent = `web-features ${baselineMetadata.sources.webFeatures}`;
elements["dataset-date"].textContent = new Date(baselineMetadata.generatedAt).toLocaleDateString(
  undefined,
  { year: "numeric", month: "short", day: "numeric" },
);

for (const target of listBaselineTargets()) {
  const option = document.createElement("option");
  option.value = target.target;
  option.textContent = targetLabel(target.target);
  option.selected = String(target.target) === state.target;
  elements.target.append(option);
}

if (!elements.target.value) {
  state.target = "widely";
  elements.target.value = state.target;
}

elements.target.addEventListener("change", ({ currentTarget }) => {
  state.target = currentTarget.value;
  renderTarget();
  writeUrl();
});
elements["feature-search"].addEventListener("input", renderFeatureResults);
for (const button of document.querySelectorAll("[data-mode]")) {
  button.addEventListener("click", () => setMode(button.dataset.mode));
}
for (const [index, button] of outputTabs.entries()) {
  button.addEventListener("click", () => {
    selectOutput(button.dataset.output);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectOutput(button.dataset.output);
      return;
    }
    const nextIndex = tabFocusIndex(index, event.key, outputTabs.length);
    if (nextIndex === null) return;
    event.preventDefault();
    for (const outputTab of outputTabs) outputTab.tabIndex = -1;
    outputTabs[nextIndex].tabIndex = 0;
    outputTabs[nextIndex].focus();
  });
}
for (const button of document.querySelectorAll("[data-copy-output]")) {
  button.addEventListener("click", async () => {
    await navigator.clipboard.writeText(generatedOutputs[button.dataset.copyOutput].textContent);
    button.textContent = "Copied";
    setTimeout(() => (button.textContent = "Copy"), 1500);
  });
}

renderSelectedFeatures();
renderFeatureResults();
setMode(state.mode);
