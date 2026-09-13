Calavera is what runs after `vp create`: Baseline target, CSS verification (css-evolve), HTML and accessibility checks, Playwright, agent artifacts, release trust. Vite+ owns the JS and TS toolchain; Calavera never competes with it.

## Repository rules

- For pull request guidance, please see @PR.md
- _Always_ ensure that we have the latest changes from the remote repository.
- _Always_ ensure that no feature work is started from main. Always use a feature branch.
- When creating the feature branch, always include the GitHub issue number in the branch name.
- When writing the pull request description, always include fix #<issue_number> at the end of the description. If the pull request fixes multiple issues, include all of them.
- Do _not_ write types for the sake of types in TypeScript. Only define types when TypeScript cannot cleanly infer from usage.
- Match validation and test tooling to the kind of confidence needed:
  - Use tests for repository invariants, contract checks, and drift checks.
  - Use a JSON Schema validator such as Ajv when validating JSON Schema behavior or arbitrary JSON data against a published schema.
  - Consider Valibot, Zod, or similar libraries when a typed authoring schema should become the source of truth, especially if JSON Schema will be generated from it.

## Session start (read, do not import)

1. `STATUS.md` — where the last session stopped.
2. `docs/cross-repo/sequencing-map.md` Section 0 — the current increment. Work only that; anything else you notice becomes an issue.
3. `docs/cross-repo/requests/` — open requests and responses.
4. `docs/evolution-brief.md` — decisions, spikes, phases, checkpoints. Consult when a decision's rationale or an issue's acceptance criteria are needed.
5. `docs/cross-repo/interface-contract.md` — before touching any surface shared with css-evolve.

## Rules in force every turn

- Guidance is a cost paid on every turn; a check is paid once. Whenever a rule in this file, in a skill, or in a brief could instead be a test, a lint rule, an ast-grep pattern, or a Determinant gate, or whenever the same correction has been needed twice, raise it: open an issue (label `guidance-to-check`) that names the rule, the proposed check, and the trade-offs, and stop there. Do not implement the check or remove the guidance until the project owner decides whether it becomes deterministic or stays as guidance.
- Litmus test: anywhere Calavera fights with or reimplements something Vite or Vite+ does well, Calavera steps aside and that part is removed. Removals are complete: no deprecated paths, flags, or legacy modes.
- Safety invariants (brief C8) are guarded by tests that are never weakened: only the CLI writes into projects; `dry_run_apply` is the approval boundary; local edits are preserved; artifacts are not written to `package.json`; conflicts surface as hard stop or migration decision.
- Keep failures diagnosable. Concise user-facing errors must preserve underlying causes for debugging. Retain useful structured operational diagnostics, with secrets and sensitive payloads excluded, and test that wrapping and redaction do not make distinct failures indistinguishable.
- Metadata before code: change catalog metadata first; scripts, managed files, diagnostics, guidance only where metadata cannot express the need.
- One issue, one PR, one primary review question named in the description. Test first. `vp` is the command runner.
- Frozen surfaces in the interface contract change only via a cross-repo request and a version bump.
- Needs from css-evolve are never worked around: write `docs/cross-repo/requests/YYYY-MM-DD-<slug>.md` from `docs/cross-repo/request-template.md`, mark the issue blocked in `STATUS.md`, continue with unblocked work.
- Halt at every `CHECKPOINT` and at the increment exit condition; summarize evidence and stop. Do not reopen settled decisions in a PR; open a decision issue.
- Prose and docs: MDN style guide, American spelling, no contractions in body prose.

## Session end

Rewrite `STATUS.md` (do not append) following its existing headings. Record delivered handoffs there and in the sequencing map.

## Issues and labels

`gh issue create --template cal.md`. Labels: `calavera-evolution`; add `removal`, `handoff`, `dogfood` as applicable.
