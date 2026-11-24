// @ts-check

// Which tarball URLs Calavera lets pacote fetch (#1194). pacote picks a fetcher from the text of the
// spec (`FetcherBase.get` in pacote/lib/fetcher.js, through npm-package-arg): a git URL runs git
// with the person's SSH agent and credential helpers, and a file URL or a path reads this machine.

// The hosts that may serve a tarball over plain http, as URL.hostname writes them. The release
// rehearsal's registry and the tests listen on loopback (owner decision on #1194).
export const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
export const TARBALL_RULE =
  "Calavera fetches artifact tarballs only from https URLs, or from http URLs on localhost, 127.0.0.1, or ::1.";
// The longest protocol a message quotes, colon included. Every protocol npm-package-arg knows is
// shorter; a longer one is registry text that the message reports as too long instead.
const MAX_PROTOCOL_LENGTH = 16;
// npm-package-arg's pattern for an scp-style git address, such as git@github.com:owner/repo
// (`isGit` in npm-package-arg/lib/npa.js), which it reads as git+ssh.
const SCP_GIT_ADDRESS = /^[^@]+@[^:.]+\.[^:]+:.+$/i;

/**
 * Refuses a tarball that pacote would fetch other than over https or loopback http.
 * `resolved` is the spec pacote reads; `fetchedUrl` is the URL it requests after it moves a
 * registry.npmjs.org tarball onto the artifact scope's registry, which extractArtifactPackage passes
 * to pacote as `registry`.
 * The error names the package and the protocol, never the rest of the URL, which is registry text.
 * @param {string} packageName
 * @param {string} resolved
 * @param {string} fetchedUrl
 */
export function assertTarballUrl(packageName, resolved, fetchedUrl) {
  const named = tarballUrlRefusal(resolved);
  const moved = named ? undefined : tarballUrlRefusal(fetchedUrl);
  const refusal = named ?? moved;
  if (!refusal) return;
  const where = moved ? " after pacote moves it onto the configured registry" : "";
  throw tarballUrlError(packageName, `its tarball URL ${refusal.reason}${where}`, refusal.protocol);
}

/**
 * Why Calavera refuses to fetch a tarball from `url`, or undefined when it may. `protocol` is null
 * when the reason quotes none.
 * @param {string} url
 * @returns {{ reason: string, protocol: string | null } | undefined}
 */
export function tarballUrlRefusal(url) {
  if (!URL.canParse(url)) {
    return SCP_GIT_ADDRESS.test(url)
      ? { reason: "is an scp-style git address", protocol: null }
      : { reason: "is not an absolute URL", protocol: null };
  }
  const { protocol, hostname } = new URL(url);
  // npm-package-arg reads a spec as a URL only when the text starts with its protocol. The URL
  // parser also accepts leading spaces and control characters, which pacote reads as a path.
  if (!url.toLowerCase().startsWith(protocol)) {
    return { reason: "does not start with its protocol", protocol: null };
  }
  if (protocol === "https:") return undefined;
  if (protocol === "http:") {
    return LOOPBACK_HOSTS.has(hostname)
      ? undefined
      : { reason: "uses http: on a host that is not loopback", protocol };
  }
  if (protocol.length > MAX_PROTOCOL_LENGTH) {
    return {
      reason: `uses a protocol longer than ${MAX_PROTOCOL_LENGTH} characters`,
      protocol: null,
    };
  }
  return { reason: `uses the protocol ${protocol}`, protocol };
}

/**
 * Turns pacote's refusal of a git spec, which `allowGit: "none"` causes, into Calavera's error.
 * An https URL on a git host, such as https://github.com/owner/repo, passes tarballUrlRefusal, but
 * npm-package-arg reads it as a git repository. pacote's error names the whole spec in `package`,
 * so it is not kept as `cause`.
 * @template T
 * @param {string} packageName
 * @param {string} resolved
 * @param {() => Promise<T>} run
 * @returns {Promise<T>}
 */
export async function withTarballRefusal(packageName, resolved, run) {
  try {
    return await run();
  } catch (error) {
    if (/** @type {{ code?: unknown }} */ (error)?.code !== "EALLOWGIT") throw error;
    throw tarballUrlError(
      packageName,
      "its tarball URL names a git repository, which Calavera does not fetch",
      new URL(resolved).protocol,
    );
  }
}

/**
 * @param {string} packageName
 * @param {string} reason
 * @param {string | null} protocol
 */
function tarballUrlError(packageName, reason, protocol) {
  return Object.assign(
    new Error(`Calavera did not fetch ${packageName}: ${reason}. ${TARBALL_RULE}`),
    { code: "EBADTARBALLURL", packageName, protocol },
  );
}
