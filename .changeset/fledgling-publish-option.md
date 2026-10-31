---
"@schalkneethling/calavera-skill-release-with-confidence": patch
---

The Fledgling reference in the release-with-confidence skill now configures direct publishing with `"publish": true` instead of `"permissions": "publish"`. Fledgling 1.3 deprecates the `permissions` key, and prints a warning on every run that uses it.
