---
"create-project-calavera": patch
---

Reject a recipe that selects the same AI artifact ID more than once. Recipe validation, `artifacts install`, `artifacts update`, apply, and `compose_recipe` now fail with an error that names the duplicate ID, before any artifact resolution or write.
