// Loaded with `node --import` before every test (ADR-0019 Decision 7): the `test` script of this
// package, Stryker's tap.nodeArgs, and the root release:fixture and this package's
// smoke:node-floor and schema:check scripts. It turns the CLI version check off for the test file and every child
// process it starts with the inherited environment, so no test asks a registry for `latest`. The
// version notice tests delete the switch from the child environment they build.

process.env.CALAVERA_NO_VERSION_CHECK = "1";
