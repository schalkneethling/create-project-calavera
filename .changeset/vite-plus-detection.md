---
"create-project-calavera": minor
---

`inspect_project` now reports whether the project is managed by Vite+ through an optional `vitePlus` field and four new finding kinds (`vite-plus-managed`, `vite-plus-unmanaged`, `vite-plus-signal-conflict`, `vite-plus-detection-unknown`). The change is additive, with nothing changed or removed; see [ADR-0001](../docs/adr/0001-vite-plus-detection-signal.md) for the detection signal and its rationale.
