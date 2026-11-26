// @ts-check
import { cp } from "node:fs/promises";
import { join, resolve } from "node:path";

import packageJson from "../package.json" with { type: "json" };
import { aiOutputSourceHashes, hashAiInstall } from "./ai/artifacts.js";
import { CACHE_PATH } from "./artifact-lifecycle.js";
import { createTemporaryFolder, removeTemporaryFolder } from "./utils/cleanup.js";
import { fileExists } from "./utils/fs.js";

/**
 * @typedef {object} UnrecordedFile An output of an artifact without a lock entry that already
 *   exists without a state record (ADR-0020, Decision 3 and Decision 8).
 * @property {string} path
 * @property {string | null} comparedVersion The cached version the output was compared against,
 *   or null when the artifact cache could not supply the package offline.
 * @property {boolean | null} matches Whether the output equals that version's file, or null when
 *   Calavera could not compare it.
 * @property {string | null} notCompared Why Calavera could not compare it, in its own words, with
 *   the error code when there is one, or null when it compared it. It never quotes an error's
 *   message, which can carry text from the project or the registry.
 *
 * @typedef {object} UnrecordedCandidate An artifact without a lock entry and the paths of its
 *   outputs, in the order of `aiArtifactOutputPaths`, with whether each needs a comparison.
 * @property {string} id
 * @property {"skill" | "hook" | "agent"} type
 * @property {string | undefined} target
 * @property {{ path: string, unrecorded: boolean }[]} outputs
 *
 * @typedef {import("./artifact-lifecycle.js").ArtifactRegistry} ArtifactRegistry
 */

/**
 * Compares each unrecorded output with the package the artifact cache holds for the artifact's
 * channel, `latest`, as an unlocked selection resolves. The cache is copied into the operating
 * system's temporary folder first, and only the copy is read, offline, so the registry is never
 * contacted and the project's `.calavera/cache/npm` stays byte for byte unchanged; the copy is
 * removed before the function returns, whether or not the comparison succeeds (ADR-0020,
 * Decision 3). Without a cache, or for a package the cache cannot supply, each output is listed
 * with nothing compared. A cache miss, a registry or cache error, and a package whose files cannot
 * be read all mean the cache cannot supply it; only a programming error, a TypeError or
 * ReferenceError without a code, stops the function, so it is not mistaken for a cache miss.
 *
 * @param {UnrecordedCandidate[]} candidates
 * @param {ArtifactRegistry} registry
 * @returns {Promise<Map<string, UnrecordedFile[]>>} The unrecorded outputs of each candidate that
 *   has any, by artifact ID.
 */
export async function compareUnrecordedOutputs(candidates, registry) {
  /** @type {Map<string, UnrecordedFile[]>} */
  const byId = new Map();
  const needed = candidates.filter(({ outputs }) => outputs.some(({ unrecorded }) => unrecorded));
  if (needed.length === 0) return byId;
  /** @param {UnrecordedCandidate} candidate @param {(path: string, index: number) => Promise<Omit<UnrecordedFile, "path">>} compare */
  const list = async ({ id, outputs }, compare) => {
    /** @type {UnrecordedFile[]} */
    const files = [];
    for (const [index, { path, unrecorded }] of outputs.entries()) {
      if (unrecorded) files.push({ path, ...(await compare(path, index)) });
    }
    byId.set(id, files);
  };
  /** @param {string} notCompared */
  const uncompared = (notCompared) => async () => ({
    comparedVersion: null,
    matches: null,
    notCompared,
  });

  if (!(await fileExists(CACHE_PATH))) {
    for (const candidate of needed) await list(candidate, uncompared("there is no artifact cache"));
    return byId;
  }

  // The comparison only adds notes, so no step of it may stop a doctor or change its exit status:
  // a temporary folder that cannot be made or a cache that cannot be copied leaves every output
  // uncompared, with the error code in the note (ADR-0020, Amendment 3).
  /** @type {string | undefined} */
  let temporaryRoot;
  try {
    // A folder createTemporaryFolder makes is removed even when the process is interrupted (#1081).
    temporaryRoot = await createTemporaryFolder("calavera-phase-cache-");
    const cache = join(temporaryRoot, "cache");
    // dereference, so a linked cache, or a link inside it, is copied as files, and the lookup
    // reads only the copy, never the project's cache.
    await cp(resolve(CACHE_PATH), cache, { recursive: true, dereference: true });
    for (const [index, candidate] of needed.entries()) {
      const hashes = await cachedOutputHashes(
        candidate,
        cache,
        join(temporaryRoot, `${index}`),
        registry,
      );
      if ("notCompared" in hashes) {
        await list(candidate, uncompared(hashes.notCompared));
        continue;
      }
      await list(candidate, (path, outputIndex) =>
        outputComparison(candidate, path, hashes.version, hashes.outputs[outputIndex]),
      );
    }
  } catch (error) {
    // Only a file-system error, which has a code, means the copy failed; anything else is a bug.
    if (!hasCode(error)) throw error;
    const code = /** @type {{ code: string }} */ (error).code;
    for (const candidate of needed) {
      if (!byId.has(candidate.id)) {
        await list(candidate, uncompared(`Calavera could not copy the artifact cache (${code})`));
      }
    }
  } finally {
    if (temporaryRoot !== undefined) {
      // A folder that cannot be removed now is still removed when the process exits, because
      // createTemporaryFolder registered it, so the comparison it served is kept.
      await removeTemporaryFolder(temporaryRoot).catch(() => {});
    }
  }
  return byId;
}

/**
 * The cached version of the candidate's package and the hash of each output it would install, or
 * why the cache cannot supply the package offline: the error code for a cache miss or a registry or
 * file error, and a phrase of its own for a package Calavera refuses, such as one whose identity
 * does not match its metadata, so a tampered cache does not read like a cache miss.
 *
 * @param {UnrecordedCandidate} candidate
 * @param {string} cache The copy of the project's cache.
 * @param {string} stage An empty folder inside the temporary root.
 * @param {ArtifactRegistry} registry
 * @returns {Promise<{ version: string, outputs: string[] } | { notCompared: string }>}
 */
async function cachedOutputHashes({ id, type, target }, cache, stage, registry) {
  try {
    const resolution = await registry.resolve({ id, tag: "latest", cache, offline: true });
    const { payloadPath } = await registry.extract(resolution, stage, packageJson.version);
    return {
      version: resolution.version,
      outputs: await aiOutputSourceHashes(type, payloadPath, target),
    };
  } catch (error) {
    if (isProgrammingError(error)) throw error;
    return {
      notCompared: hasCode(error)
        ? `the artifact cache cannot supply it offline (${/** @type {{ code: string }} */ (error).code})`
        : "Calavera refused the package the artifact cache holds",
    };
  }
}

/**
 * Whether the installed output equals the package's. An output that cannot be read, such as a
 * folder where a file belongs, keeps the version it would have been compared with, and says why it
 * was not, by its error code, never by the file's text.
 *
 * @param {UnrecordedCandidate} candidate
 * @param {string} path
 * @param {string} version
 * @param {string | undefined} expected Always present: the payload has a hash for each output.
 * @returns {Promise<Omit<UnrecordedFile, "path">>}
 */
async function outputComparison({ type, target }, path, version, expected) {
  try {
    const matches = (await hashAiInstall(type, path, target)) === expected;
    return { comparedVersion: version, matches, notCompared: null };
  } catch (error) {
    if (!hasCode(error)) throw error;
    const code = /** @type {{ code: string }} */ (error).code;
    return { comparedVersion: version, matches: null, notCompared: `it cannot be read (${code})` };
  }
}

/** @param {unknown} error */
function hasCode(error) {
  return typeof (/** @type {{ code?: unknown }} */ (error)?.code) === "string";
}

/**
 * A TypeError or ReferenceError without a code comes from a bug, not from npm or the file system,
 * which give their errors a code.
 *
 * @param {unknown} error
 */
function isProgrammingError(error) {
  return (error instanceof TypeError || error instanceof ReferenceError) && !hasCode(error);
}
