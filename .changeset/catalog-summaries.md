---
"create-project-calavera": minor
---

Every entry in the integration catalog now carries a `summary` (a one-sentence, plain-language description under 140 characters) and a `homepage` (an `https:` URL to the tool's own site or repository). `list_integrations` and `describe_integration` return both fields, and the generated `description` is now prefixed with the summary. `github-repository-controls`, which has no upstream tool, links to the Calavera documentation that describes it.
