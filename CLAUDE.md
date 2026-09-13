@AGENTS.md

## Claude Code notes

- Read `STATUS.md`, `docs/cross-repo/requests/`, and `docs/cross-repo/sequencing-map.md` Section 0 before doing anything else in a session.
- This repository and css-evolve are worked in separate sessions. Do not edit the css-evolve repository from here; write a cross-repo request instead.
- Removals are one PR each with an ADR; do not batch them.
- The C8 safety-property tests are not to be modified to make a change pass. If a change cannot pass them, stop and write the decision issue.
- When you hit a checkpoint or the increment's exit condition, stop and summarize: which criteria pass, which do not, and the exact evidence. Do not continue.
