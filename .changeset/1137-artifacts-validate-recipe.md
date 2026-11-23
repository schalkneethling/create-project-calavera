---
"create-project-calavera": patch
---

`artifacts install` and `artifacts update` now validate the recipe before anything else, as `apply` does, so they refuse every recipe `apply` refuses, before anything is resolved or written (#1137). A recipe entry with an unknown `id` or legacy `src` now stops both commands with the message `apply` gives, instead of "Unknown artifact selection." that named no entry. A recipe these commands used to accept but `apply` refused, such as one without `version: 1` or with an unknown integration, now stops them with `apply`'s message too.

The message for an unknown `id` or legacy `src`, which `apply`, `validate_recipe`, and the other recipe checks share, now names the entry by its position, for example `ai[1]`, and says how to fix it. It no longer repeats the entry's `id` or `src`, because that value is text from your file.
