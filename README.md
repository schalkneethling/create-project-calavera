# create-project-calavera

Add common linters, formatters, and _hopefully_ sane configurations, for common web projects with an intuative CLI.

## Current Features

- [x] EditorConfig
- [x] ESLint (If using TypeScript, this will be configured using [typescript-eslint](https://typescript-eslint.io/))
- [x] `tsconfig`
- [x] `tsconfig` (noEmit - when used with a bundler)
- [x] Prettier
- [x] Stylelint

## Using the CLI

From the root of your project, run the following command:

```bash
npm create project-calavera
```

All that is left to do is to follow the prompts.

> **NOTE:** If you do not have a `package.json` Calavera will offer to create one for you. If you choose this option, one is created using `npm init -y`.
