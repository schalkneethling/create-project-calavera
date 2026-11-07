// @ts-check
import { createHash } from "node:crypto";

// Issue #830: an agent guidance file that an earlier release wrote is an older template, not a
// local edit, only when its text equals what some release wrote. `--init` cannot ask
// .calavera/state.json, because Calavera records none of these files there, so this module holds
// what every published release wrote, as SHA-256 digests of the text. A digest equals the
// text it names only byte for byte, so a person's edit, even one character, never matches.
//
// The full texts are the fixtures in packages/cli/fixtures/agent-guidance, and
// earlier-guidance-table.test.mjs checks that these digests and those texts agree. They were
// recovered by running each release tag's own `agentBootstrap` in an empty project, once for each
// package manager. To recognize a release this table does not list yet, add its version to the
// matching `releases` list, or, when the template text changed, add the new text to the fixtures
// and its digest here; that test fails until both agree.
//
// The text a release wrote is the text compared, except that a Windows line ending (`\r\n`) counts
// as the Unix one (`\n`), and the version `.agents/calavera/mcp.md` pins in its launch command is
// replaced with `{{version}}` before hashing. The pin is the one part of that file that changes
// with every release, so the file matches only when its single pinned version is in the `releases`
// list of the template it matches.

/**
 * @typedef {"guidance" | "mcp"} EarlierGuidanceKind `guidance` is the text of `AGENTS.md` written
 *   as a whole file and of `AGENTS.calavera.md`, which are the same text; `mcp` is the text of
 *   `.agents/calavera/mcp.md`.
 */

/**
 * @typedef {object} EarlierTemplate
 * @property {string[]} releases The published versions that wrote this text, oldest first.
 * @property {boolean} [pinned] Whether the text pins the version of the release that wrote it.
 * @property {string[]} sha256 Digests of the normalized text: one for the guidance, and one for
 *   each package manager (npm, pnpm, Yarn, Bun, in that order) for the setup notes.
 */

const VERSION_PLACEHOLDER = "{{version}}";
const PINNED_VERSION = /create-project-calavera@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)/g;

const GUIDANCE = [
  {
    releases: ["2.0.0", "2.0.1", "2.0.2", "2.0.4"],
    sha256: ["ea0f1f5b7abac11ece92a947dafacd3595f18e5cc0f5ae4f0c9355b235c07f7a"],
  },
  {
    releases: ["2.0.6"],
    sha256: ["a264084656a7564188c579d65bf1a3e875a50a7395aaaee6fac9cf30f5a6fd5d"],
  },
  {
    releases: ["2.1.0"],
    sha256: ["559eb0b17c480d63dddb7e3cdde58b5b6c2cc2b2caa72ff07000f63e5428a853"],
  },
  {
    releases: [
      "2.1.2",
      "2.2.0",
      "2.3.0-next.2",
      "2.3.0-next.3",
      "2.3.0",
      "2.4.0-next.0",
      "2.4.0-next.1",
      "2.4.0",
      "2.5.0",
      "2.6.0",
    ],
    sha256: ["9ed0e264dc9583428c6c5e6be4666e10508186ed76e8f920330f741df608a656"],
  },
  {
    releases: ["3.0.0", "4.0.0", "4.0.1", "4.0.2", "4.1.0", "5.0.0", "5.0.1", "6.0.0"],
    sha256: ["f198c16e05ee0c587754f173d612b9de266751f845c4ce1914a1857d6d29dcb5"],
  },
  {
    releases: ["6.1.0"],
    sha256: ["c0c6c875f0eb05cbf1dfbce2793a317900407966a65eaf8838e1af4f87d67e00"],
  },
];

const MCP = [
  {
    releases: ["2.0.0", "2.0.1", "2.0.2"],
    pinned: false,
    sha256: [
      "0b971eec45d41be7a1dad42cce492959cc5769e27932b1190d10241f99c1eff7",
      "df236004fb11b61872ac0a04732fd4e9e20756f7870755235514a5e3663f6fb9",
      "18dbb560d646dacf2c8191e6fd358b3522f08014150442d7383524fef91a25de",
      "aca0c5b0dee2ae71a85dea84c375e001c39073093141a579641ca0a39bf4306e",
    ],
  },
  {
    releases: ["2.0.4"],
    pinned: false,
    sha256: [
      "dc2776d6d619f63fa0c3d708af13a2b1a222a42167c63af470a138b4bb6642da",
      "c107ad40ffef1a1ad3fd0909638ceb9f8b0543fedfb8e14b1ddcdd7e20c25710",
      "33d43def37dac9c96a86ec900397cd7ee8a39868e5a22e4fe1824b2b2bbd7a97",
      "70bfd77e6b4ecb333225df6986f7e64b816bdcda0a47fa6c367d5a3d040314d2",
    ],
  },
  {
    releases: ["2.0.6"],
    pinned: true,
    sha256: [
      "307e6322b87e01979ebbb0cd046a404c048124bc3a0b3b97252d96f05bb0c64a",
      "7d87d10390eed9949a08bc584be8fdbee87d29f8b20d4c265689ef6a5b5c7869",
      "171e2d898f28f1fe644778048b19971dbb3df3912f9c4da17eb9e9576bfa9ce9",
      "f171d32b447bb750e439c942e19297fbd32b2a1b11f0042cdd64f04b6fdf7d4a",
    ],
  },
  {
    releases: ["2.1.0"],
    pinned: true,
    sha256: [
      "1d353434680b5b5ec2fddf167dfbc8ec572da92d262b8e0a229c6b7accf4c359",
      "11c5a6bdc5eae1dbd2b57bef666b5761bbb874041def782846e44af3d5c59ba2",
      "072bceb6cc082da2aa2da5ffbffff4930fe06e766e0da7f525f7b1df6eb0c0ec",
      "0cbc1ba6edfdfd0d6266e57b9a61c7fba3bce85fcad5f154b129a3f4c0843cf5",
    ],
  },
  {
    releases: ["2.1.2"],
    pinned: true,
    sha256: [
      "ca00396220e57d94335d9e2b0ddefd04fc676fa069909a411ba570004d5a051e",
      "1e3da432479f0925ff8c33de655d7d1f8eab0f0ca526153db93b1f175ef56b2a",
      "3b3f2e03644c45226f231cd5f9b27aa8977d82672a8a935785e254ec4f40dfeb",
      "d61310944860b0bf160e2930b388c9aa91e8ead4542baff90df74fea7b461fc2",
    ],
  },
  {
    releases: [
      "2.2.0",
      "2.3.0-next.2",
      "2.3.0-next.3",
      "2.3.0",
      "2.4.0-next.0",
      "2.4.0-next.1",
      "2.4.0",
      "2.5.0",
      "2.6.0",
    ],
    pinned: true,
    sha256: [
      "e3a320c988af87bbf584d4ab389e8dcaa9f95857d00969c7c34d8d8e8c2278b6",
      "fe239338b1686d84fd215fcee32fb58657e9e4e994276be28903782938816ea8",
      "ff65c64c8e4c0a0a85787c3b908046eae326b72216b8f7cf6b03274a8c6339e8",
      "b43d31a2023899f8a6644c32e84ad15e6bf26ead0e13e905179d90860169753f",
    ],
  },
  {
    releases: ["3.0.0", "4.0.0", "4.0.1", "4.0.2", "4.1.0"],
    pinned: true,
    sha256: [
      "1b37cecd0e5f3a837d46fd4441365ed843b5b4beef5dbe5b22ad39a652ffaf0c",
      "df8fd7e23167bd63e827650eb1a357c823c5d935d651f3ca0bad7873e951e78e",
      "58a5851f49b88ecfda2d3025073e2ee3120b8a0ce917045fcb7f9f4cd0cd61df",
      "0b8f7105b3780ca19a424dd9f536e219db029ae3c6de99a3aaca7527d15bd0a6",
    ],
  },
  {
    releases: ["5.0.0", "5.0.1", "6.0.0", "6.1.0"],
    pinned: true,
    sha256: [
      "85efd7663418e9bc17f8f35e2d39bddc5f646a6ca7c317bda2ea8f4a3ed25487",
      "283a830ce25ddaed625310d0040d7d5e68bdd43d338ecc177d0b2f8d45f4053c",
      "80f80a09f6be029303e16fd42691be1f98c01489ff4212aeff2fcc31d3305c7b",
      "8c993d8952d9724aa1c33f5efa2a0a758aeb4ae316bd5dffa2c7f6d9d46e5c37",
    ],
  },
];

/** @type {Record<EarlierGuidanceKind, EarlierTemplate[]>} */
export const EARLIER_TEMPLATES = { guidance: GUIDANCE, mcp: MCP };

/**
 * @param {string} text
 * @returns {string}
 */
function sha256(text) {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Finds the earlier Calavera release whose text `text` is.
 *
 * @param {EarlierGuidanceKind} kind
 * @param {string} text The contents of the file in the project.
 * @returns {{ releases: string[], description: string } | undefined} The releases that wrote the
 *   text, and a phrase that names them, such as "5.0.0" or "3.0.0 to 6.0.0". Nothing when the text
 *   is not one a release wrote, which makes it a local edit.
 */
export function findEarlierGuidance(kind, text) {
  const unixText = text.replaceAll("\r\n", "\n");
  const pins = new Set([...unixText.matchAll(PINNED_VERSION)].map((match) => match[1]));
  // A text that pins two different versions was never written by one release: only the first is
  // replaced below, so the other stays in the text and the digest cannot match.
  const [pin] = pins;
  const normalized =
    pin === undefined
      ? unixText
      : unixText.replaceAll(
          `create-project-calavera@${pin}`,
          `create-project-calavera@${VERSION_PLACEHOLDER}`,
        );
  const digest = sha256(normalized);

  const template = EARLIER_TEMPLATES[kind].find(
    (earlier) =>
      earlier.sha256.includes(digest) &&
      (pin === undefined ? !earlier.pinned : earlier.releases.includes(pin)),
  );
  if (!template) return undefined;

  const { releases } = template;
  return {
    releases,
    description:
      pin ?? (releases.length === 1 ? `${releases[0]}` : `${releases[0]} to ${releases.at(-1)}`),
  };
}
