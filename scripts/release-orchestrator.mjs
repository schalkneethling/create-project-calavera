import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import semver from "semver";

const root = fileURLToPath(new URL("..", import.meta.url));
const repository = "schalkneethling/create-project-calavera";
const baseBranch = "main";
const workflow = "publish.yml";
const publishEnvironment = "publish";
const placeholderVersion = "0.0.0";
const usage = "Usage: release-orchestrator.mjs <prepare|publish> [--tag <tag>] [--yes]";

export class ReleaseError extends Error {}

function commandText(command, args) {
  return [command, ...args].join(" ");
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: process.env,
    stdio: options.capture ? "pipe" : "inherit",
    maxBuffer: 20 * 1024 * 1024,
  });

  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    throw new ReleaseError(`${commandText(command, args)} failed with exit code ${result.status}.`);
  }
  return {
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function capture(command, args, options = {}) {
  return run(command, args, { ...options, capture: true }).stdout.trim();
}

function runQuiet(command, args, options = {}) {
  const result = run(command, args, { ...options, capture: true, allowFailure: true });
  if (result.status !== 0) {
    throw new ReleaseError(
      `${commandText(command, args)} failed with exit code ${result.status}.\n${result.stderr || result.stdout}`,
    );
  }
  return result;
}

function captureJson(command, args, options = {}) {
  const output = capture(command, args, options);
  try {
    return JSON.parse(output);
  } catch {
    throw new ReleaseError(`${commandText(command, args)} did not return valid JSON.`);
  }
}

export function isExplicitRegistryNotFound(result) {
  return (
    result.status !== 0 && /(^|\s)(E404|404)(\s|$)/m.test(`${result.stdout}\n${result.stderr}`)
  );
}

export function releaseChannel(version) {
  if (!semver.valid(version)) throw new ReleaseError(`Invalid package version: ${version}.`);
  return semver.prerelease(version) ? "next" : "latest";
}

export function releaseTag(packages, sha) {
  const cli = packages.find(({ name }) => name === "create-project-calavera");
  return cli ? `v${cli.version}` : `packages-${sha.slice(0, 12)}`;
}

export function hasPendingVersionBumps(output) {
  return output
    .split("\n")
    .some(
      (line) =>
        /Packages to be bumped at (patch|minor|major):/i.test(line) &&
        !/NO packages to be bumped/i.test(line),
    );
}

export function validateReleaseMetadata(metadata, expected) {
  if (metadata.tagName !== expected.tag) {
    throw new ReleaseError(`Release tag ${metadata.tagName} does not match ${expected.tag}.`);
  }
  if (metadata.targetCommitish !== expected.sha) {
    throw new ReleaseError(
      `Release target ${metadata.targetCommitish} does not match ${expected.sha}.`,
    );
  }
  if (metadata.isPrerelease !== expected.prerelease) {
    throw new ReleaseError("Release prerelease state does not match the package versions.");
  }
  if (expected.draft !== undefined && metadata.isDraft !== expected.draft) {
    throw new ReleaseError("Release draft state is not what the current transition requires.");
  }
}

function parseWorkspacePatterns(source) {
  return [...source.matchAll(/^\s*-\s+["']?([^"'\s]+)["']?\s*$/gm)].map(([, pattern]) => pattern);
}

async function expandWorkspacePattern(pattern) {
  if (!pattern.endsWith("/*")) return [pattern];
  const parent = pattern.slice(0, -2);
  return (await readdir(join(root, parent), { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(parent, entry.name));
}

export async function discoverPublicPackages() {
  const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
  const paths = [];
  for (const pattern of parseWorkspacePatterns(workspace)) {
    paths.push(...(await expandWorkspacePattern(pattern)));
  }

  const packages = [];
  for (const path of new Set(paths)) {
    const manifestPath = join(root, path, "package.json");
    try {
      if (!(await stat(manifestPath)).isFile()) continue;
    } catch {
      continue;
    }
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    if (manifest.private === true || !manifest.name || !manifest.version) continue;
    packages.push({
      name: manifest.name,
      version: manifest.version,
      path,
      channel: releaseChannel(manifest.version),
    });
  }
  return packages.sort((left, right) => left.name.localeCompare(right.name));
}

function registryQuery(args) {
  return run("npm", ["view", ...args], { capture: true, allowFailure: true });
}

function requireRegistryJson(result, description) {
  if (result.status !== 0) {
    throw new ReleaseError(
      `${description} failed for a reason other than an explicit missing-version response:\n${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ReleaseError(`${description} returned malformed JSON.`);
  }
}

export async function registryPlan(packages) {
  const planned = [];
  for (const pkg of packages) {
    const exact = registryQuery([`${pkg.name}@${pkg.version}`, "version", "--json"]);
    if (exact.status === 0) {
      planned.push({ ...pkg, published: true, packageExists: true });
      continue;
    }
    if (!isExplicitRegistryNotFound(exact)) {
      requireRegistryJson(exact, `Exact registry lookup for ${pkg.name}@${pkg.version}`);
    }

    const versionsResult = registryQuery([pkg.name, "versions", "--json"]);
    if (isExplicitRegistryNotFound(versionsResult)) {
      planned.push({
        ...pkg,
        published: false,
        packageExists: false,
        tagsBefore: {},
      });
      continue;
    }
    requireRegistryJson(versionsResult, `Package registry lookup for ${pkg.name}`);
    const tagsBefore = requireRegistryJson(
      registryQuery([pkg.name, "dist-tags", "--json"]),
      `Dist-tag lookup for ${pkg.name}`,
    );
    planned.push({
      ...pkg,
      published: false,
      packageExists: true,
      tagsBefore,
    });
  }
  return planned;
}

async function planPublicPackages() {
  return registryPlan(await discoverPublicPackages());
}

function assertCleanCandidate() {
  const branch = capture("git", ["branch", "--show-current"]);
  if (branch !== baseBranch) {
    throw new ReleaseError(`Release preparation must run from ${baseBranch}; found ${branch}.`);
  }
  if (capture("git", ["status", "--porcelain"])) {
    throw new ReleaseError("Release preparation requires a clean working tree.");
  }

  run("git", ["fetch", "origin", baseBranch]);
  const sha = capture("git", ["rev-parse", "HEAD"]);
  const remoteSha = capture("git", ["rev-parse", `origin/${baseBranch}`]);
  if (sha !== remoteSha) {
    throw new ReleaseError(
      `Local ${baseBranch} ${sha} does not match origin/${baseBranch} ${remoteSha}.`,
    );
  }
  return sha;
}

function assertCandidateUnchanged(sha) {
  if (capture("git", ["rev-parse", "HEAD"]) !== sha || capture("git", ["status", "--porcelain"])) {
    throw new ReleaseError(
      "A release gate changed the candidate. Restart from the first gate after reviewing the change.",
    );
  }
}

export const releaseGates = [
  ["pnpm", ["install", "--frozen-lockfile"]],
  ["pnpm", ["baseline:check"]],
  ["pnpm", ["release:rehearse"]],
  ["pnpm", ["workflow:check"]],
];

function runGates(sha) {
  for (const [command, args] of releaseGates) {
    run(command, args);
    assertCandidateUnchanged(sha);
  }

  const status = run("pnpm", ["release:status"], { capture: true });
  process.stdout.write(status.stdout);
  if (hasPendingVersionBumps(status.stdout)) {
    throw new ReleaseError(
      "Changesets still has packages to version; merge the generated version PR first.",
    );
  }
  assertCandidateUnchanged(sha);
}

function printPlan(plan) {
  console.info(`\nRelease candidate: ${plan.sha}`);
  console.info("Packages absent from npm:");
  for (const pkg of plan.packages.filter(({ published }) => !published)) {
    console.info(`- ${pkg.name}@${pkg.version} -> ${pkg.channel}`);
  }
  console.info("Packages already published:");
  for (const pkg of plan.packages.filter(({ published }) => published)) {
    console.info(`- ${pkg.name}@${pkg.version}`);
  }
}

async function confirm(expected, assumeYes) {
  if (assumeYes) return;
  if (!process.stdin.isTTY) {
    throw new ReleaseError(
      `Interactive confirmation required. Re-run with --yes to confirm ${expected}.`,
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await prompt.question(`Type "${expected}" to continue: `);
  prompt.close();
  if (answer !== expected) throw new ReleaseError("Release transition cancelled.");
}

export function fledglingArgs(packageNames, dryRun) {
  return [
    "exec",
    "fledgling",
    "add",
    ...packageNames,
    dryRun ? "--dry-run" : "--yes",
    "--repo",
    repository,
    "--workflow",
    workflow,
    "--env",
    publishEnvironment,
    "--permissions",
    "publish",
    "--placeholder-version",
    placeholderVersion,
  ];
}

export function fledglingCommand(packageNames, dryRun) {
  return commandText("pnpm", fledglingArgs(packageNames, dryRun));
}

function assertPackagesMinted(packages) {
  const names = packages.filter(({ packageExists }) => !packageExists).map(({ name }) => name);
  if (names.length === 0) return;
  throw new ReleaseError(
    [
      `New package names must be minted on npm by hand before a release: ${names.join(", ")}.`,
      "Review the Fledgling plan, then apply it (Fledgling requires npm 11.15.0 or newer):",
      "",
      `  ${fledglingCommand(names, true)}`,
      `  ${fledglingCommand(names, false)}`,
      "",
      `The first release of each minted package must be a stable version so it replaces the ${placeholderVersion} placeholder on latest.`,
      "Then rerun pnpm release:prepare.",
    ].join("\n"),
  );
}

function assertStableAfterPlaceholder(packages) {
  const prereleases = packages.filter(
    ({ published, tagsBefore, version }) =>
      !published &&
      tagsBefore?.latest === placeholderVersion &&
      semver.prerelease(version) !== null,
  );
  if (prereleases.length === 0) return;
  throw new ReleaseError(
    `${prereleases.map(({ name, version }) => `${name}@${version}`).join(", ")} would be the first real release of a minted package. It must be stable so it replaces the ${placeholderVersion} placeholder on latest. Version it as a stable release outside Changesets prerelease mode, then rerun pnpm release:prepare.`,
  );
}

export async function prepareRelease(options = {}) {
  const sha = (options.assertCleanCandidate ?? assertCleanCandidate)();
  const packages = await (options.planPackages ?? planPublicPackages)();
  assertPackagesMinted(packages);
  assertStableAfterPlaceholder(packages);
  (options.runGates ?? runGates)(sha);
  const plan = { sha, packages };
  printPlan(plan);
  if (!options.allowPublished && packages.every(({ published }) => published)) {
    throw new ReleaseError("Every local public package version is already published.");
  }
  return plan;
}

function releaseMetadata(tag) {
  const result = run(
    "gh",
    [
      "release",
      "view",
      tag,
      "--repo",
      repository,
      "--json",
      "url,tagName,targetCommitish,name,body,isDraft,isPrerelease,publishedAt",
    ],
    { capture: true, allowFailure: true },
  );
  if (result.status !== 0) {
    if (/release not found|HTTP 404/i.test(`${result.stdout}\n${result.stderr}`)) return undefined;
    throw new ReleaseError(
      `GitHub release lookup for ${tag} failed:\n${result.stderr || result.stdout}`,
    );
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new ReleaseError(`GitHub release lookup for ${tag} returned malformed JSON.`);
  }
}

function createDraft(plan, tag) {
  const candidates = plan.packages.filter(({ published }) => !published);
  const prerelease = candidates.some(({ channel }) => channel === "next");
  const notes = [
    "Packages:",
    ...candidates.map(({ name, version }) => `- ${name}@${version}`),
  ].join("\n");
  run("gh", [
    "release",
    "create",
    tag,
    "--repo",
    repository,
    "--target",
    plan.sha,
    "--title",
    `Calavera ${tag}`,
    "--notes",
    notes,
    "--draft",
    ...(prerelease ? ["--prerelease"] : []),
  ]);
  const metadata = releaseMetadata(tag);
  if (!metadata) throw new ReleaseError(`Draft release ${tag} was not created.`);
  validateReleaseMetadata(metadata, {
    tag,
    sha: plan.sha,
    draft: true,
    prerelease,
  });
  return { metadata, prerelease };
}

export function packagesFromReleaseNotes(plan, body) {
  const identities = new Set(
    [...body.matchAll(/^- (.+)@([^@\s]+)$/gm)].map(([, name, version]) => `${name}@${version}`),
  );
  return plan.packages
    .filter(({ name, version }) => identities.has(`${name}@${version}`))
    .map((pkg) => ({ ...pkg, published: false }));
}

function listWorkflowRuns() {
  return captureJson("gh", [
    "run",
    "list",
    "--repo",
    repository,
    "--workflow",
    workflow,
    "--event",
    "release",
    "--limit",
    "20",
    "--json",
    "databaseId,headSha,headBranch,status,conclusion,url",
  ]);
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => {
    setTimeout(resolveDelay, milliseconds);
  });
}

export async function waitForRun(tag, sha, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? 5000;
  const timeoutMs = options.timeoutMs ?? 300000;
  const attempts = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const getRuns = options.getRuns ?? listWorkflowRuns;
  const wait = options.delay ?? delay;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const runs = getRuns();
    const selected = runs.find((run) => run.headSha === sha && run.headBranch === tag);
    if (selected) return selected;
    if (attempt < attempts - 1) await wait(pollIntervalMs);
  }
  throw new ReleaseError(`No ${workflow} run appeared for ${tag} at ${sha}.`);
}

// npm's own publish output warns a fresh version "may take a few minutes to become available";
// these delays give `npm view` that same window before treating an explicit 404 as a real failure.
export const NPM_VIEW_RETRY_DELAYS_MS = [5000, 10000, 20000, 30000, 30000, 30000];

function defaultViewNpm(args) {
  return run("npm", ["view", ...args], { capture: true, allowFailure: true });
}

export async function npmViewWithRetry(args, options = {}) {
  const wait = options.delay ?? delay;
  const delays = options.delays ?? NPM_VIEW_RETRY_DELAYS_MS;
  const viewNpm = options.viewNpm ?? defaultViewNpm;
  const report = options.report ?? console.info;

  for (let attempt = 0; ; attempt += 1) {
    const result = viewNpm(args);
    if (result.status === 0) return result.stdout.trim();
    if (!isExplicitRegistryNotFound(result)) {
      throw new ReleaseError(
        `${commandText("npm", ["view", ...args])} failed with exit code ${result.status}.`,
      );
    }
    if (attempt >= delays.length) {
      const totalSeconds = Math.round(delays.reduce((total, ms) => total + ms, 0) / 1000);
      throw new ReleaseError(
        `npm view ${args.join(" ")} still reports the version missing after ${delays.length} retries over ~${totalSeconds}s. npm warns a fresh publish "may take a few minutes to become available" — wait a few minutes and re-run pnpm release:publish; already-published packages are skipped.`,
      );
    }
    const waitSeconds = Math.round(delays[attempt] / 1000);
    report(
      `Waiting ${waitSeconds}s for npm view ${args.join(" ")} (attempt ${attempt + 1} of ${delays.length}).`,
    );
    await wait(delays[attempt]);
  }
}

export async function verifyPublishedPackages(plan, runId, options = {}) {
  const candidates = plan.packages.filter(({ published }) => !published);
  const readLog =
    options.readLog ??
    (() => capture("gh", ["run", "view", String(runId), "--repo", repository, "--log"]));
  const log = readLog();
  const provenanceCount = log.match(/Signed provenance statement/g)?.length ?? 0;
  if (provenanceCount < candidates.length) {
    throw new ReleaseError(
      `Publish log contains ${provenanceCount} provenance statements for ${candidates.length} packages.`,
    );
  }
  for (const pkg of candidates) {
    if (!log.includes(`+ ${pkg.name}@${pkg.version}`)) {
      throw new ReleaseError(`Publish log does not confirm ${pkg.name}@${pkg.version}.`);
    }
    const versionRaw = await npmViewWithRetry(
      [`${pkg.name}@${pkg.version}`, "version", "--json"],
      options,
    );
    let version;
    try {
      version = JSON.parse(versionRaw);
    } catch {
      throw new ReleaseError(
        `npm view ${pkg.name}@${pkg.version} version --json returned malformed JSON.`,
      );
    }
    if (version !== pkg.version) {
      throw new ReleaseError(`Registry did not return ${pkg.name}@${pkg.version}.`);
    }
    const tagsRaw = await npmViewWithRetry([pkg.name, "dist-tags", "--json"], options);
    let tags;
    try {
      tags = JSON.parse(tagsRaw);
    } catch {
      throw new ReleaseError(`npm view ${pkg.name} dist-tags --json returned malformed JSON.`);
    }
    if (tags[pkg.channel] !== pkg.version) {
      throw new ReleaseError(`${pkg.name} ${pkg.channel} does not point to ${pkg.version}.`);
    }
    if (pkg.channel === "next" && pkg.tagsBefore?.latest && tags.latest !== pkg.tagsBefore.latest) {
      throw new ReleaseError(`${pkg.name} latest changed during a prerelease.`);
    }
  }
}

async function smokePublishedArtifacts(plan) {
  const cli = plan.packages.find(({ name }) => name === "create-project-calavera");
  if (!cli) throw new ReleaseError("The workspace does not expose create-project-calavera.");
  runQuiet("npx", [
    "--yes",
    "--package",
    `${cli.name}@${cli.version}`,
    "create-project-calavera",
    "--help",
  ]);
  console.info(`Smoke-tested npx create-project-calavera@${cli.version} --help.`);

  const candidateArtifact = plan.packages.find(
    ({ published, path }) => !published && path.startsWith("packages/artifacts/"),
  );
  if (!candidateArtifact) return;
  const manifest = JSON.parse(
    await readFile(join(root, candidateArtifact.path, "calavera-artifact.json"), "utf8"),
  );
  const directory = await mkdtemp(join(tmpdir(), "calavera-release-smoke-"));
  try {
    await writeFile(
      join(directory, "package.json"),
      `${JSON.stringify({ name: basename(directory), private: true }, null, 2)}\n`,
    );
    await writeFile(
      join(directory, "calavera.config.json"),
      `${JSON.stringify(
        {
          version: 1,
          profile: "minimal",
          packageManager: "npm",
          integrations: [],
          ai: [{ id: manifest.id }],
          scripts: {},
        },
        null,
        2,
      )}\n`,
    );
    runQuiet(
      "npx",
      [
        "--yes",
        "--package",
        `${cli.name}@${cli.version}`,
        "create-project-calavera",
        "artifacts",
        "install",
        "--tag",
        candidateArtifact.channel,
        "--yes",
      ],
      { cwd: directory },
    );
    console.info(
      `Smoke-tested artifacts install for ${manifest.id}@${candidateArtifact.version} into a disposable fixture.`,
    );
    const lock = JSON.parse(
      await readFile(join(directory, ".calavera", "artifacts.lock.json"), "utf8"),
    );
    const installed = lock.artifacts.find(({ id }) => id === manifest.id);
    if (installed?.version !== candidateArtifact.version) {
      throw new ReleaseError(
        `Consumer smoke installed ${installed?.version ?? "nothing"} instead of ${candidateArtifact.version}.`,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function publishRelease(options = {}) {
  const plan = await prepareRelease({ ...options, allowPublished: true });
  const candidates = plan.packages.filter(({ published }) => !published);
  const tag =
    options.tag ?? releaseTag(candidates.length > 0 ? candidates : plan.packages, plan.sha);
  let metadata = releaseMetadata(tag);
  const prerelease =
    candidates.length === 0 && metadata
      ? metadata.isPrerelease
      : candidates.some(({ channel }) => channel === "next");
  if (!metadata) {
    ({ metadata } = createDraft(plan, tag));
  } else {
    validateReleaseMetadata(metadata, {
      tag,
      sha: plan.sha,
      prerelease,
    });
  }
  if (!metadata.isDraft) {
    if (candidates.length > 0) {
      throw new ReleaseError(
        `Release ${tag} is already published, but expected versions remain absent from npm.`,
      );
    }
    const releasedPackages = packagesFromReleaseNotes(plan, metadata.body ?? "");
    if (releasedPackages.length === 0) {
      throw new ReleaseError(
        `Release ${tag} is published, but its notes do not contain a verifiable package inventory.`,
      );
    }
    const releasedIdentities = new Set(
      releasedPackages.map(({ name, version }) => `${name}@${version}`),
    );
    const verificationPlan = {
      ...plan,
      packages: plan.packages.map((pkg) =>
        releasedIdentities.has(`${pkg.name}@${pkg.version}`) ? { ...pkg, published: false } : pkg,
      ),
    };
    const workflowRun = await waitForRun(tag, plan.sha);
    await verifyPublishedPackages(verificationPlan, workflowRun.databaseId);
    await smokePublishedArtifacts(verificationPlan);
    console.info(`Release ${tag} and its package inventory are already published and verified.`);
    return plan;
  }

  console.info(`Verified draft: ${metadata.url}`);
  await confirm(`publish ${tag}`, options.yes);
  run("gh", [
    "release",
    "edit",
    tag,
    "--repo",
    repository,
    "--draft=false",
    ...(prerelease ? ["--prerelease=true"] : ["--latest"]),
  ]);

  const workflowRun = await waitForRun(tag, plan.sha);
  console.info(`Watching ${workflowRun.url}`);
  run("gh", [
    "run",
    "watch",
    String(workflowRun.databaseId),
    "--repo",
    repository,
    "--exit-status",
    "--interval",
    "10",
  ]);
  await verifyPublishedPackages(plan, workflowRun.databaseId);
  await smokePublishedArtifacts(plan);
  assertCandidateUnchanged(plan.sha);
  console.info(`Release ${tag} is published and verified.`);
}

export function parseOptions(args) {
  const options = { yes: false };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    // pnpm passes the `--` separator from `pnpm release:publish -- --yes` through to the script.
    if (arg === "--") continue;
    if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--tag") {
      const tag = args[index + 1];
      if (!tag || tag.startsWith("--")) {
        throw new ReleaseError("--tag requires a following value.");
      }
      options.tag = tag;
      index += 1;
    } else {
      throw new ReleaseError(`Unknown option ${arg}. ${usage}`);
    }
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command === "prepare") return prepareRelease(options);
  if (command === "publish") return publishRelease(options);
  throw new ReleaseError(usage);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
