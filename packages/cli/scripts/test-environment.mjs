// The environment every CLI test runs in. It is loaded with `node --import` before every test: the
// `test`, `schema:check`, and `smoke:node-floor` scripts of this package, the root release:fixture
// script, and Stryker's tap.nodeArgs. Each setting below reaches the test file and every child
// process it starts with the inherited environment.
//
// It turns the CLI version check off (ADR-0019 Decision 7), so no test asks a registry for
// `latest`. The version notice tests delete the switch from the child environment they build.
//
// It also turns off the OpenCode version check of `--init` (ADR-0022, Decision 6), so no test runs
// an `opencode` that a developer installed, which would take up to 5 seconds and change the
// result. opencode-version.test.mjs opts in by removing that switch where it exercises the check.
//
// It turns color off, so the CLI output a test reads is plain text in every terminal (#1345).
// Node.js, and the `styleText` that Calavera and Clack color with, let a set FORCE_COLOR override
// NO_COLOR, so a FORCE_COLOR in a developer's shell would put escape sequences at the start of
// every line. FORCE_COLOR=0 turns color off whatever the shell set.

process.env.CALAVERA_NO_VERSION_CHECK = "1";
process.env.CALAVERA_NO_OPENCODE_VERSION_CHECK = "1";
process.env.NO_COLOR = "1";
process.env.FORCE_COLOR = "0";
