// Loaded with `node --import` before every test (ADR-0019 Decision 7): the `test` script of this
// package, Stryker's tap.nodeArgs, and the root release:fixture and this package's
// smoke:node-floor and schema:check scripts. It turns the CLI version check off for the test file and every child
// process it starts with the inherited environment, so no test asks a registry for `latest`. The
// version notice tests delete the switch from the child environment they build.
// It also loads isolated-account-home.mjs, so no test reads the developer's real ~/.npmrc (#1064).
import "./isolated-account-home.mjs";

process.env.CALAVERA_NO_VERSION_CHECK = "1";
