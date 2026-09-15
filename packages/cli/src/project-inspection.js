export const packageManagerLockfiles = Object.freeze({
  npm: ["package-lock.json", "npm-shrinkwrap.json"],
  pnpm: ["pnpm-lock.yaml", "shrinkwrap.yaml"],
  yarn: ["yarn.lock"],
  bun: ["bun.lock", "bun.lockb"],
});

export const integrationConfigFiles = Object.freeze({
  editorconfig: [".editorconfig"],
  "github-repository-controls": [
    ".github/repository-controls.json",
    ".github/dependabot.yml",
    "scripts/repository-controls.mjs",
    "docs/repository-controls.md",
  ],
  "html-validate": [".htmlvalidate.json", ".htmlvalidateignore"],
  knip: ["knip.json"],
  prettier: [".prettierrc.json", ".prettierignore"],
  "react-doctor": ["react-doctor.config.json"],
  stylelint: [".stylelintrc.json"],
});

export const projectInspectionFiles = Object.freeze([
  "package.json",
  "calavera.config.json",
  ...Object.values(packageManagerLockfiles).flat(),
  ...Object.values(integrationConfigFiles).flat(),
  "vite.config.js",
  "vite.config.ts",
  "next.config.js",
  "next.config.mjs",
  "astro.config.mjs",
  "svelte.config.js",
]);
