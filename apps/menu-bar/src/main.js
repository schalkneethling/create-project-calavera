import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
import {
  isPermissionGranted,
  requestPermission,
  sendNotification,
} from "@tauri-apps/plugin-notification";
import { inspectAppUpdate, inspectUpdates, POLL_INTERVAL, unseenUpdates } from "./update-core.js";

const STORAGE_KEY = "calavera-menu-bar-v1";
const form = document.querySelector("#register");
const projectsElement = document.querySelector("#projects");
const statusElement = document.querySelector("#status");
let settings = loadSettings();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const data = new FormData(form);
  const project = {
    path: String(data.get("path")).trim(),
    cliVersion: String(data.get("cliVersion")).trim(),
    tag: String(data.get("tag")),
  };
  await invoke("inspect_project", { path: project.path });
  settings.projects = [...settings.projects.filter(({ path }) => path !== project.path), project];
  saveSettings();
  form.reset();
  await checkAll();
});

document.querySelector("#check").addEventListener("click", checkAll);

async function checkAll() {
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
    summary.textContent = result.error ?? `${result.updates.length} update(s)`;
    article.append(heading, summary);
    for (const update of result.updates) {
      const button = document.createElement("button");
      button.textContent = `${update.id}: ${update.current} → ${update.available}`;
      button.addEventListener("click", async () => {
        await navigator.clipboard.writeText(update.command);
        await invoke("open_terminal", { path: result.project.path });
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
      ...JSON.parse(localStorage.getItem(STORAGE_KEY)),
    };
  } catch {
    return { projects: [], notificationHistory: [] };
  }
}

function saveSettings() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
}

render();
checkAll();
setInterval(checkAll, POLL_INTERVAL);
