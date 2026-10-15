import { REPOSITORY_CONTROLS_SCRIPT_PATH } from "./github-repository-controls-options.js";

// html-validate exits 1 when no file matches, so lint:html runs it through
// this managed wrapper, which passes when there is nothing to check (#644).
export const HTML_VALIDATE_WRAPPER_PATH = "scripts/lint-html.mjs";

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
    REPOSITORY_CONTROLS_SCRIPT_PATH,
    "docs/repository-controls.md",
  ],
  "html-validate": [".htmlvalidate.json", ".htmlvalidateignore", HTML_VALIDATE_WRAPPER_PATH],
  knip: ["knip.json"],
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
