// @ts-check
// The human-readable summary of `apply --dry-run` and `apply` (#617): labeled groups separated by
// blank lines, as the bootstrap summary prints them (#601), and each fact once. The package
// manager and the Vite+ report sit under Project; each integration is one line, with the packages
// it installs in parentheses only where their names differ from the integration's (owner decision
// of 2026-11-14); each file is one line under Files, with the ignore lines apply writes into it;
// the scripts sit under Scripts; each artifact is one line with its version and destination, with
// its inputs and Vite+ hook blocks under it, and .claude/settings.json is one line after the
// artifacts, with every artifact's hook groups under it (#1145). The `--json` and MCP results
// keep their shape and text; where a note there repeats what the summary already names, the
// summary prints a shorter form of it.
import { summaryWiringWarning } from "./ai/artifact-wiring.js";
import { aiArtifactOutputPaths, resolveAiArtifacts } from "./ai/artifacts.js";
import {
  ARTIFACT_CACHE_BLOCK,
  ARTIFACT_CACHE_IGNORED,
  ARTIFACT_CACHE_POINTER,
  ARTIFACT_CACHE_REASON,
} from "./artifact-lifecycle.js";
import { GITIGNORE_PATH } from "./ignore-lines.js";
import { resolveRecipeIntegrations } from "./recipe.js";
import { integrationDependencies } from "./stryker-options.js";
import { hookGroupChangeLine, settingsLayoutLine } from "./hook-group-lines.js";
import { DETAIL, ITEM, info, pushGroup, tense, warn } from "./summary-lines.js";
import { temporaryFolderLeftoverLine } from "./utils/cleanup.js";
import { quoteScriptValue } from "./utils/text.js";
import { VARLOCK_POINTER, varlockSummaryPointer } from "./varlock.js";

/**
 * @typedef {import("./index.js").ApplyResult} ApplyResult
 * @typedef {import("./index.js").Change} Change
 * @typedef {import("./ai/artifact-wiring.js").WiringChange} WiringChange
 * @typedef {import("./ignore-lines.js").IgnoreChange} IgnoreChange
 * @typedef {import("./summary-lines.js").SummaryLine} SummaryLine
 */

/**
 * The start of the install note that names the exact command apply spawns: the running Node.js,
 * the project's vp bin, and the install arguments (ADR-0012, Decision 3).
 */
export const VP_RUNNER_NOTE_PREFIX =
  "Vite+ runs this with the package manager the project pins; apply runs it as: ";

// Inspection findings the Project group already states: the package manager line, and the
// ADR-0011 Vite+ report, which names the detection status, the signal, and any signal conflict.
const FINDINGS_IN_PROJECT_GROUP = new Set([
  "package-manager",
  "vite-plus-managed",
  "vite-plus-unmanaged",
  "vite-plus-signal-conflict",
  "vite-plus-detection-unknown",
]);

/**
 * @typedef {object} ApplySummaryOptions
 * @property {boolean} [noInstall] The command ran with --no-install. A dry run still plans the
 * install command, so `--json` and MCP callers keep it, but the summary says apply will not run
 * it (#1022).
 */

/** The headline of an apply dry run that has changed no files, which `init --apply --dry-run` prints too. */
export const APPLY_DRY_RUN_HEADLINE = "Calavera apply dry run complete. No files were changed.";

/**
 * The lines `apply --dry-run` and `apply` print for `result`, in order. The caller prints a line
 * with the logger method its level names.
 *
 * @param {ApplyResult} result
 * @param {ApplySummaryOptions} [options]
 * @returns {SummaryLine[]}
 */
export function applySummaryLines(result, options = {}) {
  return [
    result.dryRun
      ? info(APPLY_DRY_RUN_HEADLINE)
      : { level: "success", text: "Calavera apply complete." },
    ...applySummaryBody(result, options),
  ];
}

/**
 * The lines after the headline, so a command that runs the apply dry run as one of its steps, such
 * as `init --apply` (#1022), can say in its own headline what it has already written.
 *
 * @param {ApplyResult} result
 * @param {ApplySummaryOptions} [options]
 * @returns {SummaryLine[]}
 */
export function applySummaryBody(result, { noInstall = false } = {}) {
  const { dryRun } = result;
  /** @type {SummaryLine[]} */
  const lines = [];

  if (
    dryRun &&
    result.changes.length > 0 &&
    result.changes.every(({ type }) => type === "unchanged") &&
    result.autoInstalledArtifacts.length === 0
  ) {
    lines.push(info("Nothing to change: the project already matches this recipe."));
  }

  // A completed apply has nothing left to say about the project itself: the dry run showed it.
  if (dryRun) {
    pushGroup(lines, "Project", projectLines(result));
  }
  pushGroup(lines, "Integrations", integrationLines(result, noInstall));
  const files = fileLines(result);
  pushGroup(lines, "Files", files.lines);
  pushGroup(lines, "Scripts", scriptLines(result));
  pushGroup(lines, "Artifacts", artifactLines(result));
  pushGroup(lines, "Notes", [
    ...result.pointers.map((pointer) => info(`${ITEM}${summaryPointer(pointer, files.listed)}`)),
    ...result.inputWarnings.map((warning) => warn(`${ITEM}${warning}`)),
    // #1033: a temporary folder the command could not remove; it finished all the same.
    ...result.temporaryFolderLeftovers.map((leftover) =>
      warn(`${ITEM}${temporaryFolderLeftoverLine(leftover)}`),
    ),
  ]);

  return lines;
}

/** @param {ApplyResult} result @returns {SummaryLine[]} */
function projectLines(result) {
  return [
    info(`${ITEM}Package manager: ${result.packageManager}`),
    ...result.vitePlus.lines.map((line) => info(`${ITEM}${line}`)),
    ...result.projectInspection.findings
      .filter(
        ({ kind }) =>
          !FINDINGS_IN_PROJECT_GROUP.has(kind) ||
          // A package manager given to apply that differs from the detected one stays visible.
          (kind === "package-manager" &&
            result.projectInspection.packageManager !== result.packageManager),
      )
      .map(({ severity, message }) => info(`${ITEM}Inspection ${severity}: ${message}`)),
  ];
}

/**
 * One line per integration, with the packages it installs in parentheses where their names differ
 * from the integration's, then its inputs, then how the packages are installed. A package two
 * integrations install is named under the first.
 *
 * @param {ApplyResult} result
 * @param {boolean} noInstall
 * @returns {SummaryLine[]}
 */
function integrationLines(result, noInstall) {
  /** @type {Set<string>} */
  const named = new Set();
  /** @type {SummaryLine[]} */
  const lines = [];

  for (const integration of resolveRecipeIntegrations(result.recipe)) {
    const installs = integrationDependencies(integration, result.recipe.integrationOptions);
    const others = installs.filter((name) => name !== integration.id && !named.has(name));
    for (const name of installs) named.add(name);
    const prefix = installs.includes(integration.id) ? "also " : "";
    lines.push(
      info(
        `${ITEM}${integration.id}${others.length > 0 ? ` (${prefix}${others.join(", ")})` : ""}`,
      ),
    );

    for (const { name, ...input } of result.integrationInputs.filter(
      ({ integration: id }) => id === integration.id,
    )) {
      lines.push(info(`${DETAIL}${name} = ${formatInputValue(input)}`));
    }
  }

  if (result.dependencies.length > 0) {
    if (result.installCommand === null) {
      lines.push(info(`${ITEM}Not installed, because apply ran with --no-install.`));
      if (result.laterInstallCommand !== undefined) {
        lines.push(info(`${ITEM}Install them later with: ${result.laterInstallCommand}`));
      }
    } else if (noInstall) {
      // Only a dry run plans the command under --no-install. The install notes say how apply
      // runs it, which it will not do, so they are left out, as apply itself leaves them out.
      lines.push(
        info(`${ITEM}Not installed, because apply runs with --no-install.`),
        info(`${ITEM}Install them later with: ${result.installCommand}`),
      );
    } else if (result.dryRun) {
      lines.push(info(`${ITEM}Install command: ${result.installCommand}`));
      lines.push(
        ...result.installNotes.map((note) => info(`${ITEM}${summaryInstallNote(note, result)}`)),
      );
    } else {
      lines.push(info(`${ITEM}Installed with: ${result.installCommand}`));
    }
  }

  return lines;
}

/**
 * Each file apply writes, merges, or leaves unchanged, with the ignore lines it writes into it.
 * The package.json scripts sit under Scripts, and the artifacts' outputs and wiring files under
 * Artifacts, so neither is listed here. `listed` holds the path of each file named, so a note can
 * point to Files instead of naming the file again (#1023).
 *
 * @param {ApplyResult} result
 */
function fileLines(result) {
  const { dryRun } = result;
  /** @type {Set<string>} */
  const listed = new Set();
  const wiringPaths = new Set(result.wiringChanges.map(({ path }) => path));
  /** @type {Map<string, IgnoreChange[]>} */
  const ignoreChangesByPath = new Map();
  for (const change of result.ignoreChanges) {
    ignoreChangesByPath.set(change.path, [...(ignoreChangesByPath.get(change.path) ?? []), change]);
  }
  /** @type {SummaryLine[]} */
  const lines = [];

  for (const change of result.changes) {
    if (change.category === "ai" || wiringPaths.has(change.path)) continue;
    const line = fileChangeLine(change, dryRun);
    if (line === undefined) continue;
    lines.push(info(`${ITEM}${line}`));
    listed.add(change.path);
    // #1085: apply formats a package.json Calavera wrote, which can reorder its keys. The detail
    // says "it", so the file is named once.
    if (change.formatting !== undefined) {
      lines.push(info(`${DETAIL}${change.formatting}`));
    }
    for (const ignoreChange of ignoreChangesByPath.get(change.path) ?? []) {
      lines.push(info(`${DETAIL}${ignoreChangeLine(ignoreChange, dryRun)}`));
    }
    ignoreChangesByPath.delete(change.path);
  }

  // #1034: each entry of .calavera/.staging/, which apply removes when it is an old copy of a
  // locked package and keeps otherwise.
  for (const { path, action, reason } of result.stagingLeftovers) {
    lines.push(
      action === "remove"
        ? info(`${ITEM}${tense(dryRun, "Would remove", "Removed")} ${path}: ${reason}`)
        : warn(`${ITEM}${tense(dryRun, "Would keep", "Kept")} ${path}: ${reason}`),
    );
  }

  // An ignore file apply plans lines for without a change of its own, such as an unchanged
  // .gitignore that Varlock owns, is still named once, with its lines under it.
  for (const [path, changes] of ignoreChangesByPath) {
    lines.push(info(`${ITEM}${path}`));
    listed.add(path);
    for (const ignoreChange of changes) {
      lines.push(info(`${DETAIL}${ignoreChangeLine(ignoreChange, dryRun)}`));
    }
  }

  return { lines, listed };
}

/**
 * @param {Change} change
 * @param {boolean} dryRun
 * @returns {string | undefined}
 */
function fileChangeLine(change, dryRun) {
  const { path } = change;
  if (change.type === "unchanged") return `Unchanged ${path}`;
  if (change.type === "update") return `${tense(dryRun, "Would update", "Updated")} ${path}`;
  if (change.type !== "write") return undefined;
  if (change.ownership === "calavera") {
    return dryRun ? `Would write and own ${path}` : `Wrote ${path}, which Calavera owns`;
  }
  if (change.action === "scaffold")
    return `${tense(dryRun, "Would scaffold", "Scaffolded")} ${path}`;
  if (change.action === "merge") return `${tense(dryRun, "Would merge", "Merged")} ${path}`;
  // #603: a recipe from outside the project is copied in as calavera.config.json.
  if (change.from !== undefined) {
    return `${tense(dryRun, "Would copy", "Copied")} ${change.from} to ${path}`;
  }
  return `${tense(dryRun, "Would write", "Wrote")} ${path}`;
}

/**
 * One integration's part of an ignore file. Apply prints it under the file's own line, so the path
 * is not named again. A summary without that file line, such as the `artifacts` dry run, passes
 * `namePath` so the line names the file itself, in the same words otherwise (#1135).
 *
 * @param {IgnoreChange} change
 * @param {boolean} dryRun
 * @param {{ namePath?: boolean }} [options]
 */
export function ignoreChangeLine(
  { path, integration, type, lines, previousLines, removedLines },
  dryRun,
  { namePath = false } = {},
) {
  const quoted = (/** @type {string[]} */ values) => values.map(quoteScriptValue).join(", ");
  const inPath = (/** @type {string} */ preposition) => (namePath ? ` ${preposition} ${path}` : "");
  if (removedLines !== undefined) {
    if (integration === undefined) {
      return `${tense(dryRun, "Would remove", "Removed")} lines no selected integration declares${inPath("from")}: ${quoted(removedLines)}`;
    }
    const because =
      integration === ARTIFACT_CACHE_BLOCK
        ? "the recipe selects no artifacts and .calavera/cache/ does not exist"
        : `${integration} no longer adds lines to it`;
    return `${tense(dryRun, "Would remove", "Removed")} the ${integration} block${inPath("from")}, because ${because}: ${quoted(removedLines)}`;
  }
  const what = path === GITIGNORE_PATH ? `the ${integration} block` : `the ${integration} lines`;
  if (type === "unchanged") {
    return `${namePath ? `${path} already holds` : "Already holds"} ${what}: ${quoted(lines ?? [])}`;
  }
  if (previousLines !== undefined) {
    return `${tense(dryRun, "Would replace", "Replaced")} ${what}${inPath("in")}: ${quoted(previousLines)} with ${quoted(lines ?? [])}`;
  }
  return `${tense(dryRun, "Would add", "Added")} ${what}${inPath("to")}: ${quoted(lines ?? [])}`;
}

/**
 * The package.json scripts apply adds, changes, renames, removes, or leaves out, with the value
 * each gets, so the approval boundary shows the command.
 *
 * @param {ApplyResult} result
 * @returns {SummaryLine[]}
 */
function scriptLines(result) {
  const { dryRun } = result;
  const change = result.changes.find(({ scripts }) => scripts !== undefined);
  if (change === undefined) return [];
  /** @type {string[]} */
  const lines = [];

  for (const { script, value, previous, renamedFrom } of result.scriptChanges) {
    if (renamedFrom !== undefined) {
      lines.push(
        `${tense(dryRun, "Would rename", "Renamed")} script ${renamedFrom} to ${script}: ${quoteScriptValue(value)}`,
      );
    } else if (previous === undefined) {
      lines.push(
        `${tense(dryRun, "Would add", "Added")} script ${script}: ${quoteScriptValue(value)}`,
      );
    } else {
      lines.push(
        `${tense(dryRun, "Would change", "Changed")} script ${script} from ${quoteScriptValue(previous)} to ${quoteScriptValue(value)}`,
      );
    }
  }

  const changedScripts = new Set(result.scriptChanges.map(({ script }) => script));
  const unchangedScripts = (change.scripts ?? []).filter((script) => !changedScripts.has(script));
  if (unchangedScripts.length > 0) {
    lines.push(`Scripts already set: ${unchangedScripts.join(", ")}`);
  }

  if (change.removedDefaultTestScript) {
    lines.push(
      `${tense(dryRun, "Would remove", "Removed")} the default npm test placeholder script`,
    );
  }

  if (change.removedQualityScript !== undefined) {
    lines.push(
      `${tense(dryRun, "Would remove", "Removed")} script quality: ${quoteScriptValue(change.removedQualityScript)}`,
    );
  }

  for (const { script, reason } of change.omittedScripts ?? []) {
    lines.push(`${tense(dryRun, "Would omit", "Omitted")} script ${script}: ${reason}`);
  }

  for (const { step, reason } of change.omittedQualitySteps ?? []) {
    lines.push(`${tense(dryRun, "Would omit", "Omitted")} ${step} from script quality: ${reason}`);
  }

  return lines.map((line) => info(`${ITEM}${line}`));
}

/**
 * One line per artifact with anything to report: the version apply locks and the destination it
 * writes, or that the files already in the project match, with or without a lock (#749, #956).
 * Its inputs and Vite+ hook blocks sit under it. An artifact the recipe no longer selects is named
 * for the wiring apply removes. The settings file follows the artifacts, once, with each artifact's
 * hook groups under it (#1145).
 *
 * @param {ApplyResult} result
 * @returns {SummaryLine[]}
 */
function artifactLines(result) {
  const { dryRun } = result;
  const aiPaths = (/** @type {string} */ changeType) =>
    new Set(
      result.changes
        .filter(({ category, type }) => category === "ai" && type === changeType)
        .map(({ path }) => path),
    );
  const writtenPaths = aiPaths("write");
  const unchangedPaths = aiPaths("unchanged");
  /** @type {SummaryLine[]} */
  const lines = [];
  /** @type {Set<string>} */
  const named = new Set();
  // The settings file is one line after the artifacts, with every artifact's groups under it, so
  // an artifact's own lines hold only its Vite+ hook blocks (#1145).
  const hookBlockLines = (/** @type {WiringChange[]} */ changes) =>
    changes
      .filter(({ kind }) => kind === "vite-hook")
      .flatMap((change) => hookBlockLine(change, dryRun));

  // An artifact's catalog ID names it in the lock entries, inputs, and wiring, also for an item the
  // recipe selects by its legacy type and src (#1119).
  for (const artifact of resolveAiArtifacts(result.recipe)) {
    const { id } = artifact;
    named.add(id);
    const outputs = aiArtifactOutputPaths(artifact);
    const written = outputs.filter((path) => writtenPaths.has(path));
    const unchanged = outputs.filter((path) => unchangedPaths.has(path));
    const locked = result.autoInstalledArtifacts.find((entry) => entry.id === id);
    const inputs = result.artifactInputs.filter(({ artifact: owner }) => owner === id);
    const wiring = result.wiringChanges.filter(({ artifact: owner }) => owner === id);
    const headline = artifactHeadline(id, locked, written, unchanged, dryRun);
    if (headline === undefined && inputs.length === 0 && wiring.length === 0) continue;

    lines.push(info(`${ITEM}${headline ?? id}`));
    // The headline names a single output; several sit under it, and an output that already
    // matches beside one apply writes is named as unchanged.
    const listed = written.length > 0 ? written : unchanged;
    if (listed.length > 1) {
      lines.push(...listed.map((path) => info(`${DETAIL}${path}`)));
    }
    if (written.length > 0) {
      lines.push(...unchanged.map((path) => info(`${DETAIL}Unchanged ${path}`)));
    }
    for (const { name, ...input } of inputs) {
      lines.push(info(`${DETAIL}${name} = ${formatInputValue(input)}`));
    }
    lines.push(...hookBlockLines(wiring));
  }

  const deselected = [
    ...new Set(result.wiringChanges.map(({ artifact }) => artifact).filter((id) => !named.has(id))),
  ];
  for (const id of deselected) {
    lines.push(info(`${ITEM}${id}, which the recipe no longer selects`));
    lines.push(...hookBlockLines(result.wiringChanges.filter(({ artifact }) => artifact === id)));
  }
  lines.push(...settingsFileLines(result.wiringChanges, dryRun));

  return [
    ...(lines.length > 0
      ? [
          ...result.artifactRegistries.map((registry) =>
            info(`${ITEM}Registry: ${formatArtifactRegistry(registry)}`),
          ),
          ...lines,
        ]
      : []),
    ...result.artifactWarnings.map((warning) => warn(`${ITEM}${warning}`)),
    ...result.wiringWarnings.map((warning) =>
      warn(`${ITEM}${summaryWiringWarning(warning, result.recipe)}`),
    ),
  ];
}

/**
 * A pointer without the files the summary names once, under Files: the cache pointer without the
 * ignore file that holds the block, and the Varlock note without the schema and the ignore file
 * where Files lists them (#1023).
 *
 * @param {string} pointer
 * @param {ReadonlySet<string>} listed The paths the summary names under Files.
 */
function summaryPointer(pointer, listed) {
  if (pointer === ARTIFACT_CACHE_POINTER)
    return `${ARTIFACT_CACHE_IGNORED}, ${ARTIFACT_CACHE_REASON}`;
  if (pointer === VARLOCK_POINTER) return varlockSummaryPointer(listed);
  return pointer;
}

/**
 * The runner note without the install arguments, which the Install command line just above
 * names; the note in `installNotes` keeps the exact command (ADR-0012).
 *
 * @param {string} note
 * @param {ApplyResult} result
 */
function summaryInstallNote(note, result) {
  const command = result.installCommand ?? "";
  if (!note.startsWith(VP_RUNNER_NOTE_PREFIX) || !command.startsWith("vp ")) return note;
  const argumentsText = ` ${command.slice("vp ".length)}`;
  if (!note.endsWith(argumentsText)) return note;
  const runner = note.slice(VP_RUNNER_NOTE_PREFIX.length, note.length - argumentsText.length);
  return `Vite+ runs this with the package manager the project pins; apply runs it with: ${runner}`;
}

/**
 * @param {string} id
 * @param {import("./index.js").AutoInstalledArtifact | undefined} locked The entry apply locks, for an artifact without a lock entry; its `filesAlreadyMatch` decides the headline, so the summary and the JSON result agree (#1021).
 * @param {string[]} written The outputs apply writes.
 * @param {string[]} unchanged The outputs that already match (#956).
 * @param {boolean} dryRun
 * @returns {string | undefined}
 */
function artifactHeadline(id, locked, written, unchanged, dryRun) {
  const destination = written.length === 1 ? ` ${written[0]}` : ":";
  if (locked !== undefined) {
    const lock = `${tense(dryRun, "Would lock", "Locked")} ${id} ${locked.version}`;
    if (locked.filesAlreadyMatch) {
      const matching =
        unchanged.length === 0 ? "" : unchanged.length === 1 ? `: ${unchanged[0]}` : ":";
      return `${lock}; ${tense(dryRun, "its files in the project already match", "its files in the project already matched")}${matching}`;
    }
    return `${lock} and ${tense(dryRun, "write", "wrote")}${destination}`;
  }
  if (written.length === 0) {
    if (unchanged.length === 0) return undefined;
    return unchanged.length === 1 ? `Unchanged ${id} at ${unchanged[0]}` : `Unchanged ${id}:`;
  }
  return written.length === 1
    ? `${tense(dryRun, "Would write", "Wrote")} ${id} to ${written[0]}`
    : `${tense(dryRun, "Would write", "Wrote")} ${id}:`;
}

/**
 * The line for one artifact's block in a Vite+ hook, under the artifact's own line, so the
 * artifact is not named again; the approval covers the exact text.
 *
 * @param {WiringChange} change
 * @param {boolean} dryRun
 * @returns {SummaryLine}
 */
function hookBlockLine({ path, type, block, removedBlock, deselected }, dryRun) {
  const detail = (/** @type {string} */ text) => info(`${DETAIL}${text}`);
  if (removedBlock !== undefined) {
    const because = deselected
      ? "because the recipe no longer selects it"
      : "because it no longer wires that hook";
    return detail(
      `${tense(dryRun, "Would remove", "Removed")} its block from ${path}, ${because}: ${quoteScriptValue(removedBlock)}`,
    );
  }
  if (type === "unchanged")
    return detail(`${path} already holds its block: ${quoteScriptValue(block)}`);
  const action =
    type === "write"
      ? tense(dryRun, "Would write", "Wrote")
      : tense(dryRun, "Would update", "Updated");
  return detail(`${action} its block in ${path}: ${quoteScriptValue(block)}`);
}

/**
 * Each settings file the artifacts change once, with every artifact's hook groups under its line
 * and each group line naming its artifact, as the clean summary prints a wiring file (owner
 * decision on #1145). The groups follow the artifacts' order above. The file is written when the
 * first artifact writes it, even though each later artifact plans against that new text and so
 * reports an update. Rewriting the file once can only change its layout once, so the layout note
 * is printed once, after the groups.
 *
 * @param {WiringChange[]} wiringChanges
 * @param {boolean} dryRun
 * @returns {SummaryLine[]}
 */
function settingsFileLines(wiringChanges, dryRun) {
  const changes = wiringChanges.filter(({ kind }) => kind === "claude-settings");
  const paths = [...new Set(changes.map(({ path }) => path))];
  return paths.flatMap((path) => {
    const own = changes.filter((change) => change.path === path);
    const types = new Set(own.map(({ type }) => type));
    const file = types.has("write")
      ? `${tense(dryRun, "Would write", "Wrote")} ${path}`
      : types.has("update")
        ? `${tense(dryRun, "Would update", "Updated")} ${path}`
        : `Unchanged ${path}`;
    return [
      info(`${ITEM}${file}`),
      ...own
        .flatMap(({ artifact, type, groupChanges, deselected }) =>
          type === "unchanged"
            ? [`Already holds the hook groups for ${artifact}`]
            : (groupChanges ?? []).map((change) =>
                hookGroupChangeLine(change, { artifact, dryRun, deselected }),
              ),
        )
        .concat(own.some(({ reformatted }) => reformatted) ? [settingsLayoutLine(dryRun)] : [])
        .map((text) => info(`${DETAIL}${text}`)),
    ];
  });
}

/**
 * The value and where it came from. A default names what Git showed, so the person can tell
 * whether it is the branch they mean before they approve it (#846).
 *
 * @param {import("./ai/artifact-inputs.js").InputValue} input
 */
function formatInputValue({ value, source, defaultSource }) {
  const origin = {
    recorded: "recorded in the recipe",
    prompt: "your answer",
    default: `the default${defaultSource ? ` (${defaultSource.detail})` : ""}, because the recipe records no value; apply needs it recorded in the recipe`,
  }[source];
  return `${value} (${origin})`;
}

/** @param {import("./index.js").ArtifactRegistryReport} registry */
export function formatArtifactRegistry({ origin, source }) {
  return source === "default" ? origin : `${origin} (from the ${source})`;
}
