#!/usr/bin/env node
import { readdir } from "node:fs/promises";
import { delimiter, extname, join } from "node:path";
import { spawn } from "node:child_process";

const ignoredDirectories = new Set([
  ".calavera",
  ".git",
  "coverage",
  "dist",
  "dist-web",
  "node_modules",
]);

const [label, extensionList, separator, ...command] = process.argv.slice(2);

if (separator !== "--" || command.length === 0) {
  console.info("Usage: run-if-files <label> <extensions> -- <command>");
  process.exit(1);
}

const extensions = new Set(extensionList.split(",").map((extension) => `.${extension.trim()}`));

async function hasMatchingFile(directory) {
  let entries;

  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch {
    return false;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      if (await hasMatchingFile(join(directory, entry.name))) {
        return true;
      }
    } else if (extensions.has(extname(entry.name))) {
      return true;
    }
  }

  return false;
}

if (!(await hasMatchingFile(process.cwd()))) {
  console.info(`No ${label} files found. Skipping.`);
  process.exit(0);
}

const child = spawn(command[0], command.slice(1), {
  env: {
    ...process.env,
    PATH: [join(process.cwd(), "node_modules", ".bin"), process.env.PATH]
      .filter(Boolean)
      .join(delimiter),
  },
  stdio: "inherit",
});

child.on("error", (error) => {
  console.info(`Failed to start "${command[0]}": ${error.message}`);
  process.exit(1);
});

child.on("exit", (code, signal) => {
  if (signal) {
    console.info(`Command stopped by signal ${signal}.`);
    process.exit(1);
  }

  process.exit(code ?? 1);
});
