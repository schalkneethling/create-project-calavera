// @ts-check
import { isPlainObject } from "./utils/guards.js";

/**
 * One artifact as `artifacts status` and `artifacts doctor` report it.
 *
 * @typedef {object} ArtifactStatusEntry
 * @property {string} id
 * @property {string | null} version The locked version, or null when the recipe selects the artifact but the lock has no entry.
 * @property {"latest" | "next"} tag
 * @property {boolean} installed
 * @property {boolean} managed
 * @property {boolean} locallyEdited
 * @property {string | null} latestVersion
 * @property {boolean} updateAvailable
 * @property {string | null} releaseNotesUrl
 * @property {string | null} updateCommand
 * @property {string | null} installCommand
 *
 * @typedef {{ artifacts: ArtifactStatusEntry[], offline: boolean, updateAllCommand: string | null, checkUpdatesCommand: string | null }} ArtifactStatusReport
 * @typedef {{ level: "info" | "success", message: string }} ReportLine
 */

// A GitHub owner or repository name; "." and ".." are refused separately.
const GITHUB_NAME = /^[\w.-]+$/;

/**
 * The GitHub owner and repository that npm `repository` metadata names, or undefined when it names
 * none. Accepts the forms npm accepts: a `{ url }` object, a URL (`git+https:`, `git+ssh:`,
 * `https:`), the `git@github.com:` form, `github:owner/repo`, and the `owner/repo` shorthand,
 * which npm reads as GitHub.
 *
 * @param {unknown} url
 * @returns {{ owner: string, name: string } | undefined}
 */
function githubRepository(url) {
  if (typeof url !== "string") return undefined;
  let path;
  if (url.startsWith("github:")) {
    path = url.slice("github:".length);
  } else if (url.startsWith("git@github.com:")) {
    path = url.slice("git@github.com:".length);
  } else if (/^[^:/]+\/[^:/]+$/.test(url)) {
    path = url;
  } else {
    try {
      const parsed = new URL(url.replace(/^git\+/, ""));
      if (parsed.hostname !== "github.com") return undefined;
      path = parsed.pathname.replace(/^\//, "");
    } catch {
      return undefined;
    }
  }
  const [owner, repository, ...rest] = path.replace(/\/$/, "").split("/");
  const name = repository?.replace(/\.git$/, "");
  if (rest.length > 0 || !owner || !name) return undefined;
  for (const part of [owner, name]) {
    if (!GITHUB_NAME.test(part) || part === "." || part === "..") return undefined;
  }
  return { owner, name };
}

/**
 * The path segments of a `repository.directory`, or undefined when there is none or it would leave
 * the repository. Every artifact is one package of a monorepo, so a changelog at the repository
 * root would belong to another package.
 *
 * @param {unknown} directory
 * @returns {string[] | undefined}
 */
function repositoryDirectory(directory) {
  if (typeof directory !== "string" || directory.startsWith("/") || directory.includes("\\")) {
    return undefined;
  }
  const segments = directory.split("/").filter((segment) => segment !== "" && segment !== ".");
  return segments.length === 0 || segments.includes("..") ? undefined : segments;
}

/**
 * The GitHub anchor of a changelog heading that is exactly `version`, as Changesets writes it
 * (`## 0.3.0`). GitHub lowercases a heading and drops punctuation other than `-` and `_`, so
 * `0.3.0-next.1` becomes `030-next1`. A semver version has no spaces, which GitHub would turn
 * into `-`.
 *
 * @param {string} version
 */
function versionAnchor(version) {
  return version.toLowerCase().replace(/[^\w-]/g, "");
}

/**
 * The link to the release notes for `version`: the `CHANGELOG.md` in the package's directory on
 * the default branch of the GitHub repository its published `repository` metadata names, at that
 * version's heading. Missing metadata, a repository outside GitHub, or a missing directory, or one
 * that leaves the repository, gives null, because Calavera never guesses a link.
 *
 * @param {unknown} repository The `repository` member of the published package manifest.
 * @param {string} version
 * @returns {string | null}
 */
export function artifactReleaseNotesUrl(repository, version) {
  const url = isPlainObject(repository) ? repository.url : repository;
  const github = githubRepository(url);
  const directory = repositoryDirectory(
    isPlainObject(repository) ? repository.directory : undefined,
  );
  if (!github || !directory) return null;
  const path = [...directory, "CHANGELOG.md"].map(encodeURIComponent).join("/");
  return `https://github.com/${github.owner}/${github.name}/blob/HEAD/${path}#${versionAnchor(version)}`;
}

/**
 * The words after an artifact's version that name a problem `artifacts doctor` checks for.
 *
 * @param {ArtifactStatusEntry} artifact
 */
function healthNotes(artifact) {
  return [
    ...(artifact.installed ? [] : ["files missing"]),
    ...(artifact.managed ? [] : ["not managed by Calavera"]),
    ...(artifact.locallyEdited ? ["locally edited"] : []),
  ];
}

/**
 * The lines ordinary output prints for `artifacts status` and `artifacts doctor`. Every link and
 * command comes from the result, so the lines carry the same update information as `--json`.
 *
 * @param {ArtifactStatusReport} result
 * @returns {ReportLine[]}
 */
export function formatArtifactStatus(result) {
  /** @type {ReportLine[]} */
  const lines = [];
  /** @param {string} message */
  const info = (message) => lines.push({ level: "info", message });

  if (result.artifacts.length === 0) {
    info("The recipe selects no artifacts, and the artifact lock holds none.");
    return lines;
  }

  for (const artifact of result.artifacts) {
    if (artifact.version === null) {
      const latest = result.offline ? "" : `, latest ${artifact.latestVersion}`;
      info(`${artifact.id}  not installed${latest} (${artifact.tag})`);
      info(`  Install: ${artifact.installCommand}`);
      continue;
    }

    const notes = healthNotes(artifact);
    const health = notes.length > 0 ? `, ${notes.join(", ")}` : "";
    if (artifact.updateAvailable) {
      info(
        `${artifact.id}  ${artifact.version} → ${artifact.latestVersion} (${artifact.tag})${health}`,
      );
      info(
        `  Release notes: ${artifact.releaseNotesUrl ?? "none, because the package metadata names no GitHub repository and package directory to link to"}`,
      );
      info(
        `  Update: ${artifact.updateCommand ?? "the recipe does not select this artifact, so artifacts update cannot update it"}`,
      );
    } else if (result.offline) {
      info(`${artifact.id}  ${artifact.version} (${artifact.tag})${health}`);
    } else {
      info(`${artifact.id}  ${artifact.version}, up to date (${artifact.tag})${health}`);
    }
  }

  if (result.offline) {
    info(
      `Update checks are off, so Calavera did not contact the registry. To check for updates, run: ${result.checkUpdatesCommand}`,
    );
    return lines;
  }

  const updates = result.artifacts.filter(({ updateAvailable }) => updateAvailable);
  if (result.updateAllCommand) {
    info(`Update every artifact: ${result.updateAllCommand}`);
  } else if (result.artifacts.filter(({ updateCommand }) => updateCommand !== null).length > 1) {
    // Status withholds `--all` from several updatable artifacts when a selection is not installed
    // or the channels differ.
    info(
      result.artifacts.some(({ version }) => version === null)
        ? "--all would also install the artifacts that are not installed, so run each Update command above instead."
        : "These artifacts follow different channels, and --all would move every one to a single channel, so run each Update command above instead.",
    );
  }
  if (updates.length === 0 && result.artifacts.every(({ version }) => version !== null)) {
    lines.push({ level: "success", message: "Every artifact is up to date on its channel." });
  }
  return lines;
}
