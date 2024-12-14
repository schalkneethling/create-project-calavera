import { fileURLToPath } from "node:url";
import path from "node:path";

export function findProjectRoot(rootFolderName) {
  let currentDir = fileURLToPath(import.meta.url);

  while (path.basename(currentDir) !== rootFolderName) {
    const parentDir = path.dirname(currentDir);

    // Safety check to prevent infinite loop or going beyond system root
    if (parentDir === currentDir) {
      throw new Error(
        `Could not find project root with name: ${rootFolderName}`
      );
    }

    currentDir = parentDir;
  }

  return currentDir;
}
