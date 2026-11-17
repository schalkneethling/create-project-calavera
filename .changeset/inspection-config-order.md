---
"create-project-calavera": patch
---

Project inspection now lists the existing configuration files in `files`, and the `existing-config` findings, in the order apply writes the integrations: `.editorconfig`, Stylelint, html-validate, React Doctor, Knip, Stryker, and then the GitHub repository controls. The same files and findings are reported as before; only their order changes. This shows in `inspect_project`, in the `projectInspection` that `dry_run_apply`, `apply --dry-run`, and apply report, and in the order of the inspection warnings that `apply --dry-run` prints (#926).
