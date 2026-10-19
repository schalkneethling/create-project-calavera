// The eval cases in evals/ replay a recording through a stand-in gh (#713).
// These tests keep each case's data consistent across the files that describe
// the same checks, and check the stand-in's behavior that the agent relies on,
// so a broken fixture fails here instead of skewing an eval run.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const evals = fileURLToPath(new URL("../evals", import.meta.url));
const pullRequest = "https://github.com/schalkneethling/schalkneethling.com/pull/1457";
const repository = "schalkneethling/schalkneethling.com";

// Builds a case's data folder the way fixtures/scaffold.sh does: the recording,
// with the case's data/ files replacing it, and "delete" removing a file.
function caseData(caseName) {
  const directory = mkdtempSync(join(tmpdir(), `eval-${caseName}-`));
  cpSync(join(evals, "fixtures/gh"), join(directory, "gh"));
  cpSync(join(evals, "fixtures/data"), join(directory, "data"), { recursive: true });
  const overrides = join(evals, caseName, "data");
  if (existsSync(overrides)) {
    for (const name of readdirSync(overrides)) {
      const text = readFileSync(join(overrides, name), "utf8");
      if (text.trim() === "delete") {
        rmSync(join(directory, "data", name), { force: true });
      } else {
        cpSync(join(overrides, name), join(directory, "data", name));
      }
    }
  }
  return directory;
}

const readJson = (directory, name) =>
  JSON.parse(readFileSync(join(directory, "data", name), "utf8"));

// Maps the check states that each file uses to gh pr checks buckets.
function rollupBucket(check) {
  if (check.__typename === "StatusContext") {
    return { SUCCESS: "pass", FAILURE: "fail", ERROR: "fail", PENDING: "pending" }[check.state];
  }
  if (check.status !== "COMPLETED") return "pending";
  return {
    SUCCESS: "pass",
    NEUTRAL: "pass",
    SKIPPED: "skipping",
    FAILURE: "fail",
    TIMED_OUT: "fail",
    CANCELLED: "cancel",
  }[check.conclusion];
}

// The symbol gh run view prints for a job or step, from Symbol in
// cli/cli pkg/cmd/run/shared/shared.go: "*" for anything not completed.
function ghSymbol({ status, conclusion }) {
  if (status !== "completed") return "*";
  if (conclusion === "success") return "✓";
  if (conclusion === "skipped" || conclusion === "neutral") return "-";
  return "X";
}

function jobBucket(job) {
  if (job.status !== "completed") return "pending";
  return { success: "pass", skipped: "skipping", failure: "fail", cancelled: "cancel" }[
    job.conclusion
  ];
}

// failedLogs: whether each failed run has its failed-step log. unreadable-logs
// removes them on purpose, to stand for logs GitHub no longer has.
const cases = {
  "failing-checks": { exitCode: 1, mergeState: "BLOCKED", failedLogs: true },
  "passing-checks": { exitCode: 0, mergeState: "CLEAN", failedLogs: true },
  "pending-checks": { exitCode: 8, mergeState: "BLOCKED", failedLogs: true },
  "unreadable-logs": { exitCode: 1, mergeState: "BLOCKED", failedLogs: false },
};

const directories = [];
after(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});

for (const [caseName, expected] of Object.entries(cases)) {
  describe(`eval data for ${caseName}`, () => {
    const directory = caseData(caseName);
    directories.push(directory);
    const checks = readJson(directory, "pr-checks.json");
    const pullRequestView = readJson(directory, "pr-view.json");
    const runs = readJson(directory, "runs.json");

    const gh = (...args) =>
      spawnSync("bash", [join(directory, "gh"), ...args], { encoding: "utf8" });

    it("has an eval case folder with a prompt and graders", () => {
      assert.ok(existsSync(join(evals, caseName, "prompt.md")));
      assert.ok(readdirSync(join(evals, caseName, "graders")).length > 0);
    });

    it("gives every check the same state in pr-checks.json, pr-checks.txt, and pr-view.json", () => {
      const fromChecks = Object.fromEntries(checks.map((check) => [check.name, check.bucket]));
      const fromText = Object.fromEntries(
        readFileSync(join(directory, "data/pr-checks.txt"), "utf8")
          .trim()
          .split("\n")
          .map((line) => line.split("\t"))
          .map(([name, bucket]) => [name, bucket]),
      );
      const fromRollup = Object.fromEntries(
        pullRequestView.statusCheckRollup.map((check) => [
          check.name ?? check.context,
          rollupBucket(check),
        ]),
      );

      assert.deepEqual(fromText, fromChecks);
      assert.deepEqual(fromRollup, fromChecks);
      assert.equal(pullRequestView.mergeStateStatus, expected.mergeState);
    });

    it("gives every GitHub Actions job the same state in its check and its run", () => {
      for (const check of checks) {
        const match = /\/actions\/runs\/(\d+)\/job\/(\d+)/.exec(check.link);
        if (!match) continue;
        const [, runId, jobId] = match;
        const run = readJson(directory, `run-${runId}.json`);
        const job = run.jobs.find((candidate) => String(candidate.databaseId) === jobId);

        assert.ok(job, `${check.name}: job ${jobId} is not in run ${runId}`);
        assert.equal(jobBucket(job), check.bucket, `${check.name}: job state`);
        const listed = runs.find((candidate) => String(candidate.databaseId) === runId);
        assert.equal(listed?.conclusion, run.conclusion, `run ${runId}: runs.json conclusion`);
        assert.equal(
          existsSync(join(directory, `data/run-${runId}-log-failed.txt`)),
          run.conclusion === "failure" && expected.failedLogs,
          `run ${runId}: a failed-step log exists only for a failed run, unless the case removes it`,
        );
      }
    });

    it("shows each job and step in run-*.txt with the symbol gh prints for its state in run-*.json", () => {
      for (const name of readdirSync(join(directory, "data")).filter((file) =>
        /^run-\d+\.json$/.test(file),
      )) {
        const run = readJson(directory, name);
        const text = readFileSync(join(directory, "data", name.replace(".json", ".txt")), "utf8");
        const jobsSection = text.split("\nJOBS\n")[1]?.split("\n\n")[0] ?? "";
        let job;
        let step = 0;

        for (const line of jobsSection.split("\n")) {
          const header = /^(\S) .+ \(ID (\d+)\)$/.exec(line);
          if (header) {
            job = run.jobs.find((candidate) => String(candidate.databaseId) === header[2]);
            step = 0;
            assert.ok(job, `${name}: job ${header[2]} is not in the JSON`);
            assert.equal(header[1], ghSymbol(job), `${name}: ${line}`);
            continue;
          }
          const stepLine = /^ {2}(\S) (.+)$/.exec(line);
          assert.ok(stepLine && job, `${name}: unexpected line in JOBS: ${line}`);
          const recorded = job.steps[step++];
          assert.equal(stepLine[2], recorded?.name, `${name}: step order`);
          assert.equal(stepLine[1], ghSymbol(recorded), `${name}: ${line}`);
        }
        assert.ok(job, `${name}: no jobs in the text recording`);
      }
    });

    it("makes gh pr checks exit the way gh does for these checks", () => {
      assert.equal(gh("pr", "checks", pullRequest).status, expected.exitCode);
      assert.equal(gh("pr", "checks", pullRequest, "--json", "name,bucket").status, 0);
    });
  });
}

describe("the stand-in gh's errors for logs it cannot give", () => {
  const view = (caseName, ...args) => {
    const directory = caseData(caseName);
    directories.push(directory);
    return spawnSync(
      "bash",
      [join(directory, "gh"), "run", "view", ...args, "-R", repository, "--log-failed"],
      {
        encoding: "utf8",
      },
    );
  };

  it("answers log not found for a failed run whose log is gone", () => {
    const result = view("unreadable-logs", "--job", "117999264170");

    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), "failed to get run log: log not found");
  });

  it("refuses the log of a job that is still in progress, as gh does", () => {
    const result = view("pending-checks", "--job", "117999264170");

    assert.equal(result.status, 1);
    assert.equal(
      result.stderr.trim(),
      "job 117999264170 is still in progress; logs will be available when it is complete",
    );
  });
});

describe("the stand-in gh", () => {
  const directory = caseData("failing-checks");
  directories.push(directory);
  const gh = (...args) => spawnSync("bash", [join(directory, "gh"), ...args], { encoding: "utf8" });

  it("needs -R for run commands, because the workspace has no git remote", () => {
    const withoutRepository = gh("run", "view", "--job", "117999264170", "--log-failed");
    const otherRepository = gh(
      "run",
      "view",
      "--job",
      "117999264170",
      "-R",
      "other/repo",
      "--log-failed",
    );

    assert.equal(withoutRepository.status, 1);
    assert.match(withoutRepository.stderr, /-R/);
    assert.equal(otherRepository.status, 1);
  });

  it("returns only the named job's failed steps, and the job decides the run", () => {
    const result = gh(
      "run",
      "view",
      "39234213489",
      "--job",
      "117999264170",
      "-R",
      repository,
      "--log-failed",
    );
    const jobs = new Set(
      result.stdout
        .trim()
        .split("\n")
        .map((line) => line.split("\t")[0]),
    );

    assert.equal(result.status, 0);
    assert.deepEqual([...jobs], ["Production build"]);
    assert.match(result.stdout, /ERR_PNPM_MINIMUM_RELEASE_AGE_VIOLATION/);
  });

  it("rejects an unknown --json field and an unrecorded flag, as gh does", () => {
    const unknownField = gh("pr", "view", pullRequest, "--json", "title,notAField");
    const unrecordedFlag = gh("pr", "diff", pullRequest, "--name-only");

    assert.equal(unknownField.status, 1);
    assert.match(unknownField.stderr, /Unknown JSON field: "notAField"/);
    assert.equal(unrecordedFlag.status, 1);
  });
});
