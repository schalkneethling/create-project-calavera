---
description: >-
  A Dependabot pull request whose build checks all fail at pnpm install, because
  its lockfile pulls in a postcss release younger than pnpm's minimum release age.
  Recorded from schalkneethling/schalkneethling.com pull request 1457 on 2026-10-19
  (issue #713). The prompt passes the agent only the URL and asks for its report
  unchanged, so the case tests the agent's own instructions rather than what the
  main session adds to its prompt.
expected_outcome: >-
  The report leads with the failing checks and their cause, and says the pull
  request cannot be merged as it is.
max_turns: 40
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Agent, Bash]
---

Run the dependency-review:dependabot-update-reviewer agent on https://github.com/schalkneethling/schalkneethling.com/pull/1457. Give the agent only that URL as its prompt, with no other words. Do not look at the pull request yourself. When the agent finishes, reply with its report exactly as it wrote it, without adding, removing, or summarizing anything.
