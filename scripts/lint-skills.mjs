import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const artifactsPath = "packages/artifacts";
const directory = await mkdtemp(join(tmpdir(), "calavera-skillspector-"));

async function skillPaths() {
  const paths = [];
  const packages = await readdir(artifactsPath, { withFileTypes: true });

  for (const packageEntry of packages) {
    if (!packageEntry.isDirectory() || !packageEntry.name.startsWith("skill-")) continue;
    const payloadPath = join(artifactsPath, packageEntry.name, "payload");
    const payloadEntries = await readdir(payloadPath, { withFileTypes: true });

    for (const payloadEntry of payloadEntries) {
      if (!payloadEntry.isDirectory()) continue;
      const path = join(payloadPath, payloadEntry.name);
      await access(join(path, "SKILL.md"));
      paths.push(path);
    }
  }

  return paths.sort();
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
