// The two copies of the bundled Calavera skill: the CLI installs the first during `--init`; the
// second is the published skill artifact. Drift tests read both.
export const bundledSkillCopies = [
  {
    source: "packages/cli/src/bootstrap/calavera/SKILL.md",
    url: new URL("../src/bootstrap/calavera/SKILL.md", import.meta.url),
  },
  {
    source: "packages/artifacts/skill-calavera/payload/calavera/SKILL.md",
    url: new URL("../../artifacts/skill-calavera/payload/calavera/SKILL.md", import.meta.url),
  },
];
