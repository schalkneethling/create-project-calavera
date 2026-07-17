import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import {
  inspectAppUpdate,
  inspectUpdates,
  POLL_INTERVAL,
  snapshotDiagnostics,
  unseenUpdates,
} from "./update-core.js";

const STORAGE_KEY = "calavera-menu-bar-v1";
const form = document.querySelector("#register");
const terminalSettingsForm = document.querySelector("#terminal-settings");
const projectsElement = document.querySelector("#projects");
const statusElement = document.querySelector("#status");
let settings = loadSettings();
let checkAllPromise;

terminalSettingsForm.elements.application.value = settings.terminalApplication;

terminalSettingsForm.addEventListener("submit", (event) => {
  event.preventDefault();
  const data = new FormData(terminalSettingsForm);
  settings.terminalApplication = String(data.get("application")).trim();
  saveSettings();
  statusElement.textContent = settings.terminalApplication
    ? `Preferred terminal saved: ${settings.terminalApplication}`
    : "Terminal preference cleared. Update commands will only be copied.";
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const project = {
    path: String(data.get("path")).trim(),
    cliVersion: String(data.get("cliVersion")).trim(),
    tag: String(data.get("tag")),
  };
  try {
    await invoke("inspect_project", { path: project.path });
  } catch (error) {
    statusElement.textContent = `Could not register project: ${String(error)}`;
    return;
  }
  settings.projects = [...settings.projects.filter(({ path }) => path !== project.path), project];
  saveSettings();
  form.reset();
  await checkAll();
});

document.querySelector("#check").addEventListener("click", checkAll);

function checkAll() {
  if (checkAllPromise) return checkAllPromise;
  checkAllPromise = performCheckAll().finally(() => {
    checkAllPromise = undefined;
  });
  return checkAllPromise;
}

async function performCheckAll() {
  statusElement.textContent = "Checking…";
  const results = [];
  let appUpdate;
  try {
    appUpdate = await inspectAppUpdate(await getVersion());
    if (appUpdate && unseenUpdates([appUpdate], settings.notificationHistory).length) {
      await notify(appUpdate);
      settings.notificationHistory.push(appUpdate.key);
    }
  } catch (error) {
    appUpdate = { error: String(error) };
  }
  for (const project of settings.projects) {
    try {
      const snapshot = await invoke("inspect_project", { path: project.path });
      const updates = await inspectUpdates(project, snapshot);
      const unseen = unseenUpdates(updates, settings.notificationHistory);
      for (const update of unseen) await notify(update, project.path);
      settings.notificationHistory.push(...unseen.map(({ key }) => key));
      results.push({ project, snapshot, updates });
    } catch (error) {
      results.push({ project, error: String(error), updates: [] });
    }
  }
  settings.lastChecked = new Date().toISOString();
  saveSettings();
  render(results, appUpdate);
  statusElement.textContent = `Checked ${settings.projects.length} project(s)`;
}

function render(
  results = settings.projects.map((project) => ({ project, updates: [] })),
  appUpdate,
) {
  projectsElement.replaceChildren();
  if (appUpdate) projectsElement.append(renderAppUpdate(appUpdate));
  for (const result of results) {
    const article = document.createElement("article");
    const heading = document.createElement("h2");
    heading.textContent = result.project.path;
    const summary = document.createElement("p");
    const diagnostics = result.snapshot ? snapshotDiagnostics(result.snapshot) : [];
    summary.textContent =
      result.error ??
      (diagnostics.length > 0 ? diagnostics.join("; ") : `${result.updates.length} update(s)`);
    article.append(heading, summary);
    for (const update of result.updates) {
      const button = document.createElement("button");
      button.textContent = `${update.id}: ${update.current} → ${update.available}`;
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(update.command);
        if (!settings.terminalApplication) {
          statusElement.textContent = `Command copied. Open your terminal in ${result.project.path}.`;
          return;
        }
        try {
          await invoke("open_terminal", {
            path: result.project.path,
            application: settings.terminalApplication,
          });
          statusElement.textContent = `Command copied. Opened ${settings.terminalApplication} at ${result.project.path}.`;
        } catch (error) {
          statusElement.textContent = `Command copied, but ${settings.terminalApplication} could not be opened: ${String(error)}`;
        }
      });
      article.append(button);
    }
    const remove = document.createElement("button");
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      settings.projects = settings.projects.filter(({ path }) => path !== result.project.path);
      saveSettings();
      render();
    });
    article.append(remove);
    projectsElement.append(article);
  }
}

function renderAppUpdate(update) {
  const article = document.createElement("article");
  if (update.error) {
    article.textContent = update.error;
    return article;
  }
  const button = document.createElement("button");
  button.textContent = `${update.id}: ${update.current} → ${update.available}`;
  button.addEventListener("click", () => invoke("open_url", { url: update.url }));
  article.append(button);
  return article;
}

async function notify(update, project = "this Mac") {
  const allowed = (await isPermissionGranted()) || (await requestPermission()) === "granted";
  if (!allowed) return;
  sendNotification({
    title: `Calavera update: ${update.id}`,
    body: `${update.current} → ${update.available} in ${project}`,
  });
}

function loadSettings() {
  try {
    return {
      projects: [],
      notificationHistory: [],
      terminalApplication: "",
      ...JSON.parse(localStorage.getItem(STORAGE_KEY)),
    };
  } catch {
    return { projects: [], notificationHistory: [], terminalApplication: "" };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

render();
checkAll();
setInterval(checkAll, POLL_INTERVAL);
