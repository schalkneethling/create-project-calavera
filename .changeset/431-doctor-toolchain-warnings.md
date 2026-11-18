---
"create-project-calavera": minor
---

`doctor` now warns about each JavaScript or TypeScript toolchain integration a recipe still selects in a project Vite+ manages, such as `oxlint`, `oxfmt`, `typescript`, `eslint`, or `prettier` from a recipe written before those integrations were removed. Each warning names the integration and the Vite+ detection signal that matched, and says to remove the integration from the recipe, because `apply` refuses the recipe until then. In a project Vite+ does not manage, `doctor` reports no such warning. These warnings stay advisory: `doctor` writes nothing, and a warning does not change its exit status (#431).
