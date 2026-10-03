# Pull request guidance

Read this document when scoping an issue, planning a task, or starting a new implementation.

This guidance is written around the idea of a pull request, as this is a common workflow. However, the essence captured here applies more broadly to how work is done, with the overall goal of improving the quality of the project as a whole.

- Every pull request needs an associated issue, and each issue needs testable acceptance criteria. Acceptance criteria do not have to be exhaustive, but they need to make it clear what is and is not expected. The exception is a trivial change, such as a typo fix or minor maintenance, that has no effect on behavior. When in doubt, propose creating an issue.
- Prefer vertical slices unless the associated issue is specifically scoped differently.
- Use GitHub's stacked pull requests when working on a change set a reviewer cannot reasonably review in a single sitting. Refer to the official GitHub documentation on using `gh stack` if you are unsure about this feature.
- If splitting would leave a PR broken, misleading, or impossible to validate, keep the necessary pieces together and explain that constraint in the PR.
- Before requesting adversarial review, ensure all relevant tests, linting, type checks, and builds are run and pass. Run them again after addressing review findings and before opening the pull request.
- Before opening a pull request, ask a local subagent for an adversarial review of the code. Ensure the subagent has the needed context to enable an effective review. Context should include the issue, the acceptance criteria, and the diff to review.
- Unless the issue calls for a different focus, the review covers regressions, accessibility, security, missing tests, and scope creep, omitting any that clearly do not apply.
- Review findings are considered by the agent coordinating the work, and valid findings are delegated back to the agent that implemented the change to address.
- Review findings deemed invalid must be reported in the PR description along with the reasoning for why they were marked as such.
- Start the PR description by answering what this pull request does and which issue or issues it fixes using the "Fixes #xxx" syntax. Make it specific enough to focus the review on the proposed solution or decision. Then explain what changed, why it changed, and how you validated it. Include relevant commands, results, and any limitations. Prefer concise, useful evidence over a prescribed reporting format.
- Create follow-up issues for deferred work that might otherwise be forgotten.
