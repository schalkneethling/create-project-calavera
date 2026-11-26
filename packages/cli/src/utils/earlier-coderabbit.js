// @ts-check
import { createHash } from "node:crypto";

// Issue #678 (ADR-0017, Decision 2): `eject` removes a `.coderabbit.yaml` that Calavera created
// whole only when its text is one a Calavera release wrote, because Calavera records nothing about
// the file in .calavera/state.json. This module holds every such text as a SHA-256 digest, the way
// earlier-guidance.js holds the guidance. A digest equals the text it names only byte for byte, so
// an edit, even one character, never matches.
//
// A release wrote the file in one of two ways. When no `.coderabbit.yaml` existed, it created the
// file whole from `CODE_RABBIT_SKILL_CONFIG` in ai/artifacts.js. When the file already existed, it
// added the filters it was missing through the `yaml` package. A file an earlier release created
// and a later release updated is therefore still Calavera's text, so it is listed too.
//
// The full texts are the fixtures in packages/cli/fixtures/coderabbit, which name the releases that
// wrote each text, and earlier-coderabbit-table.test.mjs checks that these digests and those texts
// agree. The created texts were recovered from `CODE_RABBIT_SKILL_CONFIG` at each release tag; the
// updated text is what releases 2.5.0 and later write over the text 2.3.0 to 2.4.0 created. That
// test also runs this checkout's bootstrap and fails when it creates or updates the file to a text
// this table does not list, so changing the template or the filters cannot pass without recording
// the new text here, keeping the earlier ones.
//
// A Windows line ending (`\r\n`) counts as the Unix one (`\n`), as `findEarlierGuidance` counts it.

/**
 * The digest of each text a release wrote, named by the fixture that holds the text.
 *
 * @type {readonly { id: string, sha256: string }[]}
 */
export const CODE_RABBIT_TEXTS = Object.freeze([
  {
    id: "created-2.3.0",
    sha256: "9ac793f343e207f313b31baa509abe227bf6b975b7875e9e67017e00ebb68900",
  },
  {
    id: "created-2.5.0",
    sha256: "6cf8e72b315f1bbebbdeeb4319d1ae11d172d422e36e2b293e48dbc831a82069",
  },
  {
    id: "updated-2.5.0-from-2.3.0",
    sha256: "175c7e312c198234825dd86aa26770e610c0fb16fce332e2d14a2c67236e91eb",
  },
]);

/**
 * Whether `text` is a `.coderabbit.yaml` text that a Calavera release wrote.
 *
 * @param {string} text The contents of the file in the project.
 */
export function isCodeRabbitTextCalaveraWrote(text) {
  const digest = createHash("sha256").update(text.replaceAll("\r\n", "\n")).digest("hex");
  return CODE_RABBIT_TEXTS.some(({ sha256 }) => sha256 === digest);
}
