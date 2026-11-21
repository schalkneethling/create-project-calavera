// @ts-check
// The human-readable summary of `apply --dry-run` and `apply` (#617): labeled groups separated by
// blank lines, as the bootstrap summary prints them (#601), and each fact once. The package
// manager and the Vite+ report sit under Project; each integration is one line, with the packages
// it installs in parentheses only where their names differ from the integration's (owner decision
// of 2026-11-14); each file is one line under Files, with the ignore lines apply writes into it;
// the scripts sit under Scripts; each artifact is one line with its version and destination, with
// its inputs and wiring under it. The `--json` and MCP results keep their shape and text; where a
// note there repeats what the summary already names, the summary prints a shorter form of it.
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
import { DETAIL, ITEM, info, pushGroup, tense, warn } from "./summary-lines.js";
import { quoteScriptValue } from "./utils/text.js";

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
 * The lines `apply --dry-run` and `apply` print for `result`, in order. The caller prints a line
 * with the logger method its level names.
 *
 * @param {ApplyResult} result
 * @returns {SummaryLine[]}
 */
export function applySummaryLines(result) {
  return [
    result.dryRun
      ? info("Calavera apply dry run complete. No files were changed.")
      : { level: "success", text: "Calavera apply complete." },
    ...applySummaryBody(result),
  ];
}

/**
 * The lines after the headline, so a command that runs the apply dry run as one of its steps, such
 * as `init --apply` (#1022), can say in its own headline what it has already written.
 *
 * @param {ApplyResult} result
 * @returns {SummaryLine[]}
 */
export function applySummaryBody(result) {
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
  pushGroup(lines, "Integrations", integrationLines(result));
  pushGroup(lines, "Files", fileLines(result));
  pushGroup(lines, "Scripts", scriptLines(result));
  pushGroup(lines, "Artifacts", artifactLines(result));
  pushGroup(lines, "Notes", [
    ...result.pointers.map((pointer) => info(`${ITEM}${summaryPointer(pointer)}`)),
    ...result.inputWarnings.map((warning) => warn(`${ITEM}${warning}`)),
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
 * @returns {SummaryLine[]}
 */
function integrationLines(result) {
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
 * Artifacts, so neither is listed here.
 *
 * @param {ApplyResult} result
 * @returns {SummaryLine[]}
 */
function fileLines(result) {
  const { dryRun } = result;
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
    for (const ignoreChange of changes) {
      lines.push(info(`${DETAIL}${ignoreChangeLine(ignoreChange, dryRun)}`));
    }
  }

  return lines;
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
 * One integration's part of an ignore file, under the file's own line, so the path is not named
 * again.
 *
 * @param {IgnoreChange} change
 * @param {boolean} dryRun
 */
function ignoreChangeLine({ path, integration, type, lines, previousLines, removedLines }, dryRun) {
  const quoted = (/** @type {string[]} */ values) => values.map(quoteScriptValue).join(", ");
  if (removedLines !== undefined) {
    if (integration === undefined) {
      return `${tense(dryRun, "Would remove", "Removed")} lines no selected integration declares: ${quoted(removedLines)}`;
    }
    const because =
      integration === ARTIFACT_CACHE_BLOCK
        ? "the recipe selects no artifacts and .calavera/cache/ does not exist"
        : `${integration} no longer adds lines to it`;
    return `${tense(dryRun, "Would remove", "Removed")} the ${integration} block, because ${because}: ${quoted(removedLines)}`;
  }
  const what = path === GITIGNORE_PATH ? `the ${integration} block` : `the ${integration} lines`;
  if (type === "unchanged") return `Already holds ${what}: ${quoted(lines ?? [])}`;
  if (previousLines !== undefined) {
    return `${tense(dryRun, "Would replace", "Replaced")} ${what}: ${quoted(previousLines)} with ${quoted(lines ?? [])}`;
  }
  return `${tense(dryRun, "Would add", "Added")} ${what}: ${quoted(lines ?? [])}`;
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
 * Its inputs and wiring sit under it. An artifact the recipe no longer selects is named for the
 * wiring apply removes.
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
    lines.push(...wiring.flatMap((change) => wiringLines(change, dryRun)).map(detail));
  }

  const deselected = [
    ...new Set(result.wiringChanges.map(({ artifact }) => artifact).filter((id) => !named.has(id))),
  ];
  for (const id of deselected) {
    lines.push(info(`${ITEM}${id}, which the recipe no longer selects`));
    lines.push(
      ...result.wiringChanges
        .filter(({ artifact }) => artifact === id)
        .flatMap((change) => wiringLines(change, dryRun))
        .map(detail),
    );
  }

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
    ...result.wiringWarnings.map((warning) => warn(`${ITEM}${warning}`)),
  ];
}

/**
 * The cache pointer without the ignore file, which the summary names once, under Files, with the
 * block in it.
 *
 * @param {string} pointer
 */
function summaryPointer(pointer) {
  return pointer === ARTIFACT_CACHE_POINTER
    ? `${ARTIFACT_CACHE_IGNORED}, ${ARTIFACT_CACHE_REASON}`
    : pointer;
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

/** @param {string} text @returns {SummaryLine} */
function detail(text) {
  return info(`${DETAIL}${text}`);
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
 * The lines for one artifact's part of a wiring file, under the artifact's own line, so the
 * artifact is not named again; the approval covers the exact text.
 *
 * @param {WiringChange} change
 * @param {boolean} dryRun
 * @returns {string[]}
 */
function wiringLines(
  { path, kind, type, block, removedBlock, groupChanges, reformatted, deselected },
  dryRun,
) {
  const because = deselected
    ? "because the recipe no longer selects it"
    : "because it no longer wires that hook";
  if (removedBlock !== undefined) {
    return [
      `${tense(dryRun, "Would remove", "Removed")} its block from ${path}, ${because}: ${quoteScriptValue(removedBlock)}`,
    ];
  }
  if (kind === "vite-hook") {
    if (type === "unchanged")
      return [`${path} already holds its block: ${quoteScriptValue(block)}`];
    const action =
      type === "write"
        ? tense(dryRun, "Would write", "Wrote")
        : tense(dryRun, "Would update", "Updated");
    return [`${action} its block in ${path}: ${quoteScriptValue(block)}`];
  }
  if (type === "unchanged") return [`${path} already holds its hook groups`];
  return [
    ...(groupChanges ?? []).map(({ event, action, group, previous }) =>
      action === "add"
        ? `${tense(dryRun, "Would add", "Added")} a ${event} group to ${path}: ${quoteScriptValue(group)}`
        : action === "replace"
          ? `${tense(dryRun, "Would replace", "Replaced")} the ${event} group in ${path}: ${quoteScriptValue(previous)} with ${quoteScriptValue(group)}`
          : `${tense(dryRun, "Would remove", "Removed")} the ${event} group from ${path}${deselected ? `, ${because}` : ""}: ${quoteScriptValue(previous)}`,
    ),
    ...(reformatted
      ? [
          `${tense(dryRun, "Would also change", "Also changed")} the layout of the rest of ${path}, because Calavera writes the whole file in the project's format; no value outside the groups changes`,
        ]
      : []),
  ];
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
