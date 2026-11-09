export const integrationCatalog = [
  {
    id: "editorconfig",
    label: "EditorConfig",
    summary:
      "EditorConfig defines a standard configuration file so editors and IDEs apply the same indentation, charset, and line-ending rules.",
    homepage: "https://editorconfig.org",
    group: "Project consistency",
    platform: "generic",
    status: "recommended",
    dependencies: [],
  },
  {
    id: "knip",
    label: "Knip",
    summary:
      "Knip finds and helps remove unused dependencies, exports, and files in JavaScript and TypeScript projects.",
    homepage: "https://knip.dev",
    group: "Unused code",
    platform: "knip",
    status: "optional",
    minimumCliVersion: "2.3.0",
    dependencies: ["knip"],
  },
  {
    id: "html-validate",
    label: "HTML Validate",
    summary:
      "HTML Validate is an offline HTML5 validator and linter that checks markup validity without uploading code to an external service.",
    homepage: "https://html-validate.org",
    group: "HTML",
    platform: "html-validate",
    status: "optional",
    minimumCliVersion: "2.3.0",
    // integrationOptions["html-validate"] arrived later than the integration (#644).
    optionsMinimumCliVersion: "4.2.0",
    dependencies: ["html-validate"],
    htmlValidate: {
      extends: ["html-validate:recommended", "html-validate:document"],
      rules: {},
    },
    // ADR-0016: the lines of the managed .htmlvalidateignore. Another integration's lines follow.
    // .claude/worktrees/ holds agent worktrees, which are full checkouts of other branches. Their
    // files belong to those branches, so this project's lint run must not report their errors.
    ignore: {
      htmlValidateIgnore: ["node_modules/", "dist/", "coverage/", ".claude/worktrees/"],
    },
  },
  {
    id: "varlock",
    label: "Varlock",
    summary:
      "Varlock manages environment variables through a declarative schema so AI agents and tools see requirements without accessing secret values.",
    homepage: "https://varlock.dev",
    group: "Environment variables",
    platform: "varlock",
    status: "optional",
    minimumCliVersion: "2.3.0",
    dependencies: ["varlock"],
  },
  {
    id: "github-repository-controls",
    label: "GitHub repository controls",
    summary:
      "Generates a version-controlled GitHub repository policy and an administration script to manage and audit repository settings.",
    homepage:
      "https://github.com/schalkneethling/create-project-calavera#github-repository-controls",
    group: "Repository governance",
    platform: "github",
    status: "optional",
    // GitHub reads .github/ only at the repository root (#550).
    appliesAt: "repository-root",
    minimumCliVersion: "2.5.0",
    dependencies: [],
  },
  {
    id: "stryker",
    label: "Stryker mutation testing",
    summary:
      "Stryker makes small changes to the source code and reports each change that the project's Vitest tests do not detect.",
    homepage: "https://stryker-mutator.io",
    group: "Mutation testing",
    platform: "stryker",
    status: "optional",
    minimumCliVersion: "6.2.0",
    // ADR-0014 Decision 3: a mutation run takes minutes, so quality never runs this script. The
    // Composer and the MCP descriptions name it from here; apply writes it in index.js, and
    // integration-notes.test.mjs fails if the two names differ.
    standaloneScript: "test:mutation",
    // ADR-0014 Decision 2: Stryker runs the project's tests with the Vitest that vite-plus
    // installs, so apply stops where it does not delegate to Vite+, and the dry run warns when no
    // file matches Vitest's default test pattern.
    runsVitestTests: true,
    // Owner decision of 2026-11-09 on #734: a workspace root has no tests of its own for Stryker
    // to run, so the integration applies in a single-package project or in a workspace member.
    appliesAt: "package",
    // The runner declares the exact core version as a peer dependency, and one install of both
    // resolves them to the same release.
    dependencies: ["@stryker-mutator/core", "@stryker-mutator/vitest-runner"],
    // ADR-0016: Stryker writes its sandboxes to .stryker-tmp/ and leaves it behind after a failed
    // run, and writes its HTML report to reports/mutation/. vp check formats both and html-validate
    // lints the report unless they are ignored.
    ignore: {
      gitignore: [".stryker-tmp/", "reports/mutation/"],
      htmlValidateIgnore: ["reports/mutation/"],
    },
  },
  {
    id: "react-doctor",
    label: "React Doctor",
    summary:
      "React Doctor deterministically scans a React codebase for issues in state, effects, performance, security, accessibility, and architecture.",
    homepage: "https://github.com/millionco/react-doctor#readme",
    group: "React best practices",
    platform: "react-doctor",
    status: "framework-specific",
    dependencies: ["react-doctor"],
  },
  {
    id: "stylelint",
    label: "Stylelint",
    summary: "Stylelint is a CSS linter that catches errors and enforces coding conventions.",
    homepage: "https://stylelint.io",
    group: "CSS linting",
    platform: "stylelint",
    status: "recommended",
    dependencies: ["stylelint"],
  },
  {
    id: "stylelint-standard",
    label: "Stylelint standard config",
    summary:
      "stylelint-config-standard is a shareable Stylelint configuration that enforces modern, standard CSS conventions.",
    homepage: "https://github.com/stylelint/stylelint-config-standard",
    group: "CSS linting",
    platform: "stylelint-config",
    status: "recommended",
    dependencies: ["stylelint-config-standard"],
    includes: ["stylelint"],
    stylelint: {
      extends: ["stylelint-config-standard"],
    },
  },
  {
    id: "stylelint-order",
    label: "CSS property ordering",
    summary:
      "stylelint-order adds Stylelint rules that enforce a consistent order for CSS properties and other declaration content.",
    homepage: "https://github.com/hudochenkov/stylelint-order",
    group: "CSS property ordering",
    platform: "stylelint-plugin",
    status: "optional",
    dependencies: ["stylelint-order"],
    includes: ["stylelint"],
    stylelint: {
      plugins: ["stylelint-order"],
      rules: {
        "order/properties-alphabetical-order": true,
      },
    },
  },
  {
    id: "stylelint-baseline",
    label: "CSS Baseline",
    summary:
      "stylelint-plugin-use-baseline flags CSS features in Stylelint that lack the configured level of Baseline browser support.",
    homepage: "https://github.com/ryo-manba/stylelint-plugin-use-baseline#readme",
    group: "CSS Baseline",
    platform: "stylelint-plugin",
    status: "recommended",
    dependencies: ["stylelint-plugin-use-baseline"],
    includes: ["stylelint"],
    stylelint: {
      plugins: ["stylelint-plugin-use-baseline"],
      rules: {
        "plugin/use-baseline": true,
      },
    },
  },
  {
    id: "stylelint-scss",
    label: "SCSS support",
    summary:
      "stylelint-scss adds SCSS-specific linting rules to Stylelint for Sass syntax beyond plain CSS.",
    homepage: "https://github.com/stylelint-scss/stylelint-scss#readme",
    group: "CSS linting",
    platform: "stylelint-plugin",
    status: "framework-specific",
    dependencies: ["stylelint-scss", "stylelint-config-standard-scss"],
    includes: ["stylelint"],
    stylelint: {
      extends: ["stylelint-config-standard-scss"],
      plugins: ["stylelint-scss"],
    },
  },
  {
    id: "stylelint-stylistic",
    label: "Stylelint stylistic rules",
    summary:
      "@stylistic/stylelint-config restores the stylistic formatting rules that Stylelint removed from its standard configuration.",
    homepage: "https://github.com/stylelint-stylistic/stylelint-config#readme",
    group: "CSS linting",
    platform: "stylelint-config",
    status: "optional",
    dependencies: ["@stylistic/stylelint-config"],
    includes: ["stylelint"],
    stylelint: {
      extends: ["@stylistic/stylelint-config"],
    },
  },
  {
    id: "stylelint-logical-css",
    label: "Logical CSS",
    summary:
      "stylelint-plugin-logical-css enforces logical CSS properties, values, and units so layouts adapt to writing mode and text direction.",
    homepage: "https://github.com/yuschick/stylelint-plugin-logical-css",
    group: "CSS logical properties",
    platform: "stylelint-plugin",
    status: "optional",
    minimumCliVersion: "2.3.0",
    dependencies: ["stylelint-plugin-logical-css"],
    includes: ["stylelint"],
    stylelint: {
      extends: ["stylelint-plugin-logical-css/configs/recommended"],
      plugins: ["stylelint-plugin-logical-css"],
    },
  },
  {
    id: "css-property-type-validator",
    label: "CSS property type validation",
    summary:
      "Validates CSS custom property @property registrations and their usage within Stylelint, flagging type mismatches and unresolved references.",
    homepage: "https://github.com/schalkneethling/css-property-type-validator#readme",
    group: "CSS property type validation",
    platform: "stylelint-plugin",
    status: "experimental",
    dependencies: ["@schalkneethling/stylelint-plugin-css-property-type-validator"],
    includes: ["stylelint"],
    stylelint: {
      plugins: ["@schalkneethling/stylelint-plugin-css-property-type-validator"],
      rules: {
        "css-property-type-validator/valid-property-types": true,
      },
    },
  },
];
