import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, extname, join, resolve } from "node:path";
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

function capturePendingPaths(rootDir) {
  return [
    ...captureGitPaths(rootDir, ["diff", "--name-only", "--diff-filter=ACMR"]),
    ...captureGitPaths(rootDir, ["ls-files", "--others", "--exclude-standard"]),
  ];
}

function captureIgnoredPackages(rootDir) {
  const config = JSON.parse(readFileSync(join(rootDir, ".changeset", "config.json"), "utf8"));
  const ignoredPackages = new Set(config.ignore ?? []);

  return captureGitPaths(rootDir, ["ls-files", "--", ":(glob)**/package.json"])
    .map((manifestPath) => {
      const manifestContents = readFileSync(join(rootDir, manifestPath));
      const manifest = JSON.parse(manifestContents);
      const changelogPath = join(dirname(manifestPath), "CHANGELOG.md");

      return {
        name: manifest.name,
        manifestPath,
        manifestContents,
        changelogPath,
        changelogContents: existsSync(join(rootDir, changelogPath))
          ? readFileSync(join(rootDir, changelogPath))
          : undefined,
      };
    })
    .filter(({ name }) => ignoredPackages.has(name));
}

function restoreIgnoredPackages(rootDir, packages) {
  for (const { manifestPath, manifestContents, changelogPath, changelogContents } of packages) {
    writeFileSync(join(rootDir, manifestPath), manifestContents);

    if (changelogContents === undefined) {
      if (existsSync(join(rootDir, changelogPath))) {
        unlinkSync(join(rootDir, changelogPath));
      }
    } else {
      writeFileSync(join(rootDir, changelogPath), changelogContents);
    }
  }
}

export function versionPackages(options = {}) {
  const rootDir = options.rootDir ?? root;
  const changesetBin = options.changesetBin ?? join(root, "node_modules", ".bin", "changeset");
  const formatterBin = options.formatterBin ?? join(root, "node_modules", ".bin", "oxfmt");
  const commandStdio = options.commandStdio ?? "inherit";

  const pathsBeforeVersioning = new Map(
    capturePendingPaths(rootDir).map((path) => [path, readFileSync(join(rootDir, path))]),
  );
  const ignoredPackages = captureIgnoredPackages(rootDir);
  try {
    execFileSync(changesetBin, ["version"], { cwd: rootDir, stdio: commandStdio });
  } finally {
    restoreIgnoredPackages(rootDir, ignoredPackages);
  }

  const generatedPaths = capturePendingPaths(rootDir).filter((path) => {
    const previousContents = pathsBeforeVersioning.get(path);
    return (
      previousContents === undefined || !previousContents.equals(readFileSync(join(rootDir, path)))
    );
  });
  const formatPaths = generatedFormatPaths(generatedPaths).filter((path) =>
    existsSync(join(rootDir, path)),
  );

  if (formatPaths.length > 0) {
    execFileSync(formatterBin, ["--write", ...formatPaths], {
      cwd: rootDir,
      stdio: commandStdio,
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  versionPackages();
}
