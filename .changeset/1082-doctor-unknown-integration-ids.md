---
"create-project-calavera": minor
---

`doctor` now warns about two kinds of recipe value that `apply` refuses, in any project and whatever the Vite+ status (#1082). A removed profile, such as `modern`, is named with its replacement and ADR-0011. A removed JavaScript or TypeScript toolchain integration, such as `eslint` in a project Vite+ does not manage, is named with the ADR that removed it and the advice to run `vp create` or `vp migrate` first (ADR-0009). Any other unknown integration ID is named by its position in `integrations`, so `doctor` does not repeat text from the recipe. In a project Vite+ manages, a removed toolchain integration keeps its existing warning and gets no second one. These warnings stay advisory: `doctor` writes nothing, and its exit status does not change.
