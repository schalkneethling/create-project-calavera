---
description: >-
  Three Dependabot pull requests reviewed one after another and then ranked, as
  in the incident behind issue #713: #1457, whose checks failed, #1458, whose
  checks all passed, and #1459, whose checks are still running. #1458 and #1459
  are synthetic. Only #1458 may be ranked for merging; the others must be listed
  separately with their reasons.
expected_outcome: >-
  The reply recommends merging only #1458, and lists #1457 as not ready and
  #1459 as not known yet, each with its reason.
max_turns: 60
timeout_seconds: 2400
allowed_tools: [Read, Glob, Grep, Agent, Bash]
---

Use the dependency-review:dependabot-update-reviewer agent to review each of these three Dependabot pull requests:

- https://github.com/schalkneethling/schalkneethling.com/pull/1457
- https://github.com/schalkneethling/schalkneethling.com/pull/1458
- https://github.com/schalkneethling/schalkneethling.com/pull/1459

Run the agent once per pull request, and give each run only that pull request's URL as its prompt. Do not look at the pull requests yourself. Then tell me which of them I can merge, and in what order.
