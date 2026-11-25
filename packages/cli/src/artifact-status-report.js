// @ts-check
import { temporaryFolderLeftoverLine } from "./utils/cleanup.js";
import { isPlainObject } from "./utils/guards.js";

/** @typedef {import("./utils/cleanup.js").TemporaryFolderLeftover} TemporaryFolderLeftover */

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
 * @property {string | null} installCommand The `artifacts install` command, for a selection without a lock entry, which it installs, and for a lock entry that the phase function classifies as not selected and `missing`, which it drops when it can also install the recipe's selections (#1111). Null otherwise.
 * @property {UpdateCheckFailure | null} updateCheckFailure Why `--check-updates` could not look up this artifact's channel, or null when the lookup succeeded or did not run (#993).
 * @property {{ name: string, reason: string }} condition The artifact's condition and its reason, from the phase function (ADR-0020, Decision 3). It decides the artifact's level in both doctors.
 * @property {boolean | null} selected False for a lock entry the recipe no longer selects, which the next `artifacts install`, or `artifacts update` while the recipe selects any artifact, removes (#992). Null when there is no recipe to compare the lock with.
 *
 * @typedef {object} UpdateCheckFailure
 * @property {string} code The registry error's code, such as ETARGET for a missing dist-tag. Calavera sets two codes itself (#1138): ELOOKUPTIMEOUT when the registry did not answer before the lookup's deadline, and ELOOKUPSKIPPED when Calavera did not send the lookup, because the same registry missed an earlier lookup's deadline in this report.
 * @property {string | null} type The kind of a FETCH_ERROR, such as request-timeout or invalid-json, as minipass-fetch names it.
 * @property {number | null} statusCode The registry's HTTP status, when it answered.
 * @property {string | null} origin The origin (protocol, host, and port) that answered an HTTP failure, or null for a failure without one, such as a DNS error or a missing tag (ADR-0021).
 * @property {string} reason
 * @property {string | null} remedy
 * @property {string[]} npmDiagnostics The npm configuration entries Calavera ignored, which may explain the failure. They never contain a value.
 * @property {string[]} unsetVariables The environment variables those entries name that are not set.
 *
 * @typedef {{ level: "info" | "warn" | "error", message: string }} PhaseLine
 * @typedef {{ path: string | null, kind: string | null, reason: string }} FormatterFailureFinding
 * @typedef {{ command: string, artifacts: ArtifactStatusEntry[], offline: boolean, updateAllCommand: string | null, checkUpdatesCommand: string | null, updateAllBlockedBy: string[], ok: boolean, phase: string, phaseLine: PhaseLine, phaseNotes: string[], formatterFailures: FormatterFailureFinding[], managedFilePlanProblem: string | null, cacheBlockProblem?: string | null, rollbackFiles?: string[] | null }} ArtifactStatusReport
 * @typedef {{ level: "info" | "success" | "warn" | "error", message: string }} ReportLine
 * @typedef {{ id: string, version: string, tag: "latest" | "next" }} RemovedLockEntry
 */

// #992: the recipe is the source of truth, so an install or update drops the lock entry of an
// artifact the recipe no longer selects. Neither removes that artifact's files. An update refuses
// to run while the recipe selects no artifact, so then only install drops the entry.
const NOT_SELECTED =
  "  Not selected: the recipe no longer selects this artifact, so the next artifacts install or artifacts update removes its lock entry and leaves its installed files in place.";
const NOTHING_SELECTED =
  "  Not selected: the recipe selects no artifacts, so the next artifacts install removes its lock entry and leaves its installed files in place.";

// #1111: the note for a leftover lock entry, which replaces the "Not selected" note above.
const LEFTOVER =
  "  Not selected, files missing: the recipe no longer selects this artifact, and some or all of its files were deleted, so its lock entry is a leftover. artifacts install removes the entry when it can also install what the recipe selects, and otherwise stops and names the problem:";

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
 * @param {Pick<ArtifactStatusEntry, "installed" | "managed" | "locallyEdited" | "condition">} artifact
 */
function healthNotes(artifact) {
  return [
    ...(artifact.condition.name === "unreadable" ? ["files cannot be read"] : []),
    ...(artifact.installed ? [] : ["files missing"]),
    ...(artifact.managed ? [] : ["not managed by Calavera"]),
    ...(artifact.locallyEdited ? ["locally edited"] : []),
  ];
}

/** The conditions that are a problem for a lock entry or a recorded selection. */
const PROBLEMS = new Set(["missing", "unreadable", "edited", "unrecorded"]);

/**
 * Whether an artifact is a lock entry the recipe no longer selects whose files were deleted,
 * edited, or are not recorded, or cannot be read. It is a leftover record, not a broken project,
 * so both commands print it as a warning (owner decision of 2026-11-21 on #994, #1111, and owner
 * decision 6 of ADR-0020). Only a leftover whose files were deleted carries the install command
 * that drops it (#1111).
 *
 * @param {Pick<ArtifactStatusEntry, "selected" | "condition">} artifact
 */
function isDeselectedProblem(artifact) {
  return artifact.selected === false && PROBLEMS.has(artifact.condition.name);
}

/**
 * Whether a selection without a lock entry is installed: its files are present and match what the
 * state records, so only its lock entry is missing (ADR-0020, Decision 3).
 *
 * @param {Pick<ArtifactStatusEntry, "version" | "installed" | "managed" | "condition">} artifact
 */
function isInstalledWithoutLockEntry(artifact) {
  return (
    artifact.version === null &&
    artifact.condition.name === "pending" &&
    artifact.installed &&
    artifact.managed
  );
}

/**
 * Whether `artifacts doctor` finds no problem with an artifact, read from its condition (ADR-0020,
 * Decision 4). The status result's `ok`, which sets doctor's exit status, and doctor's verdict line
 * both use it, so the two cannot disagree (#994). A selected artifact fails when its files are
 * missing, cannot be read, are edited, or are not recorded; one that is pending, such as a
 * selection that is not installed yet, passes with a note. A lock entry the recipe no longer
 * selects is a warning at most, and without a recipe an artifact has no level of its own, because
 * the phase line's error decides the verdict.
 *
 * @param {Pick<ArtifactStatusEntry, "selected" | "condition">} artifact
 */
export function isArtifactHealthy(artifact) {
  return artifact.selected !== true || !PROBLEMS.has(artifact.condition.name);
}

/**
 * The lines `artifacts status` and `artifacts doctor` print first (ADR-0020, Decision 4): the phase
 * line, the notes about the `ejected` marker, and the managed-file check's formatter failures and
 * plan problem, which artifacts doctor reports as errors and status as notes. During a pending
 * transaction, each file the rollback would replace or remove follows the phase line.
 *
 * @param {Pick<ArtifactStatusReport, "command" | "phase" | "phaseLine" | "phaseNotes" | "formatterFailures" | "managedFilePlanProblem" | "cacheBlockProblem" | "rollbackFiles">} result
 * @returns {ReportLine[]}
 */
export function formatPhaseReport(result) {
  /** @type {ReportLine[]} */
  const lines = [{ level: result.phaseLine.level, message: result.phaseLine.message }];
  for (const message of result.phaseNotes) lines.push({ level: "info", message });
  /** @type {ReportLine["level"]} */
  const checkLevel = result.command === "artifacts doctor" ? "error" : "info";
  for (const { reason } of result.formatterFailures) {
    lines.push({ level: checkLevel, message: reason });
  }
  if (result.managedFilePlanProblem !== null) {
    lines.push({ level: checkLevel, message: result.managedFilePlanProblem });
  }
  if (result.cacheBlockProblem) {
    lines.push({ level: checkLevel, message: result.cacheBlockProblem });
  }
  if (result.phase === "pending-transaction") {
    for (const path of result.rollbackFiles ?? []) {
      lines.push({ level: "info", message: `  The rollback restores or removes ${path}.` });
    }
  }
  return lines;
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

  // A pending transaction lists no artifacts; its phase report says what to do instead.
  if (result.phase === "pending-transaction") return lines;

  if (result.artifacts.length === 0) {
    info("The recipe selects no artifacts, and the artifact lock holds none.");
    return lines;
  }

  const notSelected = result.artifacts.some(({ selected }) => selected)
    ? NOT_SELECTED
    : NOTHING_SELECTED;
  /**
   * The note under a lock entry the recipe no longer selects. A leftover entry's note is a
   * warning, as its line is, so the two stay together on stderr (#1111).
   *
   * @param {ArtifactStatusEntry} artifact
   */
  const notSelectedNote = (artifact) => {
    if (artifact.installCommand !== null) {
      lines.push({ level: "warn", message: `${LEFTOVER} ${artifact.installCommand}` });
    } else if (artifact.selected === false) {
      // A deselected entry with a problem is a warning, so its note follows it to stderr.
      lines.push({ level: isDeselectedProblem(artifact) ? "warn" : "info", message: notSelected });
    }
  };
  /** @param {UpdateCheckFailure} failure */
  const failureLines = (failure) => {
    info(`  Cause: ${failure.reason}.`);
    if (failure.npmDiagnostics.length > 0) {
      info(
        `  Calavera ignored npm configuration that may explain this: ${failure.npmDiagnostics.join(" ")}`,
      );
    }
    if (failure.unsetVariables.length > 0) {
      info(
        `  Unset variables: ${failure.unsetVariables.join(", ")}. MCP clients often pass a minimal environment, so a variable set in your shell may be missing here.`,
      );
    }
    if (failure.remedy) info(`  ${failure.remedy}`);
  };
  for (const artifact of result.artifacts) {
    const failure = artifact.updateCheckFailure;
    // #1138: a lookup skipped after its registry missed an earlier lookup's deadline never ran.
    const outcome =
      failure?.code === "ELOOKUPSKIPPED" ? "update not checked" : "update check failed";
    if (artifact.version === null && PROBLEMS.has(artifact.condition.name)) {
      // A selection without a lock entry whose recorded files were deleted, edited, or cannot be
      // read fails artifacts doctor (ADR-0020, Decision 3), so its line names the change and its
      // reason, not an install that would stop on it.
      info(`${artifact.id}  no lock entry (${artifact.tag}), ${healthNotes(artifact).join(", ")}`);
      info(`  ${artifact.condition.reason}`);
      continue;
    }
    if (artifact.version === null) {
      // ADR-0020, Decision 3: a selection whose files are present and match the state is pending
      // only for its lock entry, so its line does not call an installed artifact missing.
      const present = isInstalledWithoutLockEntry(artifact);
      const state = present ? "installed, no lock entry" : "not installed";
      if (failure) {
        lines.push({
          level: "warn",
          message: `${artifact.id}  ${state}, ${outcome} (${artifact.tag})`,
        });
        failureLines(failure);
      } else {
        const latest = result.offline ? "" : `, latest ${artifact.latestVersion}`;
        info(`${artifact.id}  ${state}${latest} (${artifact.tag})`);
      }
      if (present) {
        info(`  ${artifact.condition.reason}`);
        info(`  Record it in the lock: ${artifact.installCommand}`);
      } else {
        info(`  Install: ${artifact.installCommand}`);
      }
      continue;
    }

    const notes = healthNotes(artifact);
    const health = notes.length > 0 ? `, ${notes.join(", ")}` : "";
    /** @type {ReportLine["level"]} */
    const level = isDeselectedProblem(artifact) ? "warn" : "info";
    if (failure) {
      lines.push({
        level: "warn",
        message: `${artifact.id}  ${artifact.version}, ${outcome} (${artifact.tag})${health}`,
      });
      notSelectedNote(artifact);
      failureLines(failure);
    } else if (artifact.updateAvailable) {
      lines.push({
        level,
        message: `${artifact.id}  ${artifact.version} → ${artifact.latestVersion} (${artifact.tag})${health}`,
      });
      notSelectedNote(artifact);
      info(
        `  Release notes: ${artifact.releaseNotesUrl ?? "none, because the package metadata names no GitHub repository and package directory to link to"}`,
      );
      info(
        `  Update: ${artifact.updateCommand ?? "the recipe does not select this artifact, so artifacts update cannot update it"}`,
      );
    } else {
      const current = result.offline ? "" : ", up to date";
      lines.push({
        level,
        message: `${artifact.id}  ${artifact.version}${current} (${artifact.tag})${health}`,
      });
      notSelectedNote(artifact);
    }
  }

  if (result.offline) {
    info(
      `Update checks are off, so Calavera did not contact the registry. To check for updates, run: ${result.checkUpdatesCommand}`,
    );
    return lines;
  }

  const updates = result.artifacts.filter(({ updateAvailable }) => updateAvailable);
  const updatable = result.artifacts.filter(({ updateCommand }) => updateCommand !== null);
  if (result.updateAllCommand) {
    info(`Update every artifact: ${result.updateAllCommand}`);
  } else if (result.updateAllBlockedBy.length > 0) {
    info(
      `No command updates every artifact, because the update check failed for ${result.updateAllBlockedBy.join(", ")}, so run each Update command above instead.`,
    );
  } else if (updatable.length > 1) {
    // With every check done, status withholds `--all` from several updatable artifacts only when
    // their channels differ.
    info(
      "These artifacts follow different channels, and --all would move every one to a single channel, so run each Update command above instead.",
    );
  }
  // #991: a targeted update leaves the selections without a lock entry alone, while `--all`
  // installs them.
  if (
    result.artifacts.some(({ updateCommand }) => updateCommand !== null) &&
    result.artifacts.some(({ version }) => version === null)
  ) {
    const all = result.updateAllCommand
      ? ", or update every artifact, which installs them on the channel its --tag names, or latest without --tag"
      : "";
    info(
      `A targeted update, artifacts update <id>, advances only the artifact it names and leaves the artifacts that are not installed yet as they are. To install them, run their Install command${all}.`,
    );
  }
  if (
    updates.length === 0 &&
    result.artifacts.every(
      ({ version, updateCheckFailure }) => version !== null && updateCheckFailure === null,
    )
  ) {
    lines.push({ level: "success", message: "Every artifact is up to date on its channel." });
  }
  return lines;
}

/**
 * The lines ordinary output prints last for `artifacts doctor` (#994): a note that names the
 * selections that are not installed yet, as `doctor` warns about a missing managed AI artifact,
 * and then the overall verdict. The verdict follows `ok`, which also sets the exit status, and
 * names each artifact with a problem and each other check that failed, so a person or an agent
 * can tell a healthy project from a broken one without reading every line.
 *
 * @param {Pick<ArtifactStatusReport, "ok" | "artifacts" | "phase" | "phaseLine" | "formatterFailures" | "managedFilePlanProblem" | "cacheBlockProblem">} result
 * @returns {ReportLine[]}
 */
export function artifactDoctorVerdict(result) {
  /** @type {ReportLine[]} */
  const lines = [];
  const notInstalled = result.artifacts.filter(
    (artifact) =>
      artifact.version === null &&
      artifact.condition.name === "pending" &&
      !isInstalledWithoutLockEntry(artifact),
  );
  const [one] = notInstalled;
  if (one) {
    const ids = notInstalled.map(({ id }) => id).join(", ");
    const several = notInstalled.length > 1;
    lines.push({
      level: "warn",
      message: `Selected ${several ? "artifacts" : "artifact"} not installed yet: ${ids}. Run ${one.installCommand}, or apply, to install ${several ? "them" : "it"}.`,
    });
  }
  // #993: a failed update check is not a problem with the installed files, so it leaves `ok` and
  // the exit status alone, but the verdict must not read as if every check ran.
  const unchecked = result.artifacts
    .filter(({ updateCheckFailure }) => updateCheckFailure)
    .map(({ id }) => id);
  if (unchecked.length > 0) {
    const several = unchecked.length > 1;
    lines.push({
      level: "warn",
      message: `The update check failed for ${unchecked.length} ${several ? "artifacts" : "artifact"}: ${unchecked.join(", ")}. The lines above name each cause. The installed files were still checked.`,
    });
  }
  if (result.ok) {
    lines.push({ level: "success", message: "Calavera artifacts doctor found no problems." });
    return lines;
  }
  // ADR-0020, Decision 5: the verdict names each check that failed, so a person who sees
  // artifacts doctor and doctor exit differently can tell which check caused it.
  const failing = result.artifacts
    .filter((artifact) => !isArtifactHealthy(artifact))
    .map(({ id }) => id);
  const checks = [
    ...(result.phaseLine.level === "error" ? [`the project phase, ${result.phase}`] : []),
    ...(result.formatterFailures.length > 0
      ? ["the managed-file check, whose formatter failed"]
      : []),
    ...(result.managedFilePlanProblem !== null
      ? ["the managed-file check, which could not plan the managed files"]
      : []),
    ...(result.cacheBlockProblem
      ? [
          "the artifact cache block, which it did not record, and which is not a finding about the phase or an artifact",
        ]
      : []),
    ...(failing.length > 0
      ? [
          `${failing.length} ${failing.length === 1 ? "artifact" : "artifacts"}: ${failing.join(", ")}`,
        ]
      : []),
  ];
  lines.push({
    level: "error",
    message: `Calavera artifacts doctor found problems with ${new Intl.ListFormat("en", { type: "conjunction" }).format(checks)}.`,
  });
  return lines;
}

/**
 * The warnings `artifacts install` and `artifacts update` print for the lock entries they remove,
 * or, in a dry run, would remove, because the recipe no longer selects those artifacts (#992).
 *
 * @param {{ dryRun: boolean, removedLockEntries: RemovedLockEntry[] }} result
 * @returns {string[]}
 */
export function formatRemovedLockEntries({ dryRun, removedLockEntries }) {
  const removed = dryRun ? "Would remove" : "Removed";
  return removedLockEntries.map(
    ({ id, version, tag }) =>
      `${removed} the lock entry for ${id} ${version} (${tag}), because the recipe no longer selects it. Its installed files stay in place.`,
  );
}

/**
 * The warnings `artifacts install` and `artifacts update` print for each temporary folder they
 * could not remove once the install no longer needed it (#1136). The command still finished.
 *
 * @param {{ temporaryFolderLeftovers: TemporaryFolderLeftover[] }} result
 * @returns {string[]}
 */
export function formatTemporaryFolderLeftovers({ temporaryFolderLeftovers }) {
  return temporaryFolderLeftovers.map(temporaryFolderLeftoverLine);
}
