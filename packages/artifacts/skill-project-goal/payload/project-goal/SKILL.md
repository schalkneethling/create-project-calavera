---
name: project-goal
description: Inspect a project, ask targeted user questions, and write a root GOAL.md that clearly defines the project's goals, intended audience, success criteria, constraints, and explicit non-goals. Use when asked to create, draft, update, clarify, document, or recover a project's goal, north star, mission, scope, or GOAL.md from an existing repository.
---

# Project Goal

Use this skill to create a clear `GOAL.md` in the project root. The file should help future agents and maintainers understand what the project is trying to accomplish and what it deliberately is not trying to be.

## Workflow

1. Determine the project root. Prefer the git repository root. If there is no git repository, use the current working directory unless the user named a different root.
2. Inspect the project before asking questions:
   - Read existing project-level docs such as `README.md`, `GOAL.md`, `CONTRIBUTING.md`, docs indexes, package manifests, config files, and examples.
   - Inspect source layout, tests, CLI or app entry points, public APIs, bundled assets, and install or build scripts.
   - Review issue, roadmap, changelog, or planning files when present.
3. Form a concise working theory of:
   - The project purpose.
   - Primary users or consumers, limited to the audiences supported by project evidence or user confirmation.
   - Core capabilities.
   - Success signals.
   - Constraints or principles.
   - Explicit non-goals.
   - Unknowns or contradictions.
4. Ask the user only the questions that materially affect the final `GOAL.md`.
   - Use the available Ask User tool when one exists. If no Ask User tool is available, ask directly in chat.
   - Ask one question at a time by default.
   - Set a sensible upper limit before asking follow-ups, usually no more than 3-5 total questions unless the project evidence is genuinely contradictory.
   - Prefer confirmation questions when the answer can be inferred: "I infer X from Y; should GOAL.md state that?"
   - Ask open questions only for real gaps, conflicts, or values that cannot be discovered from the repository.
   - Stop asking once the document can be accurate enough. Do not turn the process into an interview.
5. Write or update `<project-root>/GOAL.md`.
   - If `GOAL.md` already exists, preserve accurate useful content and revise it in place.
   - If discovered evidence conflicts with user answers, treat the user as authoritative but mention the conflict in the final response.
   - If the user cannot answer a question, write the best-supported goal and mark unresolved uncertainty in the document.
6. Report the file path written and summarize the most important assumptions or unresolved items.

## GOAL.md Content

Use Markdown features that make the project intent easy to scan. A good default structure is:

```markdown
# Project Goal

## North Star

## Who This Is For

## Core Goals

## Success Looks Like

## Non-Goals

## Principles and Constraints

## Current Focus

## Open Questions
```

Adapt the headings to the project. Keep the file practical rather than ceremonial.

`GOAL.md` must include:

- A short north-star statement.
- The intended audience or users. If there is only one clear audience, name that single group instead of inventing additional end users or use cases.
- The concrete outcomes the project exists to create.
- A prioritized or grouped list of core goals.
- A `Non-Goals` section that clearly states what the project is not, will not optimize for, or should avoid becoming.
- Success criteria or observable signs of progress.
- Any important constraints, tradeoffs, principles, or scope boundaries.
- Open questions only when they genuinely remain unresolved after discovery and user input.

## Discovery Guidance

Look for evidence in:

- Project name, README, package metadata, CLI help text, app copy, examples, and tests.
- Dependency choices, framework configuration, deployment files, and build scripts.
- Directory names such as `src/`, `docs/`, `examples/`, `packages/`, `apps/`, `hooks/`, `skills/`, or `templates/`.
- Existing planning artifacts, comments, release notes, or issue templates.

Avoid overfitting to implementation details. The goal should describe why the project exists and what outcomes matter, not merely list files or current implementation tasks.

## Writing Standards

- Be specific, plainspoken, and falsifiable where possible.
- Separate facts discovered from the repo from assumptions confirmed by the user.
- Do not make up audiences, personas, or use cases to make the project seem broader. Specific and narrow is better than blurry.
- Prefer durable project intent over short-lived task lists.
- Make non-goals explicit enough to guide prioritization and issue triage.
- Keep the document concise enough to be read before working on the project.
- Do not include private chain-of-thought, exhaustive discovery notes, or a transcript of user questions.
