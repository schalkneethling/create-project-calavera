// @ts-check
import { cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { artifactForId, artifactForLegacyPath } from "@schalkneethling/calavera-artifact-core";

import { fileExists } from "../utils/fs.js";
import { isNotEmptyString } from "../utils/guards.js";
import { hashDirectory, hashFile, textHash } from "../utils/hash.js";
import { normalizeAiItems } from "./recipe-items.js";

/**
 * @typedef {import("../state.js").CalaveraState} CalaveraState
 *
 * @typedef {"skill" | "hook" | "agent"} AiArtifactType
 *
 * @typedef {object} ResolvedAiArtifact
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
const CODE_RABBIT_SKILL_FILTERS = Object.freeze([
  "!.claude/skills/**",
  "!.agents/skills/**",
  "!.agents/agents/claude-code/**",
  "!.calavera/packages/**",
  "!pnpm-lock.yaml",
]);
const CODE_RABBIT_SKILL_CONFIG = `# CodeRabbit configuration — https://docs.coderabbit.ai/reference/yaml-template
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
 * @returns {Promise<{ contents: string, type: "write" | "update" } | undefined>}
 */
async function planCodeRabbitSkillConfig() {
  if (!(await fileExists(CODE_RABBIT_CONFIG_PATH))) {
    return { contents: CODE_RABBIT_SKILL_CONFIG, type: "write" };
  }

  const { isMap, isSeq, parseDocument } = await import("yaml");
  const current = await readFile(CODE_RABBIT_CONFIG_PATH, "utf8");
  const document = parseDocument(current);

  if (document.errors.length > 0) {
    throw new Error(
      `Cannot update ${CODE_RABBIT_CONFIG_PATH}: ${document.errors.map(({ message }) => message).join("; ")}`,
    );
  }

  const reviews = document.get("reviews", true);
  if (reviews === undefined) {
    document.set("reviews", {});
  } else if (!isMap(reviews)) {
    throw new Error(`Cannot update ${CODE_RABBIT_CONFIG_PATH}: reviews must be a mapping.`);
  }

  let pathFilters = document.getIn(["reviews", "path_filters"], true);
  if (pathFilters === undefined) {
    document.setIn(["reviews", "path_filters"], []);
    pathFilters = document.getIn(["reviews", "path_filters"], true);
  }
  if (!isSeq(pathFilters)) {
    throw new Error(
      `Cannot update ${CODE_RABBIT_CONFIG_PATH}: reviews.path_filters must be an array.`,
    );
  }

  const existingFilters = new Set(pathFilters.toJSON().map(String));
  for (const filter of CODE_RABBIT_SKILL_FILTERS) {
    if (!existingFilters.has(filter)) pathFilters.add(filter);
  }

  const contents = document.toString({ lineWidth: 0 });
  return contents === current ? undefined : { contents, type: "update" };
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
 * @param {{ id?: string, src: string }} item
 * @param {Map<string, string>} sourcePaths
 */
function resolveAiSourcePath(item, sourcePaths) {
  const artifact = item.id ? artifactForId(item.id) : artifactForLegacyPath(item.src);
  return (artifact && sourcePaths.get(artifact.id)) ?? sourcePaths.get(item.src) ?? item.src;
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
    return join(".agents", "skills", name);
  }

  if (!target) {
    throw new Error(`AI ${type} items require an output target.`);
  }

  if (type === "hook") {
    return join(".agents", "hooks", target, `${name}.mjs`);
  }

  if (target === CODEX_AGENT_TARGET) {
    return join(".codex", "agents", `${name}.toml`);
  }

  return join(".agents", "agents", target, `${name}.md`);
}

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
 * @param {ResolvedAiArtifact} artifact
 * @param {string} [outputRoot]
 */
async function copyAiArtifact(artifact, outputRoot) {
  const installPath = outputRoot ? resolve(outputRoot, artifact.path) : resolve(artifact.path);

  if (artifact.type === "skill") {
    await mkdir(dirname(installPath), { recursive: true });
    await rm(installPath, { force: true, recursive: true });
    await cp(artifact.sourcePath, installPath, { recursive: true });
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
    const sourceHashes =
      artifact.type === "hook"
        ? await Promise.all([
            hashFile(join(artifact.sourcePath, "hook.mjs")),
            hashFile(join(artifact.sourcePath, "settings-fragment.json")),
          ])
        : [await hashAiSource(artifact.type, artifact.sourcePath, artifact.target)];
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
      if (upToDate) continue;

      await assertSafeAiWrite(artifact, path, sourceHash, previousState);
      needsWrite = true;
      changes.push({
        type: "write",
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

  if (codeRabbitPlan) {
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
      await mkdir(dirname(configPath), { recursive: true });
      await writeFile(configPath, codeRabbitPlan.contents);
    }
  }

  return {
    artifacts: stateArtifacts,
    changes,
    pointers: [...pointerSet],
  };
}
