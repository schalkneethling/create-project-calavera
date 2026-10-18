import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { distributedSkillFolders } from "./skill-folders.mjs";

const directory = await mkdtemp(join(tmpdir(), "calavera-skillspector-"));

async function skillPaths() {
  // Plugin skills are distributed too, so they get the same scan (#704).
  const { bundled, plugins } = await distributedSkillFolders(".");
  return [...bundled, ...plugins].sort();
}

async function scanSkill(path, index) {
  const reportPath = join(directory, `${index}.json`);
  const exitCode = await new Promise((resolve, reject) => {
    const scan = spawn(
      "uv",
      [
        "run",
        "--frozen",
        "skillspector",
        "scan",
        path,
        "--no-llm",
        "--format",
        "json",
        "--output",
        reportPath,
      ],
      { stdio: "inherit" },
    );
    scan.once("error", reject);
    scan.once("close", (code) => resolve(code ?? 2));
  });

  if (exitCode !== 0) return exitCode;
  const report = JSON.parse(await readFile(reportPath, "utf8"));
  if (!report.skill || typeof report.skill.name !== "string") {
    throw new Error(`Invalid SkillSpector report for ${path}.`);
  }
  return 0;
}

try {
  const paths = await skillPaths();
  if (paths.length === 0) throw new Error("No packaged skills found for SkillSpector.");

  for (const [index, path] of paths.entries()) {
    const exitCode = await scanSkill(path, index);
    if (exitCode !== 0) process.exitCode = exitCode;
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}
