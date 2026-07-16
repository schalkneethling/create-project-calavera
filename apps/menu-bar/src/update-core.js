export const POLL_INTERVAL = 6 * 60 * 60 * 1000;

export function updateCommand(id, tag = "latest") {
  return `create-project-calavera artifacts update ${id} --tag ${tag}`;
}

export async function inspectUpdates(project, snapshot, fetcher = fetch) {
  const updates = [];
  for (const artifact of snapshot.lock?.artifacts ?? []) {
    const metadata = await registryMetadata(artifact.package, fetcher);
    const version = metadata["dist-tags"]?.[project.tag ?? artifact.tag ?? "latest"];
    if (version && version !== artifact.version) {
      updates.push({
        key: `${project.path}:${artifact.id}:${version}`,
        kind: "artifact",
        id: artifact.id,
        current: artifact.version,
        available: version,
        command: updateCommand(artifact.id, project.tag),
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
  const release = releases.find(
    ({ draft, prerelease, tag_name: tag }) =>
      !draft && !prerelease && tag?.startsWith("menu-bar-v"),
  );
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
