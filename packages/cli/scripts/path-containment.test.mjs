// @ts-check

/**
 * Issue #1026: `isPathInside` is the one lexical answer to "is this path in that folder or below
 * it", shared by the artifact transaction's write guard, `apply`'s check for a recipe in the
 * working directory, and the Vite+ detection's manifest path formatting. Before #1026 each had its
 * own copy, and the copies disagreed on a name that starts with `..`, such as `..recipe.json`. The
 * owner chose the precise rule on #1026: a path is outside only when its relative path is `..`,
 * starts with `..` and a separator, or is absolute, so `..recipe.json` in the folder is inside.
 */

import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { isPathInside } from "../src/utils/fs.js";

/** @type {[parent: string, child: string, inside: boolean, why: string][]} */
const posixCases = [
  ["/work/project", "/work/project", true, "the folder itself"],
  ["/work/project", "/work/project/a.json", true, "a file in the folder"],
  ["/work/project", "/work/project/a/b/c.json", true, "a file deeper down"],
  ["/work/project/", "/work/project/a.json", true, "a trailing separator on the folder"],
  ["/work/project", "/work/project/a/", true, "a trailing separator on the path"],
  ["/work/project", "/work/project/a/../b.json", true, "a `..` that stays inside"],
  ["/work/project", "/work", false, "the parent folder"],
  ["/work/project", "/work/other/a.json", false, "a sibling folder"],
  ["/work/project", "/work/project-two/a.json", false, "a sibling whose name extends the folder's"],
  ["/work/project", "/work/project/../other.json", false, "a `..` that leaves"],
  ["/work/project", "/etc/passwd", false, "an unrelated absolute path"],
  // A name that starts with `..` is a file in the folder, not a step out of it.
  ["/work/project", "/work/project/..recipe.json", true, "a name that starts with `..`"],
  ["/work/project", "/work/project/...", true, "a name made of three dots"],
  ["/work/project/a", "/work/project", false, "the parent folder, whose relative path is `..`"],
  // The comparison is lexical and case-sensitive on POSIX, as each former helper was.
  ["/work/project", "/work/Project/a.json", false, "a different case on POSIX"],
];

for (const [parent, child, inside, why] of posixCases) {
  test(`isPathInside on POSIX: ${why} is ${inside ? "inside" : "outside"}`, () => {
    assert.equal(isPathInside(parent, child, posix), inside);
  });
}

/** @type {[parent: string, child: string, inside: boolean, why: string][]} */
const windowsCases = [
  ["C:\\work\\project", "C:\\work\\project\\a.json", true, "a file in the folder"],
  ["C:\\work\\project\\", "C:\\work\\project\\a.json", true, "a trailing separator"],
  ["C:\\work\\project", "c:\\WORK\\Project\\a.json", true, "a different case, which win32 ignores"],
  ["C:\\work\\project", "C:/work/project/a.json", true, "forward slashes"],
  ["C:\\work\\project", "C:\\work\\other\\a.json", false, "a sibling folder"],
  ["C:\\work\\project", "D:\\work\\project\\a.json", false, "another drive"],
  ["C:\\work\\project", "C:\\work\\project\\..recipe.json", true, "a name that starts with `..`"],
  ["C:\\work\\project", "C:\\work\\other.json", false, "a file in the parent folder"],
  ["C:\\work\\project\\a", "C:\\work\\project", false, "the parent folder"],
];

for (const [parent, child, inside, why] of windowsCases) {
  test(`isPathInside on Windows: ${why} is ${inside ? "inside" : "outside"}`, () => {
    assert.equal(isPathInside(parent, child, win32), inside);
  });
}

test("isPathInside uses the platform's path rules when none are given", () => {
  assert.equal(isPathInside(process.cwd(), `${process.cwd()}/a.json`), true);
  assert.equal(isPathInside(process.cwd(), "/"), process.cwd() === "/");
});
