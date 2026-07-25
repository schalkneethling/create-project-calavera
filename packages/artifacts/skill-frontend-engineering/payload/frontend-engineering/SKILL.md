---
name: frontend-engineering
description: Build, review, or refactor browser-facing frontend work across HTML templates, JSX/TSX, component frameworks, CSS, client-side behavior, forms, and API interaction. Use for frontend implementation that needs coordinated semantic markup, accessible styling, security-aware data handling, and appropriate frontend tests.
---

# Frontend Engineering

Use this skill as the entry point for frontend work. Start with the relevant implementation context, then load only the guidance that applies.

## Routing

- For HTML, JSX/TSX, Twig, Astro, Vue, Svelte, Lit, MDX, or other markup-producing code, read `references/semantic-html.md`. Use `references/semantic-html-element-decision-trees.md` and `references/semantic-html-heading-patterns.md` for element or heading decisions.
- For CSS, Sass/Less, CSS modules, scoped styles, CSS-in-JS, layout, responsive behavior, motion, colors, focus states, or selectors, read `references/css-authoring.md` and `references/css-patterns.md`.
- For forms, authentication, untrusted input, browser storage, URLs, HTML injection, API calls, uploads, or other security-sensitive browser flows, load the `frontend-security` skill.
- For behavior changes, accessibility checks, visual changes, or regression coverage, load the `frontend-testing` skill.
- For a new or foundational custom-property system, load the `css-tokens` skill.

## Working Principles

1. Inspect the existing component, template, styles, and project conventions before changing them.
2. Prefer native HTML and browser capabilities over custom replacements.
3. Keep semantics, behavior, visual styling, and validation aligned without making them unnecessarily coupled.
4. Treat user-controlled and server-provided data as untrusted until the appropriate security guidance establishes otherwise.
5. Add focused tests that protect the changed user-visible behavior and accessibility contract.
