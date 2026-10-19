---
description: >-
  The pull request from the failing-checks case, but the failed GitHub Actions
  jobs' logs can no longer be read, so the agent must name and link those checks,
  say that their logs could not be read, and not guess a cause (issue #713). The
  prompt passes the agent only the URL and asks for its report unchanged.
expected_outcome: >-
  The report says the pull request is not ready to merge because checks failed,
  says the failed jobs' logs could not be read, and gives no cause for them.
max_turns: 40
timeout_seconds: 1200
allowed_tools: [Read, Glob, Grep, Agent, Bash]
---

Run the dependency-review:dependabot-update-reviewer agent on https://github.com/schalkneethling/schalkneethling.com/pull/1457. Give the agent only that URL as its prompt, with no other words. Do not look at the pull request yourself. When the agent finishes, reply with its report exactly as it wrote it, without adding, removing, or summarizing anything.
