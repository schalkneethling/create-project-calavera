// Issue #704: `npx skills add schalkneethling/create-project-calavera` must list
// the bundled skills and none of the plugin skills. The skills CLI searches every
// folder only when it finds no skills in its standard places, and it counts the
// skills of plugins in .claude-plugin/marketplace.json as found. Plugin skills
// therefore carry `metadata.internal: true`, and this check fails if the bundled
// skills ever stop being listed. It runs the skills CLI that package.json pins.
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { distributedSkillFolders } from "./skill-folders.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const skillsPackagePath = fileURLToPath(import.meta.resolve("skills/package.json"));
const skillsBin = join(
  dirname(skillsPackagePath),
  JSON.parse(await readFile(skillsPackagePath, "utf8")).bin.skills,
);

async function skillName(path) {
  const match = /^---\n(?:.*\n)*?name: (\S+)\n/.exec(
    (await readFile(path, "utf8")).replaceAll("\r\n", "\n"),
  );
  if (!match?.[1]) throw new Error(`${path} has no name in its frontmatter.`);
  return match[1];
}

const folders = await distributedSkillFolders(root);
const bundled = new Set(
  await Promise.all(folders.bundled.map((folder) => skillName(join(folder, "SKILL.md")))),
);
const pluginSkills = new Set(
  await Promise.all(folders.plugins.map((folder) => skillName(join(folder, "SKILL.md")))),
);

// INSTALL_INTERNAL_SKILLS would make the CLI list the plugin skills on purpose.
const { INSTALL_INTERNAL_SKILLS: _ignored, ...environment } = process.env;
const result = spawnSync(process.execPath, [skillsBin, "add", root, "--list"], {
  encoding: "utf8",
  env: { ...environment, NO_COLOR: "1", FORCE_COLOR: "0", DO_NOT_TRACK: "1" },
});
if (result.error) throw result.error;
const output = `${result.stdout}${result.stderr}`;
if (result.status !== 0) {
  process.stderr.write(output);
  throw new Error(`The skills CLI exited with code ${result.status}.`);
}

// The listing prints each skill name on its own line, indented after a box rule.
const listed = new Set(
  [...output.matchAll(/^│ {4}([a-z0-9][a-z0-9-]*)$/gm)].map((match) => match[1]).filter(Boolean),
);
const missing = [...bundled].filter((name) => !listed.has(name)).sort();
const leaked = [...listed].filter((name) => pluginSkills.has(name)).sort();
const unexpected = [...listed]
  .filter((name) => !bundled.has(name) && !pluginSkills.has(name))
  .sort();

if (missing.length > 0 || leaked.length > 0 || unexpected.length > 0) {
  process.stderr.write(output);
  const problems = [
    missing.length > 0 ? `bundled skills not listed: ${missing.join(", ")}` : "",
    leaked.length > 0 ? `plugin skills listed: ${leaked.join(", ")}` : "",
    unexpected.length > 0 ? `skills listed from elsewhere: ${unexpected.join(", ")}` : "",
  ].filter(Boolean);
  throw new Error(
    `The skills CLI does not list exactly the bundled skills (${problems.join("; ")}).`,
  );
}

console.info(
  `The skills CLI lists the ${bundled.size} bundled skills and none of the ${pluginSkills.size} plugin skills.`,
);
