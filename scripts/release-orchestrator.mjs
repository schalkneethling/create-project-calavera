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

function runGates(sha) {
  for (const [command, args] of [
    ["pnpm", ["install", "--frozen-lockfile"]],
    ["pnpm", ["release:rehearse"]],
    ["pnpm", ["workflow:check"]],
  ]) {
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

function fledglingArgs(packageNames, dryRun) {
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
    "0.0.0",
    "--tag",
    "bootstrap",
  ];
}

export function hasExpectedTrust(response) {
  const entries = Array.isArray(response) ? response : [response];
  return entries.some(
    (entry) =>
      entry?.type === "github" &&
      entry.file === workflow &&
      entry.repository === repository &&
      entry.environment === publishEnvironment &&
      Array.isArray(entry.permissions) &&
      entry.permissions.includes("createPackage"),
  );
}

function verifyTrust(packageName) {
  const response = captureJson("npm", ["trust", "list", packageName, "--json"]);
  if (!hasExpectedTrust(response)) {
    throw new ReleaseError(
      `Trusted publisher for ${packageName} does not match the required GitHub workflow, repository, environment, and publish permission.`,
    );
  }
}

async function bootstrapNewPackages(plan, options) {
  const newPackages = plan.packages.filter(({ packageExists }) => !packageExists);
  if (newPackages.length === 0) return { plan, bootstrapped: false };

  const npmVersion = capture("npm", ["--version"]).split(".").map(Number);
  if (npmVersion[0] < 11 || (npmVersion[0] === 11 && npmVersion[1] < 15)) {
    throw new ReleaseError("Fledgling requires npm 11.15.0 or newer.");
  }
  const names = newPackages.map(({ name }) => name);
  run("pnpm", fledglingArgs(names, true));
  if (!options.bootstrap) {
    throw new ReleaseError(
      `New package names require a reviewed bootstrap. Re-run pnpm release:prepare -- --bootstrap after reviewing the Fledgling plan.`,
    );
  }
  if (newPackages.some(({ version }) => semver.prerelease(version) !== null)) {
    throw new ReleaseError(
      "Bootstrap new package names before prerelease versioning so a real stable initial version can replace npm's mandatory latest placeholder.",
    );
  }
  const otherMissing = plan.packages.filter(
    ({ published, packageExists }) => !published && packageExists,
  );
  if (otherMissing.length > 0) {
    throw new ReleaseError(
      "Refusing package bootstrap while existing packages also have unpublished versions.",
    );
  }

  await confirm(`bootstrap ${names.join(",")}`, options.yes);
  run("pnpm", fledglingArgs(names, false));
  for (const name of names) verifyTrust(name);

  const tag = `packages-bootstrap-${plan.sha.slice(0, 12)}`;
  let metadata = releaseMetadata(tag);
  if (!metadata) {
    ({ metadata } = createDraft(plan, tag, true));
  } else {
    validateReleaseMetadata(metadata, {
      tag,
      sha: plan.sha,
      prerelease: true,
    });
  }
  if (!metadata.isDraft) {
    throw new ReleaseError(
      `Bootstrap release ${tag} already exists, but the package names still appear absent.`,
    );
  }

  run("gh", ["release", "edit", tag, "--repo", repository, "--draft=false", "--prerelease=true"]);
  const workflowRun = await waitForRun(tag, plan.sha);
  console.info(`Watching bootstrap publication ${workflowRun.url}`);
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
  verifyPublishedPackages(plan, workflowRun.databaseId);

  for (const pkg of newPackages) {
    run("npm", ["dist-tag", "rm", pkg.name, "bootstrap"]);
    const tags = captureJson("npm", ["view", pkg.name, "dist-tags", "--json"]);
    if (tags.latest !== pkg.version || tags.bootstrap) {
      throw new ReleaseError(`Bootstrap tags for ${pkg.name} were not finalized safely.`);
    }
  }

  assertCandidateUnchanged(plan.sha);
  runGates(plan.sha);
  const refreshed = {
    sha: plan.sha,
    packages: await registryPlan(await discoverPublicPackages()),
  };
  printPlan(refreshed);
  return { plan: refreshed, bootstrapped: true };
}

export async function prepareRelease(options = {}) {
  const sha = assertCleanCandidate();
  runGates(sha);
  const packages = await registryPlan(await discoverPublicPackages());
  let plan = { sha, packages };
  printPlan(plan);
  const bootstrap = await bootstrapNewPackages(plan, options);
  plan = bootstrap.plan;
  if (
    !options.allowPublished &&
    !bootstrap.bootstrapped &&
    plan.packages.every(({ published }) => published)
  ) {
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

function createDraft(plan, tag, prereleaseOverride) {
  const candidates = plan.packages.filter(({ published }) => !published);
  const prerelease = prereleaseOverride ?? candidates.some(({ channel }) => channel === "next");
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

function verifyPublishedPackages(plan, runId) {
  const candidates = plan.packages.filter(({ published }) => !published);
  const log = capture("gh", ["run", "view", String(runId), "--repo", repository, "--log"]);
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
    const version = capture("npm", ["view", `${pkg.name}@${pkg.version}`, "version", "--json"]);
    if (JSON.parse(version) !== pkg.version) {
      throw new ReleaseError(`Registry did not return ${pkg.name}@${pkg.version}.`);
    }
    const tags = captureJson("npm", ["view", pkg.name, "dist-tags", "--json"]);
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
  run("npx", [
    "--yes",
    "--package",
    `${cli.name}@${cli.version}`,
    "create-project-calavera",
    "--help",
  ]);

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
    run(
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
    verifyPublishedPackages(verificationPlan, workflowRun.databaseId);
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
  verifyPublishedPackages(plan, workflowRun.databaseId);
  await smokePublishedArtifacts(plan);
  assertCandidateUnchanged(plan.sha);
  console.info(`Release ${tag} is published and verified.`);
}

export function parseOptions(args) {
  const options = {
    yes: args.includes("--yes"),
    bootstrap: args.includes("--bootstrap"),
  };
  const tagIndex = args.indexOf("--tag");
  if (tagIndex !== -1) {
    const tag = args[tagIndex + 1];
    if (!tag || tag.startsWith("--")) {
      throw new ReleaseError("--tag requires a following value.");
    }
    options.tag = tag;
  }
  return options;
}

export async function main(args = process.argv.slice(2)) {
  const [command, ...rest] = args;
  const options = parseOptions(rest);
  if (command === "prepare") return prepareRelease(options);
  if (command === "publish") return publishRelease(options);
  throw new ReleaseError(
    "Usage: release-orchestrator.mjs <prepare|publish> [--bootstrap] [--tag <tag>] [--yes]",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : error}\n`);
    process.exitCode = 1;
  });
}
