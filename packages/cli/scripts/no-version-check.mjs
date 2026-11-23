// Loaded with `node --import` before every test (ADR-0019 Decision 7): the `test` script of this
// package, Stryker's tap.nodeArgs, and the root release:fixture and this package's
// smoke:node-floor and schema:check scripts. It turns the CLI version check off for the test file and every child
// process it starts with the inherited environment, so no test asks a registry for `latest`. The
// version notice tests delete the switch from the child environment they build.
//
// It also turns off the OpenCode version check of `--init` (ADR-0022, Decision 6), so no test runs
// an `opencode` that a developer installed, which would take up to 5 seconds and change the
// result. opencode-version.test.mjs opts in by removing that switch where it exercises the check.

process.env.CALAVERA_NO_VERSION_CHECK = "1";
process.env.CALAVERA_NO_OPENCODE_VERSION_CHECK = "1";
