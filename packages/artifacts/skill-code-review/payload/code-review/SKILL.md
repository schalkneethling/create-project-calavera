---
name: code-review
description: Review code changes for correctness, security, performance, accessibility, maintainability, tests, dependencies, design-system adherence, and localization. Use when the user asks for a code review, PR review, review of local changes, risk assessment, code quality feedback, or actionable findings before merge.
disable-model-invocation: true
---

# Code Review

Review code to catch issues the original engineer may have missed and to improve the codebase without creating unnecessary friction. Prioritize real risks over style noise.

## Review Workflow

1. Determine the review scope:
   - Inspect `git status`, the relevant diff, and any user-specified files or PR context.
   - Preserve unrelated user changes. Do not modify code unless the user asks for fixes.
   - Identify whether the change is frontend, backend, library, CLI, infrastructure, docs, or mixed.
2. Check project context before judging:
   - Frameworks and languages.
   - Test tooling and CI coverage.
   - Linting, formatting, type checking, and build scripts.
   - Dependency management and lockfiles.
   - Accessibility, localization, and design-system tooling when UI code is involved.
3. Review the change for material issues:
   - Correctness: broken behavior, edge cases, data loss, error handling, and regressions.
   - Security: injection risks, unsafe auth, secret handling, dependency risk, and permission scope.
   - Performance and resources: unnecessary CPU, memory, network use, leaks, race conditions, deadlocks, async coordination, and missing back-pressure or throttling.
   - Accessibility: semantic HTML, labels, keyboard support, focus management, ARIA misuse, and contrast.
   - Maintainability: naming, structure, type safety, readability, duplication, and fit with local patterns.
   - Tests and docs: missing coverage for new behavior, insufficient regression tests, and stale public docs.
   - Dependencies: added packages, bundle/runtime impact, maintenance state, security posture, and whether built-in or existing project utilities would be enough.
   - Design systems and branding: token usage, component reuse, theme consistency, and justified deviations.
   - Localization: hard-coded UI strings, date/number formatting, translation keys, and future translation workflow.
4. Produce review feedback:
   - Lead with findings, ordered by severity.
   - Include file and line references for repo-local issues.
   - Explain impact and give a concrete fix.
   - Group repeated instances when one root cause explains them.
   - Mark non-blocking refactors as follow-up suggestions, not merge blockers.
   - If no issues are found, say so clearly and mention any residual test or tooling gaps.

## Context Skills

Load related skills only when the diff makes that domain relevant:

- Load `frontend-engineering` when reviewing markup-producing or style-producing code: HTML templates, JSX/TSX, Astro/Vue/Svelte components, Lit templates, Twig/ERB/Handlebars/Nunjucks, MDX, CSS, Sass/Less, CSS modules, scoped component styles, CSS-in-JS, or code that materially changes rendered HTML structure, selectors, layout, cascade, responsive behavior, colors, motion, or focus states.

For large or high-risk diffs, consider a focused specialist subagent for the relevant skill. Pass only the user request, relevant diff, surrounding component context, and known project conventions. Reconcile specialist feedback into one prioritized final review rather than forwarding it verbatim.

## Setup Deficiencies

If essential review infrastructure is missing, call it out early before deep findings:

- No runnable tests or tests absent from CI.
- No linting, formatting, type checking, or build validation for the changed area.
- Missing lockfile or unpinned dependencies.
- No dependency or supply-chain scanning for publishable/server code.
- No accessibility checks for UI-heavy changes.
- No i18n framework or translation process for localized UI.
- Missing design-system tokens/components when the project clearly depends on them.

When a setup deficiency would make the review noisy or unreliable, report the deficiency as the primary finding and then provide only the highest-confidence code findings.

## Feedback Standards

- Be direct, specific, and respectful. Focus on code and impact, never the author.
- Avoid nitpicks that an existing formatter or linter should handle.
- Prefer established local helpers, components, patterns, and style systems over new abstractions.
- Flag redundant implementations when the project already has an equivalent helper, component, CSS pattern, or service.
- Challenge clever but opaque code. Prefer readable control flow and well-named helpers.
- Encourage comments only for non-obvious decisions, tradeoffs, constraints, or nuanced behavior. Discourage comments that restate the code.
- Include positive feedback after findings when something is genuinely strong, such as clean tests, simple abstractions, or thoughtful design.

## Severity Guide

- `P0`: Must fix immediately. Security exploit, data loss, severe outage, or merge-blocking broken core behavior.
- `P1`: Should fix before merge. Likely bug, serious regression, accessibility blocker, unsafe dependency/auth pattern, or missing critical test.
- `P2`: Important but may be follow-up. Maintainability issue, incomplete edge coverage, performance concern, duplicate implementation, or design-system drift.
- `P3`: Optional improvement. Clarity, small refactor, documentation polish, or non-blocking suggestion.

## Output Shape

Use this order for review responses:

1. Findings, ordered by severity, with `file:line`.
2. Open questions or assumptions.
3. Brief positive notes, if useful.
4. Validation performed or not performed.

Keep summaries short. The findings are the review.
