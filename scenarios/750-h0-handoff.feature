# Issue #750: deliver H0 and close Increment 1.
# These scenarios are the manual QA guide for the sequencing map and STATUS.md.
# The automated part lives in packages/cli/scripts/h0-handoff-docs.test.mjs.

Feature: The sequencing map and STATUS.md agree with the tracker when H0 is delivered

  Scenario: The H0 row records the delivery
    Given the sequencing map "docs/cross-repo/sequencing-map.md"
    When a reader checks the H0 row of the handoff table
    Then the status reads "delivered 6.1.0 2026-11-07"
    And the row links "docs/bootstrap-readiness-record.md"

  Scenario: The map no longer holds stale statements
    Given the sequencing map
    When it is searched for "proposed" next to ADR-0010 and for #442 described as pending
    Then neither stale statement remains
    And ADR-0010 is described as accepted with an amendment proposed on 2026-10-21 under #688
    And the status line has a "Revised" date under "Draft 1, 9 September 2026"

  Scenario: Section 0 is a skeleton for the owner
    Given the rewritten Section 0
    When the owner reads it
    Then it has placeholders for the next increment's goal, exit condition, issues, and "explicitly not now"
    And the only content filled in is a fact that already exists, such as the Stryker issues #733 to #736
    And no sentence sets policy for Increment 2

  Scenario: The map records where the Stryker work sits
    Given the decision issue #732, which asks for the placement to be recorded
    When a reader looks for the Stryker work in the map
    Then the map says it starts after H0, as the owner decided on 2026-10-22
    And the map does not close #732, because closing it stays the owner's call

  Scenario: STATUS.md read cold shows a delivered handoff
    Given STATUS.md
    When a reader checks the Handoffs, Audit, and "Next session starts with" sections
    Then H0 reads "delivered 6.1.0 2026-11-07"
    And the audit line states one count of classified rows
    And no merged pull request is listed as open
    And the list names #673 and #676 as deferred and #669 as delivered in 6.1.0

  Scenario: The friction issues from the readiness record are linked
    Given the readiness record created issues #838 to #844 and #846
    When a reader looks for them in STATUS.md
    Then each issue is listed with a link
    And the comments on #675, #643, and #617 and the upstream report voidzero-dev/vite-plus#3381 are listed

  Scenario: Checkpoint 1 is reported without a verdict
    Given the four criteria of Checkpoint 1 in "docs/evolution-brief.md"
    When the pull request description or STATUS.md reports them
    Then it lists the evidence source for the first criterion, the readiness record
    And it says the other three criteria have no evidence source yet
    And it does not propose that the checkpoint passed
