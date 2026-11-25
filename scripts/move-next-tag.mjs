// Moves a package's npm `next` dist-tag to a stable release, so `next` is never older than
// `latest` (owner decision on #993, implemented in #1126). The publish job in
// .github/workflows/publish.yml runs this once per tarball, after `npm publish` or after it skips
// an already published version. That job checks out only this file and installs no dependencies,
// so this file imports only Node.js built-ins and compares versions itself; move-next-tag.test.mjs
// holds that comparison to the semver package.
//
//   node move-next-tag.mjs <package> <version> <published|skipped>
//
// Exit code 0 means next now points to the version or was correctly left alone; 1 means the tag
// may still trail latest, and the printed line says why and what to run.
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const usage = "Usage: move-next-tag.mjs <package> <version> <published|skipped>";
const publishStates = new Set(["published", "skipped"]);

// The pattern from https://semver.org/#is-there-a-suggested-regular-expression-regex-to-check-a-semver-string
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

function parse(version) {
  const match = typeof version === "string" ? semverPattern.exec(version) : null;
  if (!match) return undefined;
  const [, major, minor, patch, prerelease] = match;
  return { core: [BigInt(major), BigInt(minor), BigInt(patch)], prerelease };
}

// Returns -1, 0, or 1 as `version` sorts below, equal to, or above the stable version `stable`,
// or undefined when either is not a semantic version. Against a stable version, a prerelease
// sorts below its own major.minor.patch, so prerelease identifiers never need comparing.
export function compareWithStable(version, stable) {
  const left = parse(version);
  const right = parse(stable);
  if (!left || !right || right.prerelease !== undefined) return undefined;
  for (let index = 0; index < 3; index += 1) {
    const difference = left.core[index] - right.core[index];
    if (difference !== 0n) return difference < 0n ? -1 : 1;
  }
  return left.prerelease === undefined ? 0 : -1;
}

export function planNextTag({ version, state, tags }) {
  const parsed = parse(version);
  if (!parsed) return { action: "fail", reason: `${version} is not a semantic version` };
  if (!publishStates.has(state)) {
    return { action: "fail", reason: `unknown publish state ${state}` };
  }
  if (parsed.prerelease !== undefined) {
    return {
      action: "keep",
      reason: `${version} is a prerelease, which npm publish --tag next already tagged`,
    };
  }
  // A version this run published went out with --tag latest. A registry read straight after the
  // publish can still show the previous latest, so trust the publish instead.
  const latest = state === "published" ? version : tags.latest;
  if (latest !== version) {
    return {
      action: "keep",
      reason: `latest is ${latest ?? "missing"}, not ${version}, so moving next to ${version} would put it behind latest`,
    };
  }
  if (tags.next === undefined) return { action: "move" };
  const order = compareWithStable(tags.next, version);
  if (order === undefined) {
    return { action: "fail", reason: `next is ${tags.next}, which is not a semantic version` };
  }
  if (order > 0)
    return { action: "keep", reason: `next ${tags.next} is already ahead of ${version}` };
  if (order === 0) return { action: "keep", reason: `next already points to ${version}` };
  return { action: "move" };
}

// npm's own error output goes to the job log through the inherited stderr, so these messages name
// only the command and its exit code.
function defaultRunNpm(args) {
  const result = spawnSync("npm", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (result.error) {
    const code = "code" in result.error ? result.error.code : "unknown error";
    return { status: 1, stdout: "", startError: String(code) };
  }
  return { status: result.status ?? 1, stdout: result.stdout ?? "" };
}

function failure(result) {
  return result.startError
    ? `could not start npm (${result.startError})`
    : `exited with ${result.status}`;
}

export function moveNextTag(args, options = {}) {
  const runNpm = options.runNpm ?? defaultRunNpm;
  const report = options.report ?? console.info;
  if (args.length !== 3) {
    report(usage);
    return 1;
  }
  const [name, version, state] = args;

  // Invalid input and prereleases are decided without the registry, so they never read it.
  const parsed = parse(version);
  if (!parsed || parsed.prerelease !== undefined || !publishStates.has(state)) {
    const plan = planNextTag({ version, state, tags: {} });
    const verb = plan.action === "fail" ? "Could not move" : "Kept";
    report(`${verb} next for ${name}: ${plan.reason}.`);
    return plan.action === "fail" ? 1 : 0;
  }

  const viewArgs = ["view", "--prefer-online", name, "dist-tags", "--json"];
  const view = runNpm(viewArgs);
  let tags;
  try {
    if (view.status !== 0) throw new Error(failure(view));
    tags = JSON.parse(view.stdout);
    if (tags === null || typeof tags !== "object") throw new Error("returned no object");
  } catch (error) {
    report(
      `Could not read the dist-tags of ${name}: npm ${viewArgs.join(" ")} ${error instanceof SyntaxError ? "returned malformed JSON" : error instanceof Error ? error.message : String(error)}. npm's own output above names the cause. next was not changed.`,
    );
    return 1;
  }

  const plan = planNextTag({ version, state, tags });
  if (plan.action === "keep") {
    report(`Kept next for ${name}: ${plan.reason}.`);
    return 0;
  }
  if (plan.action === "fail") {
    report(
      `Could not move next for ${name}: ${plan.reason}. Check it with npm view ${name} dist-tags --json.`,
    );
    return 1;
  }

  const addArgs = ["dist-tag", "add", `${name}@${version}`, "next"];
  const added = runNpm(addArgs);
  if (added.status !== 0) {
    report(
      [
        `Could not move next for ${name} to ${version}: npm ${addArgs.join(" ")} ${failure(added)}. npm's own output above shows its error.`,
        `The usual cause is that Allow npm dist-tag is not enabled on the package's trusted publisher on npmjs.com, and npm may report that only as an authentication error. Changing a dist-tag through trusted publishing also needs npm CLI 11.21.0 or later, or 12.2.0 or later.`,
        `Enable it, then rerun the failed publish job, or run npm ${addArgs.join(" ")} from a terminal logged in to npm as a package owner. See "Move a stale next tag" in docs/release-runbook.md.`,
      ].join("\n"),
    );
    return 1;
  }
  report(`Moved next for ${name} from ${tags.next ?? "(none)"} to ${version}.`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = moveNextTag(process.argv.slice(2));
}
