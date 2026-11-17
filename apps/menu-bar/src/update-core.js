import {
  artifactUpdateCommand,
  CONFIG_FILE,
} from "../../../packages/cli/src/project-local-commands.js";

export const POLL_INTERVAL = 6 * 60 * 60 * 1000;

// The recipe path of a registered project; projects registered before #995 have none saved.
export function recipePath(project) {
  return project.config || CONFIG_FILE;
}

export function snapshotDiagnostics(snapshot, config = CONFIG_FILE) {
  const diagnostics = [];
  const components = [
    ["recipe", `recipe (${config})`, isRecipe],
    ["lock", "artifact lock (.calavera/artifacts.lock.json)", isArtifactLock],
    ["state", "managed state (.calavera/state.json)", isManagedState],
  ];
  for (const [key, label, validator] of components) {
    if (key === "recipe" && snapshot.recipeError) {
      diagnostics.push(`Unreadable ${label}: ${snapshot.recipeError}`);
    } else if (snapshot[key] == null) diagnostics.push(`Missing ${label}`);
    else if (!validator(snapshot[key])) diagnostics.push(`Incompatible ${label}`);
  }
  return diagnostics;
}

export async function inspectUpdates(project, snapshot, fetcher = fetch) {
  const updates = [];
  for (const artifact of snapshot.lock?.artifacts ?? []) {
    const metadata = await registryMetadata(artifact.package, fetcher);
    const tag = project.tag ?? artifact.tag ?? "latest";
    const version = metadata["dist-tags"]?.[tag];
    if (version && version !== artifact.version) {
      updates.push({
        key: `${project.path}:${artifact.id}:${version}`,
        kind: "artifact",
        id: artifact.id,
        current: artifact.version,
        available: version,
        // The command `artifacts status --json` reports as `updateCommand` while the registered
        // channel matches the lock's channel (#995). Without a usable recipe, the app offers none;
        // status reports none for a missing recipe and fails on an unreadable one.
        command: isRecipe(snapshot.recipe)
          ? artifactUpdateCommand(snapshot.recipe, recipePath(project), artifact.id, tag)
          : null,
      });
    }
  }

  if (project.cliVersion) {
    const metadata = await registryMetadata("create-project-calavera", fetcher);
    const version = metadata["dist-tags"]?.latest;
    if (version && version !== project.cliVersion) {
      updates.push({
        key: `${project.path}:cli:${version}`,
        kind: "cli",
        id: "create-project-calavera",
        current: project.cliVersion,
        available: version,
        command: "npm install --global create-project-calavera@latest",
      });
    }
  }
  return updates;
}

export async function inspectAppUpdate(currentVersion, fetcher = fetch) {
  const response = await fetcher(
    "https://api.github.com/repos/schalkneethling/create-project-calavera/releases?per_page=20",
  );
  if (!response.ok) throw new Error("GitHub release request failed.");
  const releases = await response.json();
  const release = releases
    .filter(
      ({ draft, prerelease, tag_name: tag }) =>
        !draft && !prerelease && /^menu-bar-v\d+\.\d+\.\d+$/.test(tag ?? ""),
    )
    .sort((left, right) =>
      compareVersions(
        right.tag_name.slice("menu-bar-v".length),
        left.tag_name.slice("menu-bar-v".length),
      ),
    )[0];
  const available = release?.tag_name.slice("menu-bar-v".length);
  if (!available || compareVersions(available, currentVersion) <= 0) return null;
  return {
    key: `app:${available}`,
    kind: "app",
    id: "Calavera menu-bar",
    current: currentVersion,
    available,
    url: release.html_url,
  };
}

export function unseenUpdates(updates, history) {
  const seen = new Set(history);
  return updates.filter(({ key }) => !seen.has(key));
}

async function registryMetadata(packageName, fetcher) {
  const response = await fetcher(`https://registry.npmjs.org/${encodeURIComponent(packageName)}`);
  if (!response.ok) throw new Error(`Registry request failed for ${packageName}.`);
  return response.json();
}

function compareVersions(left, right) {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (leftParts[index] ?? 0) - (rightParts[index] ?? 0);
    if (difference) return difference;
  }
  return 0;
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isRecipe(value) {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.integrations) &&
    isRecord(value.scripts)
  );
}

function isArtifactLock(value) {
  return isRecord(value) && value.schemaVersion === 1 && Array.isArray(value.artifacts);
}

function isManagedState(value) {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.managedFiles) &&
    Array.isArray(value.aiArtifacts)
  );
}
