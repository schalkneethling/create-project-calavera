# create-project-calavera

Add common linters, formatters, and _hopefully_ sane configurations, for common web projects with an intuitive CLI.

https://github.com/user-attachments/assets/156e8b86-f389-41d8-8ab7-0817e3c3d094

## Current Features

- [x] EditorConfig
- [x] ESLint (If using TypeScript, this will be configured using [typescript-eslint](https://typescript-eslint.io/))
- [x] [ESLint HTML](https://html-eslint.org/)
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

### Thanks!

Thank you [Nik on Unsplash](https://unsplash.com/@helloimnik?utm_content=creditCopyText&utm_medium=referral&utm_source=unsplash) for the photo I used on the social preview.
