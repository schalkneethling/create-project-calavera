// @ts-check
import { copyFile, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";

import { fileExists } from "../utils/fs.js";
import { isNotEmptyString } from "../utils/guards.js";
import { collectFiles, hashDirectory, hashFile, textHash } from "../utils/hash.js";
import { normalizeAiItems } from "./recipe-items.js";

/**
 * @typedef {import("../state.js").CalaveraState} CalaveraState
 *
 * @typedef {"skill" | "hook" | "agent"} AiArtifactType
 *
 * @typedef {object} ResolvedAiArtifact
 * @property {string} id The catalog ID, also for a legacy entry, which `source` names by its legacy
 *   path. The lock, and the wiring records apply writes for an entry that names an ID, name an
 *   artifact by this ID (#1119).
 * @property {number} index
 * @property {string} sourcePath
 * @property {string} source
 * @property {string} name
 * @property {AiArtifactType} type
 * @property {string} path
 * @property {string} [target]
 *
 * @typedef {object} AiArtifactState
 * @property {AiArtifactType} type
 * @property {string} name
 * @property {string} source
 * @property {string} path
 * @property {string} hash
 * @property {string} [target]
 *
 * @typedef {{ type: string, path: string, category?: "ai", aiType?: AiArtifactType, name?: string, reason?: string, action?: "write" | "update", ownership?: "project" }} AiChange
 */

const AI_HOOK_FILES = Object.freeze(["hook.mjs", "settings-fragment.json"]);
const CODEX_AGENT_TARGET = "codex";
export const CODE_RABBIT_CONFIG_PATH = ".coderabbit.yaml";
// The filter that keeps Calavera's extracted artifact packages out of reviews. `eject` reports it
// in a `.coderabbit.yaml` that Calavera did not create, because the packages go with `eject`.
export const CODE_RABBIT_PACKAGES_FILTER = "!.calavera/packages/**";
const CODE_RABBIT_SKILL_FILTERS = Object.freeze([
  "!.claude/skills/**",
  "!.agents/skills/**",
  "!.agents/agents/claude-code/**",
  CODE_RABBIT_PACKAGES_FILTER,
  "!pnpm-lock.yaml",
]);
// The first line of every `.coderabbit.yaml` Calavera creates whole. Adding filters to an existing
// file never adds it, so `eject` recognizes a file Calavera created by it (ADR-0017, Decision 2).
export const CODE_RABBIT_CONFIG_FIRST_LINE =
  "# CodeRabbit configuration — https://docs.coderabbit.ai/reference/yaml-template";
const CODE_RABBIT_SKILL_CONFIG = `${CODE_RABBIT_CONFIG_FIRST_LINE}
#
# The skill, agent, and package directories below contain vendored AI-agent
# artifacts copied from upstream packages. Findings in those files belong
# upstream, so excluding them keeps reviews focused on project code.

reviews:
  path_filters:
    - "!.claude/skills/**"
    - "!.agents/skills/**"
    - "!.agents/agents/claude-code/**"
    - "!.calavera/packages/**"
    - "!pnpm-lock.yaml"
`;

/**
 * The change the skill filters need in `.coderabbit.yaml`: unchanged when the file already holds
 * every one of them.
 *
 * @returns {Promise<{ contents: string, type: "write" | "update" } | { type: "unchanged" }>}
 */
async function planCodeRabbitSkillConfig() {
  if (!(await fileExists(CODE_RABBIT_CONFIG_PATH))) {
    return { contents: CODE_RABBIT_SKILL_CONFIG, type: "write" };
  }

  const { LineCounter, isMap, isScalar, isSeq, parseDocument, visit } = await import("yaml");
  let current;
  try {
    current = await readFile(CODE_RABBIT_CONFIG_PATH, "utf8");
  } catch (error) {
    // A file system error names the path and the code, never the file's text.
    const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "unknown error";
    throw new Error(`Cannot update ${CODE_RABBIT_CONFIG_PATH}: cannot read it (${code}).`, {
      cause: error,
    });
  }
  const lineCounter = new LineCounter();
  const document = parseDocument(current, { lineCounter });

  if (document.errors.length > 0) {
    // The parser's message quotes the lines around each error, so only the position and the
    // parser's code reach the output (#1083).
    const positions = document.errors.map(({ code, linePos }) => {
      const start = linePos?.[0];
      return start ? `line ${start.line}, column ${start.col} (${code})` : `${code} (no position)`;
    });
    throw new Error(
      `Cannot update ${CODE_RABBIT_CONFIG_PATH}: it is not valid YAML at ${positions.join("; ")}.`,
    );
  }
  // An empty file has no contents, and `set` makes it a mapping. A top-level list or scalar
  // makes `set` throw a message that does not name the file (#1083).
  if (document.contents !== null && !isMap(document.contents)) {
    throw new Error(`Cannot update ${CODE_RABBIT_CONFIG_PATH}: the top level must be a mapping.`);
  }

  // `set` stores a plain JavaScript value as is, so new collections go through
  // `createNode`; otherwise `isMap` and `isSeq` reject them (#1068).
  if (document.get("reviews", true) === undefined) {
    document.set("reviews", document.createNode({}));
  }
  const reviews = document.get("reviews", true);
  if (!isMap(reviews)) {
    throw new Error(`Cannot update ${CODE_RABBIT_CONFIG_PATH}: reviews must be a mapping.`);
  }

  if (reviews.get("path_filters", true) === undefined) {
    // A local `path_filters` list would replace the list that `<<` merges in.
    // `yaml` exports no merge-key check, so this mirrors the test in its merge
    // tag (`yaml/dist/schema/yaml-1.1/merge.js`): a plain `<<` key holds the
    // string "<<", while `!!merge <<`, `<<` under `%YAML 1.1`, and `? !!merge`
    // hold Symbol(<<).
    const isMergeKey = (/** @type {unknown} */ value) =>
      value === "<<" || (typeof value === "symbol" && value.description === "<<");
    if (reviews.items.some(({ key }) => isScalar(key) && isMergeKey(key.value))) {
      throw new Error(
        `Cannot update ${CODE_RABBIT_CONFIG_PATH}: reviews uses a \`<<\` merge key, so a new path_filters list would replace the merged one. Add path_filters to reviews yourself, then run apply again.`,
      );
    }
    // An empty `reviews: {}` is written in flow style; switch it to block style
    // so the filters are written as a list, not on one line.
    if (reviews.items.length === 0) reviews.flow = false;
    reviews.set("path_filters", document.createNode([]));
  }
  const pathFilters = reviews.get("path_filters", true);
  if (!isSeq(pathFilters)) {
    throw new Error(
      `Cannot update ${CODE_RABBIT_CONFIG_PATH}: reviews.path_filters must be an array.`,
    );
  }

  const existingFilters = new Set(pathFilters.toJSON().map(String));
  const missingFilters = CODE_RABBIT_SKILL_FILTERS.filter((filter) => !existingFilters.has(filter));
  // An alias shares the anchored node, so every alias of an anchored `reviews`
  // mapping or `path_filters` list would gain the filters too.
  const anchored = [
    { label: "reviews", node: reviews },
    { label: "reviews.path_filters", node: pathFilters },
  ].find(({ node }) => node.anchor);
  if (missingFilters.length > 0 && anchored) {
    // The anchor name is file text, so the message gives where the anchored value starts. With
    // default options, the parsed node keeps no position for the anchor itself (#1083). Only a
    // parsed node has an anchor, so it always has a range.
    const { line, col } = lineCounter.linePos(anchored.node.range?.[0] ?? 0);
    throw new Error(
      `Cannot update ${CODE_RABBIT_CONFIG_PATH}: ${anchored.label}, which starts at line ${line}, column ${col}, has an anchor, so its aliases would change too. Add these to reviews.path_filters yourself, then run apply again: ${missingFilters.join(", ")}`,
    );
  }
  // A file that already holds every filter is left as it is, because writing it again would
  // change text the person wrote, such as mixed line endings or spacing (#1083). A new `reviews`
  // or `path_filters` holds no filters, so it never reaches this return.
  if (missingFilters.length === 0) return { type: "unchanged" };

  // `parseDocument` accepts an alias whose anchor is missing or comes later, but `toString`
  // throws a message that quotes the alias name and does not name the file (#1083).
  /** @type {string[]} */
  const unresolvedAliases = [];
  visit(document, {
    Alias: (_key, node) => {
      if (node.resolve(document) === undefined && node.range) {
        const { line, col } = lineCounter.linePos(node.range[0]);
        unresolvedAliases.push(`line ${line}, column ${col}`);
      }
    },
  });
  if (unresolvedAliases.length > 0) {
    throw new Error(
      `Cannot update ${CODE_RABBIT_CONFIG_PATH}: an alias has no anchor before it at ${unresolvedAliases.join("; ")}.`,
    );
  }
  for (const filter of missingFilters) pathFilters.add(filter);

  // `toString` writes `\n` line endings and drops a byte order mark, so a file that uses Windows
  // line endings gets them back on every line, and a file that starts with a byte order mark keeps
  // it (#1083).
  let written;
  try {
    written = document.toString({ lineWidth: 0 });
  } catch (error) {
    // The writer's messages quote anchor and alias names from the file, so only the error's
    // type reaches the output, and the error is not kept as the cause (#1083).
    const type = error instanceof Error ? error.name : typeof error;
    throw new Error(`Cannot update ${CODE_RABBIT_CONFIG_PATH}: the YAML writer failed (${type}).`);
  }
  const lineEndings = current.includes("\r\n") ? written.replaceAll("\n", "\r\n") : written;
  const contents = current.startsWith("\uFEFF") ? `\uFEFF${lineEndings}` : lineEndings;
  return { contents, type: "update" };
}

/**
 * @param {ResolvedAiArtifact} artifact
 * @returns {boolean}
 */
function isCodexAgentArtifact(artifact) {
  return artifact.type === "agent" && artifact.target === CODEX_AGENT_TARGET;
}

/**
 * @param {string} value
 * @returns {string}
 */
function tomlString(value) {
  return JSON.stringify(value);
}

/**
 * @param {string} frontmatter
 * @returns {Record<string, string>}
 */
function parseSimpleFrontmatter(frontmatter) {
  /** @type {Record<string, string>} */
  const fields = {};

  for (const line of frontmatter.split("\n")) {
    const separatorIndex = line.indexOf(":");

    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();

    if (key) {
      fields[key] = value;
    }
  }

  return fields;
}

/**
 * @param {string} markdown
 * @returns {{ frontmatter: Record<string, string>, body: string }}
 */
function parseAgentMarkdown(markdown) {
  const normalized = markdown.replaceAll("\r\n", "\n");

  if (!normalized.startsWith("---\n")) {
    throw new Error("Agent Markdown must start with YAML frontmatter.");
  }

  const closingMarker = normalized.indexOf("\n---\n", 4);

  if (closingMarker === -1) {
    throw new Error("Agent Markdown must include closing YAML frontmatter.");
  }

  return {
    frontmatter: parseSimpleFrontmatter(normalized.slice(4, closingMarker)),
    body: normalized.slice(closingMarker + "\n---\n".length).trim(),
  };
}

/**
 * @param {string} markdown
 * @returns {string}
 */
export function createCodexAgentToml(markdown) {
  const { frontmatter, body } = parseAgentMarkdown(markdown);
  const name = frontmatter.name;
  const description = frontmatter.description;

  if (!isNotEmptyString(name) || !isNotEmptyString(description) || !isNotEmptyString(body)) {
    throw new Error(
      "Codex agent adapter requires source Markdown with name, description, and body instructions.",
    );
  }

  const lines = [
    "# Generated by create-project-calavera from a bundled Markdown agent.",
    "# Source model metadata is omitted because Codex custom agents use Codex model IDs.",
    `name = ${tomlString(name)}`,
    `description = ${tomlString(description)}`,
    `developer_instructions = ${tomlString(body)}`,
  ];

  return `${lines.join("\n")}\n`;
}

/**
 * @param {{ catalogId: string, src: string }} item
 * @param {Map<string, string>} sourcePaths
 */
function resolveAiSourcePath(item, sourcePaths) {
  return sourcePaths.get(item.catalogId) ?? sourcePaths.get(item.src) ?? item.src;
}

/**
 * @param {AiArtifactType} type
 * @param {string} sourcePath
 * @param {number} index
 * @returns {string}
 */
function inferAiSourceName(type, sourcePath, index) {
  if (type === "agent") {
    if (!sourcePath.endsWith(".md")) {
      throw new Error(
        `AI item at index ${index} agent source must point to a Markdown file: ${sourcePath}.`,
      );
    }

    return basename(sourcePath, ".md");
  }

  return basename(sourcePath);
}

/**
 * @param {AiArtifactType} type
 * @param {string} name
 * @param {string | undefined} target
 * @returns {string}
 */
function aiInstallPath(type, name, target) {
  if (type === "skill") {
    return join(AI_OUTPUT_FOLDERS.skill, name);
  }

  if (!target) {
    throw new Error(`AI ${type} items require an output target.`);
  }

  if (type === "hook") {
    return join(AI_OUTPUT_FOLDERS.hook, target, `${name}.mjs`);
  }

  if (target === CODEX_AGENT_TARGET) {
    return join(AI_OUTPUT_FOLDERS.codexAgent, `${name}.toml`);
  }

  return join(AI_OUTPUT_FOLDERS.agent, target, `${name}.md`);
}

/** The project folders `aiInstallPath` installs into; every AI artifact output lies below one. */
const AI_OUTPUT_FOLDERS = Object.freeze({
  skill: ".agents/skills",
  hook: ".agents/hooks",
  agent: ".agents/agents",
  codexAgent: ".codex/agents",
});

/**
 * The base Calavera skill, which `--init` installs and records without a lock entry, and which
 * `skill-calavera` installs to when a recipe selects it. `eject` removes it, and the phase function
 * reads it to tell a bootstrapped project (ADR-0020, Decision 2).
 */
export const BASE_SKILL_PATH = `${AI_OUTPUT_FOLDERS.skill}/calavera`;

/**
 * The project folders AI artifact outputs, and so the artifact transaction's AI targets, lie
 * strictly below (#1193).
 */
export const AI_ARTIFACT_OUTPUT_FOLDERS = Object.freeze(Object.values(AI_OUTPUT_FOLDERS));

/**
 * @param {string} hookPath
 * @returns {string}
 */
function hookSettingsInstallPath(hookPath) {
  return join(dirname(hookPath), `${basename(hookPath, ".mjs")}.settings-fragment.json`);
}

/**
 * @param {{ type: AiArtifactType, path: string }} artifact
 * @returns {string[]}
 */
export function aiArtifactOutputPaths(artifact) {
  return artifact.type === "hook"
    ? [artifact.path, hookSettingsInstallPath(artifact.path)]
    : [artifact.path];
}

/**
 * @param {string} directory
 * @returns {Promise<string>}
 */
async function hashHookDirectory(directory) {
  const hashes = await Promise.all(
    AI_HOOK_FILES.map((fileName) => hashFile(join(directory, fileName))),
  );
  return hashes.join(".");
}

/**
 * @param {string} hookPath
 * @returns {Promise<string>}
 */
async function hashHookInstall(hookPath) {
  const settingsPath = hookSettingsInstallPath(hookPath);
  const hashes = [await hashFile(hookPath)];

  if (await fileExists(settingsPath)) {
    hashes.push(await hashFile(settingsPath));
  }

  return hashes.join(".");
}

/**
 * @param {AiArtifactType} type
 * @param {string} sourcePath
 * @param {number} index
 */
export async function assertAiSourceExists(type, sourcePath, index) {
  let sourceStats;

  try {
    sourceStats = await stat(sourcePath);
  } catch {
    throw new Error(`AI item at index ${index} references missing ${type} source: ${sourcePath}.`);
  }

  const isExpectedKind = type === "agent" ? sourceStats.isFile() : sourceStats.isDirectory();

  if (!isExpectedKind) {
    throw new Error(
      `AI item at index ${index} expected ${type} source "${sourcePath}" to be a ${type === "agent" ? "file" : "directory"}.`,
    );
  }
}

/**
 * @param {AiArtifactType} type
 * @param {string} sourcePath
 * @param {string | undefined} target
 * @returns {Promise<string>}
 */
async function hashAiSource(type, sourcePath, target) {
  if (type === "skill") {
    return hashDirectory(sourcePath);
  }

  if (type === "hook") {
    return hashHookDirectory(sourcePath);
  }

  if (target === CODEX_AGENT_TARGET) {
    return textHash(createCodexAgentToml(await readFile(sourcePath, "utf8")));
  }

  return hashFile(sourcePath);
}

/**
 * The hash `apply` records for each output of an artifact, in the order of
 * `aiArtifactOutputPaths`, computed from the package's payload. A hook has two outputs, the script
 * and its settings fragment; every other type has one. An output matches its package when
 * `hashAiInstall` of the installed path equals the hash at the same position.
 *
 * @param {AiArtifactType} type
 * @param {string} sourcePath The payload path of the extracted package.
 * @param {string | undefined} target
 * @returns {Promise<string[]>}
 */
export async function aiOutputSourceHashes(type, sourcePath, target) {
  return type === "hook"
    ? Promise.all([
        hashFile(join(sourcePath, "hook.mjs")),
        hashFile(join(sourcePath, "settings-fragment.json")),
      ])
    : [await hashAiSource(type, sourcePath, target)];
}

/**
 * @param {AiArtifactType} type
 * @param {string} installPath
 * @param {string} [target]
 * @returns {Promise<string>}
 */
export async function hashAiInstall(type, installPath, target) {
  if (type === "skill") {
    return hashDirectory(installPath);
  }

  if (type === "hook") {
    return hashFile(installPath);
  }

  if (target === CODEX_AGENT_TARGET) {
    return textHash(await readFile(installPath, "utf8"));
  }

  return hashFile(installPath);
}

/**
 * @param {{ ai?: unknown }} recipe
 * @returns {ResolvedAiArtifact[]}
 */
export function resolveAiArtifacts(recipe, sourcePaths = new Map()) {
  /** @type {Map<string, ResolvedAiArtifact>} */
  const deduped = new Map();

  for (const [index, item] of normalizeAiItems(recipe.ai).entries()) {
    const { type, target } = item;
    const sourcePath = resolveAiSourcePath(item, sourcePaths);
    const name = inferAiSourceName(type, item.src, index);
    const key = [type, target, name].filter(Boolean).join(":");

    if (!deduped.has(key)) {
      deduped.set(key, {
        id: item.catalogId,
        index,
        sourcePath,
        source: item.id ?? item.src,
        name,
        target,
        type,
        path: aiInstallPath(type, name, target),
      });
    }
  }

  return [...deduped.values()];
}

/**
 * @param {CalaveraState} state
 * @param {string} path
 * @returns {AiArtifactState | undefined}
 */
function stateAiArtifactForPath(state, path) {
  return state.aiArtifacts.find((artifact) => artifact.path === path);
}

/**
 * Copies the files of a skill directory, the same files `hashDirectory` hashes, one at a time.
 * Not `fs.promises.cp`, because Yarn 2 and later serve Calavera from a zip archive, and Yarn's
 * Plug'n'Play `fs` patch does not cover `cp`: Node's directory copy then looks the zip path up on
 * the real file system and fails with ENOTDIR (#939). A skill source holds no symbolic links to
 * leave out: recipe sources are catalog entries, pacote's extract drops links from registry
 * payloads, and the bundled skill holds regular files only.
 *
 * @param {string} source
 * @param {string} target
 */
async function copySkillDirectory(source, target) {
  // Created up front, as `cp` did, so a skill without files still installs as a directory.
  await mkdir(target, { recursive: true });
  for (const file of await collectFiles(source)) {
    const destination = join(target, relative(source, file));
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(file, destination);
  }
}

/**
 * @param {ResolvedAiArtifact} artifact
 * @param {string} [outputRoot]
 */
async function copyAiArtifact(artifact, outputRoot) {
  const installPath = outputRoot ? resolve(outputRoot, artifact.path) : resolve(artifact.path);

  if (artifact.type === "skill") {
    await rm(installPath, { force: true, recursive: true });
    await copySkillDirectory(artifact.sourcePath, installPath);
    return;
  }

  await mkdir(dirname(installPath), { recursive: true });

  if (artifact.type === "hook") {
    await writeFile(installPath, await readFile(join(artifact.sourcePath, "hook.mjs")));
    await writeFile(
      hookSettingsInstallPath(installPath),
      await readFile(join(artifact.sourcePath, "settings-fragment.json")),
    );

    return;
  }

  if (isCodexAgentArtifact(artifact)) {
    await writeFile(installPath, createCodexAgentToml(await readFile(artifact.sourcePath, "utf8")));
    return;
  }

  await writeFile(installPath, await readFile(artifact.sourcePath));
}

/**
 * @param {ResolvedAiArtifact} artifact
 * @param {string} path
 * @param {string} sourceHash
 * @param {CalaveraState} previousState
 */
async function assertSafeAiWrite(artifact, path, sourceHash, previousState) {
  if (!(await fileExists(path))) {
    return;
  }

  const installedHash = await hashAiInstall(artifact.type, path, artifact.target);

  if (installedHash === sourceHash) {
    return;
  }

  const stateArtifact = stateAiArtifactForPath(previousState, path);

  if (stateArtifact?.hash === installedHash) {
    return;
  }

  if (
    artifact.type === "hook" &&
    path === artifact.path &&
    stateArtifact?.hash === (await hashHookInstall(artifact.path))
  ) {
    return;
  }

  const reason = stateArtifact
    ? `It appears to have local edits (installed=${installedHash}, state=${stateArtifact.hash}).`
    : "It is not recorded as Calavera-managed.";

  throw new Error(`Refusing to overwrite existing AI artifact: ${path}. ${reason}`);
}

/**
 * @param {{ ai?: unknown }} recipe
 * @param {{ dryRun: boolean, outputRoot?: string }} options
 * @param {CalaveraState} previousState
 * @returns {Promise<{ artifacts: AiArtifactState[], changes: AiChange[], pointers: string[] }>}
 */
export async function buildAiApplyResult(recipe, options, previousState, sourcePaths = new Map()) {
  const artifacts = resolveAiArtifacts(recipe, sourcePaths);
  const codeRabbitPlan = artifacts.some(({ type }) => type === "skill")
    ? await planCodeRabbitSkillConfig()
    : undefined;
  /** @type {AiChange[]} */
  const changes = [];
  /** @type {AiArtifactState[]} */
  const stateArtifacts = [];
  /** @type {Set<string>} */
  const pointerSet = new Set();

  for (const artifact of artifacts) {
    await assertAiSourceExists(artifact.type, artifact.sourcePath, artifact.index);
    const outputPaths = aiArtifactOutputPaths(artifact);
    const sourceHashes = await aiOutputSourceHashes(
      artifact.type,
      artifact.sourcePath,
      artifact.target,
    );
    let needsWrite = false;

    for (const [outputIndex, path] of outputPaths.entries()) {
      const sourceHash = sourceHashes[outputIndex];
      if (!sourceHash) {
        throw new Error(`Missing source hash for AI artifact output: ${path}.`);
      }
      stateArtifacts.push({
        type: artifact.type,
        name: artifact.name,
        source: artifact.source,
        target: artifact.target,
        path,
        hash: sourceHash,
      });
      const upToDate =
        (await fileExists(path)) &&
        (await hashAiInstall(artifact.type, path, artifact.target)) === sourceHash;
      if (!upToDate) {
        await assertSafeAiWrite(artifact, path, sourceHash, previousState);
        needsWrite = true;
      }
      // #956: an output that already matches its source is recorded too, so a re-run names it.
      changes.push({
        type: upToDate ? "unchanged" : "write",
        path,
        category: "ai",
        aiType: artifact.type,
        name: artifact.name,
      });
    }

    if (needsWrite && !options.dryRun) {
      await copyAiArtifact(artifact, options.outputRoot);
    }

    if (artifact.type === "skill") {
      pointerSet.add("Installed skills are available under .agents/skills/.");
    }

    if (artifact.type === "hook") {
      pointerSet.add(
        `Hook scripts for ${artifact.target} are installed under .agents/hooks/${artifact.target}/. Review bundled settings-fragment.json files before wiring them into agent settings.`,
      );
    }

    if (artifact.type === "agent") {
      pointerSet.add(
        isCodexAgentArtifact(artifact)
          ? "Codex custom agent files are installed under .codex/agents/."
          : `Agent files for ${artifact.target} are installed under .agents/agents/${artifact.target}/ in their original Markdown/frontmatter format.`,
      );
    }
  }

  if (codeRabbitPlan?.type === "unchanged") {
    // #956: the file already holds every filter, so a re-run names it unchanged.
    changes.push({ type: "unchanged", path: CODE_RABBIT_CONFIG_PATH, ownership: "project" });
  } else if (codeRabbitPlan) {
    changes.push({
      type: codeRabbitPlan.type,
      path: CODE_RABBIT_CONFIG_PATH,
      action: codeRabbitPlan.type,
      ownership: "project",
    });
    if (!options.dryRun) {
      const configPath = options.outputRoot
        ? resolve(options.outputRoot, CODE_RABBIT_CONFIG_PATH)
        : resolve(CODE_RABBIT_CONFIG_PATH);
      try {
        await mkdir(dirname(configPath), { recursive: true });
        await writeFile(configPath, codeRabbitPlan.contents);
      } catch (error) {
        // A file system error names the path and the code, never the file's text (#1083).
        const code = /** @type {NodeJS.ErrnoException} */ (error).code ?? "unknown error";
        throw new Error(`Cannot update ${CODE_RABBIT_CONFIG_PATH}: cannot write it (${code}).`, {
          cause: error,
        });
      }
    }
  }

  return {
    artifacts: stateArtifacts,
    changes,
    pointers: [...pointerSet],
  };
}
