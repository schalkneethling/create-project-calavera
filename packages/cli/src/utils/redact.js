// @ts-check

const REDACTED = "[redacted]";

// An environment variable or configuration key whose value is a secret.
const SECRET_NAME =
  /TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|AUTH|COOKIE|SESSION/i;

// A shorter value, such as `true` or `1`, is a setting, not a secret, and
// redacting it everywhere it appears would hide ordinary text.
const MINIMUM_SECRET_VALUE_LENGTH = 8;

/** @type {[RegExp, string][]} */
const SECRET_PATTERNS = [
  // `NAME=value` where NAME names a secret: a command-line environment
  // assignment, or an `.npmrc` key such as `//registry/:_authToken=` or `_auth=`.
  [
    new RegExp(
      `(\\b[A-Za-z_][A-Za-z0-9_]*(?:${SECRET_NAME.source})[A-Za-z0-9_]*\\s*=\\s*)[^\\s"']+`,
      "gi",
    ),
    `$1${REDACTED}`,
  ],
  // An Authorization header value, with or without its scheme.
  [
    /(\b(?:proxy-)?authorization\s*:\s*(?:(?:bearer|basic|token)\s+)?)[^\s"',;]+/gi,
    `$1${REDACTED}`,
  ],
  // A Bearer or Basic credential outside a header.
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/-]{8,}=*/g, `$1 ${REDACTED}`],
  // npm access tokens, the shape @npmcli/redact matches.
  [/\bnpms?_[A-Za-z0-9]{36,48}\b/g, REDACTED],
  // GitHub tokens: classic, OAuth, user-to-server, server-to-server, refresh, and fine-grained.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, REDACTED],
  // The user information of a URL, which can hold a token or a password.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi, `$1${REDACTED}@`],
];

/**
 * Removes secrets from text before Calavera displays it: the value of every
 * variable in `env` whose name names a secret, `NAME=value` assignments and
 * `.npmrc` keys that name a secret, Authorization header values, Bearer and
 * Basic credentials, npm and GitHub tokens, and URL user information. Each is
 * replaced with `[redacted]`, and the rest of the text is kept, so the failure
 * stays diagnosable. Redacting text again changes nothing.
 *
 * The repository-controls template carries its own GitHub token pattern,
 * because it runs in a project without Calavera installed.
 *
 * @param {string} text
 * @param {Record<string, string | undefined>} env
 * @returns {string}
 */
export function redactSecrets(text, env) {
  const secretValues = Object.entries(env)
    .filter(
      ([name, value]) =>
        SECRET_NAME.test(name) &&
        typeof value === "string" &&
        value.length >= MINIMUM_SECRET_VALUE_LENGTH,
    )
    .map(([, value]) => /** @type {string} */ (value))
    // A longer value first, so a value that contains another is replaced whole.
    .sort((a, b) => b.length - a.length);
  let redacted = text;

  for (const value of secretValues) {
    redacted = redacted.replaceAll(value, REDACTED);
  }

  for (const [pattern, replacement] of SECRET_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted;
}
