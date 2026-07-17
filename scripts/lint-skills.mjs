import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const directory = await mkdtemp(join(tmpdir(), "calavera-skillspector-"));
const reportPath = join(directory, "report.json");

try {
  const exitCode = await new Promise((resolve, reject) => {
    const scan = spawn(
      "uv",
      [
        "run",
        "--frozen",
        "skillspector",
        "scan",
        "packages/cli/src/ai/skills",
        "--recursive",
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

  if (exitCode !== 0) process.exitCode = exitCode;
  else {
    const report = JSON.parse(await readFile(reportPath, "utf8"));
    if (!Array.isArray(report.skills)) throw new Error("Invalid recursive SkillSpector report.");
    const errors = report.skills.filter((skill) => typeof skill.error === "string");

    if (errors.length > 0) {
      for (const skill of errors) console.error(`${skill.name}: ${skill.error}`);
      process.exitCode = 2;
    }
  }
} finally {
  await rm(directory, { force: true, recursive: true });
}
