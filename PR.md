# Pull request guidance

Pull requests should be small enough that a reviewer can understand the whole
change without switching into scanning mode. Review quality matters more than
maximizing the amount of work included in one PR.

## Before starting work

- Read this document when scoping an issue, planning a task, or starting a new
  implementation.
- Identify the smallest coherent change that answers one primary review
  question.
- Split work along independently mergeable behavior boundaries, not arbitrary
  file or line counts.
- Use GitHub stacked pull requests to enable the above when a sessions will span multiple pull requests (gh stack).
- Sequence dependent PRs so each merge leaves `main` working, testable, and not
  misleading.
- Write or refine issues around those same reviewable slices. Avoid acceptance
  criteria that quietly combine policy, schema, generation, remote writes, and
  UI work when those can land safely in sequence.
- Start the PR description with a review question. Make it specific enough
  to focus the review on the proposed solution or decision. Then explain what changed, why, and how you validated it. Include relevant commands, results, and any limitations. Prefer concise, useful evidence over a prescribed reporting format.

## Keep the diff focused

- Do not bundle opportunistic refactors, formatting churn, dependency updates,
  or unrelated cleanup.
- Include the tests and operational documentation needed to validate and use
  the change.
- Make the purpose of every changed file clear from the PR description.
- Prefer a follow-up issue over expanding the current PR beyond its review
  question.

## Reassess during implementation

Stop and re-scope when:

- the implementation grows beyond the original acceptance criteria;
- the PR starts answering multiple independent review questions;
- the description needs several unrelated sections to explain the change;
- reviewing the diff requires holding multiple workflows in mind; or
- a safe, independently testable seam becomes apparent.

If splitting would leave a PR broken, misleading, or impossible to validate,
keep the necessary pieces together and explain that constraint in the PR.

## Before requesting review

- Confirm the diff still matches the issue and stated review question.
- Remove unrelated changes and generated noise.
- Validate the change in proportion to its risk.
- Summarize what changed, how it was tested, and what was deliberately deferred.
- Create follow-up issues for deferred work that might otherwise be forgotten.
