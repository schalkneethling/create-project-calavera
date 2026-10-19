---
description: >-
  The pull request from the failing-checks case with every check passed, so the
  agent must not report failures that are not there (issue #713). The prompt
  passes the agent only the URL and asks for its report unchanged.
expected_outcome: >-
  The report says that all checks passed and that the pull request is ready to
  merge from a checks standpoint.
max_turns: 40
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Agent, Bash]
---

Run the dependency-review:dependabot-update-reviewer agent on https://github.com/schalkneethling/schalkneethling.com/pull/1457. Give the agent only that URL as its prompt, with no other words. Do not look at the pull request yourself. When the agent finishes, reply with its report exactly as it wrote it, without adding, removing, or summarizing anything.
