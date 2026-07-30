import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

export function generatedFormatPaths(changedPaths) {
  return [
    ...new Set(
      changedPaths.filter((path) => [".json", ".md", ".yaml", ".yml"].includes(extname(path))),
    ),
  ].sort();
}

function captureGitPaths(rootDir, args) {
  const output = execFileSync("git", args, {
    cwd: rootDir,
    encoding: "utf8",
  });
  return output.split("\n").filter(Boolean);
}

export function versionPackages(options = {}) {
  const rootDir = options.rootDir ?? root;
  const changesetBin = options.changesetBin ?? join(root, "node_modules", ".bin", "changeset");
  const formatterBin = options.formatterBin ?? join(root, "node_modules", ".bin", "oxfmt");

  execFileSync(changesetBin, ["version"], { cwd: rootDir, stdio: "inherit" });

  const changedPaths = [
    ...captureGitPaths(rootDir, ["diff", "--name-only", "--diff-filter=ACMR"]),
    ...captureGitPaths(rootDir, ["ls-files", "--others", "--exclude-standard"]),
  ];
  const formatPaths = generatedFormatPaths(changedPaths).filter((path) =>
    existsSync(join(rootDir, path)),
  );

  if (formatPaths.length > 0) {
    execFileSync(formatterBin, ["--write", ...formatPaths], {
      cwd: rootDir,
      stdio: "inherit",
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  versionPackages();
}
