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
    dependencies: ["html-validate"],
    htmlValidate: {
      extends: ["html-validate:recommended", "html-validate:document"],
      rules: {},
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
