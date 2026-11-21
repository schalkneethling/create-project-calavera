---
"create-project-calavera": patch
---

The `stryker.config.json` that the stryker integration writes for a `node:test` project now sets `tap.forceBail` to `false`. With the tap runner's default, `true`, Stryker stopped a test process at its first failure, and when a later test in that file had changed into another folder, Stryker could not find the process's result file and reported the mutant as a runtime error instead of killed. Each test file now runs to its end; Stryker still stops at the first test file that fails (#1088).
