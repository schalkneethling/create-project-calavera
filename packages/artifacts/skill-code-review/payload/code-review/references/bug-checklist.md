# Bug checklist

Questions to ask of a change, by area. Each one is a hypothesis to test by reading code, not a comment to post. A line here becomes a finding only when you can cite the file and line that proves it.

## Money, orders and stock (retail and e-commerce)

- Can this operation run twice with the same input? Refunds, payments, stock reservations and order state changes need an idempotency key or a lock before the side effect, not after.
- Is money an integer in minor units or a decimal type? A float in a price, total, discount or VAT calculation is a P0.
- Rounding: is it done once, at the end, in the same way the rest of the codebase does it?
- Currency and locale: is the currency carried with the amount, and the locale with the formatting?
- Can stock go negative? Can a reservation leak when the request fails after it was taken?
- Order state machine: list the transitions the change adds or touches. Is there a transition the code allows that the business does not?
- Promotions and vouchers: can a discount apply twice, apply to the wrong lines, or be used after its limit?

## Auth, permissions and data exposure

- Is every new endpoint, handler, resolver or job behind the same auth check as its neighbours?
- Does a lookup by id check that the caller owns the object (customer, order, address, card)?
- Does a response include fields the caller should not see (other customers' data, internal ids, tokens, cost prices)?
- Do logs or error messages include personal data, card data, tokens or secrets?
- Is user input used in a query, a shell command, a file path, a URL fetched by the server, a template or an HTML string without escaping or parameterization?
- Are secrets read from the environment or a secret store, never from code or config in the repo?

## Concurrency and async

- Two of these at once: what breaks? Check-then-act without a lock, a counter updated in two steps, a cache filled by two requests.
- Is every promise awaited or returned? An unawaited promise swallows its error and may outlive the request.
- Blocking calls in async code (synchronous I/O, sleep, a sync ORM call in an async handler) stall the event loop or thread pool.
- Retries: is there a limit, a backoff, and is the operation safe to retry?
- Timeouts on every outbound call: HTTP, database, queue, cache.

## Nulls, errors and edge cases

- What does the function do with an empty list, a missing optional, zero, a negative number, a very large number, an empty string, unicode, a string with leading or trailing spaces?
- Is an error caught and then ignored? A `catch` that only logs, or a Go `_ = err`, turns a failure into silent wrong data.
- Does the error path clean up what the happy path acquired (file handles, connections, locks, reservations)?
- Off-by-one on ranges, pagination, dates and "last item" logic.
- Dates: time zone, DST, end of month, midnight boundaries, comparing a date with a datetime.

## Changed contracts

- A renamed or removed field, parameter, event property, header, status code, config key or environment variable: grep for every reader. Mobile apps and other services may read it too; they do not update with this PR.
- Enum values added or removed: every `switch` or `when` over that enum, every consumer that persists it.
- A changed default: who depended on the old one?
- Is the API or event version bumped when the shape changes in a breaking way? Is there a migration path?

## Data and migrations

- Does a schema change come with a migration, and does the migration run safely on a large live table (locks, long transactions, backfills)?
- Can the migration be rolled back? Is it safe to run twice?
- Does the code deploy before or after the migration, and does it work in both states?
- Are indexes added for the new query patterns? Is an index dropped that something still uses?
- Unique constraints and foreign keys: are they there where the code assumes uniqueness or existence?

## Caching and feature flags

- When is the cache invalidated? Every write path that changes the cached data must clear or update it.
- Is the cache key specific enough (tenant, locale, currency, user)?
- A feature flag read in code: is it defined, is the default safe, and does the off path still work?
- Flag removal: is every branch of the old code gone, including tests and config?

## Tests

- Behavior changed with no test that would fail without the change: a P2 worth a line.
- A test changed to match new output without a reason in the description: ask whether the old expectation was wrong or the new one is.
- Tests that mock the thing under test, or assert nothing, or are skipped.
- Flaky patterns: real time, real network, order-dependent setup, shared mutable state.

## Infrastructure, CI and config

- Dockerfiles: a base image bump, a changed user, a new port, secrets baked into layers.
- CI and workflows: a secret echoed, a step that runs untrusted code from a PR, a permission widened, `pull_request_target`.
- Kubernetes, Terraform, Helm: resource limits removed, a replica count or a probe changed, a public exposure added, a destructive change on apply.
- Dependency bumps: a major version with breaking changes, a known CVE, a lockfile that disagrees with the manifest.

## Frontend and mobile

- A changed response shape and the screen that renders it. Loading, empty and error states.
- A new network call on every render, keystroke or scroll.
- Accessibility of a new control: label, focus, contrast, keyboard.
- State that survives navigation when it should not (a previous customer's cart, a stale form).

## Things that are never findings

- Formatting, sorting, trailing commas, import order, line length, quote style. Linters and formatters own these.
- Naming taste, when the name is not misleading.
- "Consider adding a comment" or "consider extracting a function", unless the duplication hides a real bug.
- Anything the PR description says is intentional or deferred, unless it is dangerous.
- A suggestion to rewrite the approach when the approach works. Say it once as a question at most, and only when the verdict depends on it.
