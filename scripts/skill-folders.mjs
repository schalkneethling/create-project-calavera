// The skill folders that Calavera distributes: bundled skill packages and the
// skills of the plugins in plugins/ (#704).
import { access, readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * Lists the skill folders inside each matching subfolder of `parentPath`.
 *
 * @param {string} parentPath
 * @param {string} prefix Only subfolders whose name starts with this are read.
 * @param {string} skillsFolder The folder inside each subfolder that holds skills.
 * @param {{ optional?: boolean }} [options] Whether a subfolder may have no skills folder.
 */
async function skillFolders(parentPath, prefix, skillsFolder, { optional = false } = {}) {
  const paths = [];
  const entries = await readdir(parentPath, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.startsWith(prefix)) continue;
    const skillsPath = join(parentPath, entry.name, skillsFolder);
    const skillEntries = await readdir(skillsPath, { withFileTypes: true }).catch((error) => {
      if (optional && error.code === "ENOENT") return [];
      throw error;
    });

    for (const skillEntry of skillEntries) {
      if (!skillEntry.isDirectory()) continue;
      const path = join(skillsPath, skillEntry.name);
      await access(join(path, "SKILL.md"));
      paths.push(path);
    }
  }

  return paths.sort();
}

/**
 * @param {string} root The repository root.
 * @returns {Promise<{ bundled: string[], plugins: string[] }>}
 */
export async function distributedSkillFolders(root) {
  return {
    bundled: await skillFolders(join(root, "packages/artifacts"), "skill-", "payload"),
    // A plugin may have no skills, but every skill package has a payload.
    plugins: await skillFolders(join(root, "plugins"), "", "skills", { optional: true }),
  };
}
