---
name: CAL issue
about: One unit of work from the evolution brief
labels: calavera-evolution
---

## Identifier

CAL-nnn (from docs/evolution-brief.md)

## Primary review question

The one question the PR for this issue answers.

## Scope

What is in, what is explicitly out.

## Acceptance criteria

Copied or derived from the phase checkpoint in the brief; testable. When starting work on an issue, convert the acceptance criteria here in Cucumber scenarios inside the scenarios folder. These will then serve as input into the RED phase of the test driven development workflow, and serve as a guide for manual QA testing.

## Litmus test

For removals: the audit row and the evidence that Vite+ already does this well.
For additions: why Vite+ does not do this and is not expected to.

## Safety properties touched

None | list of C8 properties this change touches and the tests that guard them.

## Cross-repo dependency

None | Consumes H<n> (status) | Produces H<n>

## Decision or spike

None | ADR-000n required before implementation
