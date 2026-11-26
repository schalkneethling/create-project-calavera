// Unit tests of the tarball URL check (#1194). They call the check directly, so nothing is fetched
// and no host name is looked up. registry.test.mjs covers the check through extraction.
import assert from "node:assert/strict";
import test from "node:test";

import { assertTarballUrl, tarballUrlRefusal } from "../src/tarball-url.js";

test("https URLs and http URLs on the three loopback hosts are accepted", () => {
  for (const url of [
    "https://registry.example.test/pkg/-/pkg-1.0.0.tgz",
    "HTTPS://REGISTRY.EXAMPLE.TEST/pkg-1.0.0.tgz",
    "http://localhost:4873/pkg-1.0.0.tgz",
    "http://127.0.0.1:4873/pkg-1.0.0.tgz",
    "http://[::1]/x.tgz",
    // The URL parser writes this form of the IPv6 loopback address as [::1].
    "http://[0:0:0:0:0:0:0:1]/x.tgz",
  ]) {
    assert.equal(tarballUrlRefusal(url), undefined, url);
  }
});

test("each refused form has its own reason, and only a quotable protocol is named", () => {
  for (const [url, reason, protocol] of [
    ["http://[::2]/x.tgz", "uses http: on a host that is not loopback", "http:"],
    ["http://127.0.0.2/x.tgz", "uses http: on a host that is not loopback", "http:"],
    ["http://localhost.example.test/x.tgz", "uses http: on a host that is not loopback", "http:"],
    ["git+ssh://git@github.com/owner/repo.git", "uses the protocol git+ssh:", "git+ssh:"],
    ["file:///x.tgz", "uses the protocol file:", "file:"],
    ["-/x.tgz", "is not an absolute URL", null],
    ["./x.tgz", "is not an absolute URL", null],
    ["git@github.com:owner/repo.git", "is an scp-style git address", null],
    // npm-package-arg's pattern is anchored at both ends, so it does not read these as git addresses.
    ["@owner@github.com:repo", "is not an absolute URL", null],
    ["git@github.com:owner\nrepo", "is not an absolute URL", null],
    [" https://registry.example.test/x.tgz", "does not start with its protocol", null],
    ["\thttps://registry.example.test/x.tgz", "does not start with its protocol", null],
    ["ht\ttps://registry.example.test/x.tgz", "does not start with its protocol", null],
  ]) {
    assert.deepEqual(tarballUrlRefusal(url), { reason, protocol }, url);
  }
});

test("a protocol of up to 16 characters is named, and a longer one is reported as too long", () => {
  // 16 characters with the colon.
  assert.deepEqual(tarballUrlRefusal("abcdefghijklmno://host/x.tgz"), {
    reason: "uses the protocol abcdefghijklmno:",
    protocol: "abcdefghijklmno:",
  });
  const long = `${"a".repeat(16)}://host/x.tgz`;
  assert.deepEqual(tarballUrlRefusal(long), {
    reason: "uses a protocol longer than 16 characters",
    protocol: null,
  });
  assert.throws(
    () => assertTarballUrl("@scope/pkg", long, long),
    (error) => {
      assert.equal(error.code, "EBADTARBALLURL");
      assert.equal(error.protocol, null);
      assert.doesNotMatch(error.message, /a{16}/);
      return true;
    },
  );
});
