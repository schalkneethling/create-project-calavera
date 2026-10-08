// @ts-check

const REDACTED = "[redacted]";

// A name, of an environment variable, a configuration key, a query parameter,
// or a command-line flag, whose value is a secret. Only the name is known, so a
// secret in a variable with an innocent name, such as `MY_VALUE`, cannot be
// redacted by name; it is redacted only when its shape is one of
// SHAPE_PATTERNS.
const SECRET_NAME = new RegExp(
  [
    "TOKEN",
    "SECRET",
    "PASSWORD",
    "PASSWD",
    "PASSPHRASE",
    "(?<![a-z])PASS(?![a-z])",
    "CREDENTIAL",
    "API[_-]?KEY",
    "ACCESS[_-]?KEY",
    "PRIVATE[_-]?KEY",
    "AUTH(?!OR)",
    "COOKIE",
    "SESSION",
    "(?:^|[_-])PAT$",
    "(?:^|[_-])KEY$",
  ].join("|"),
  "i",
);

// The working directory variables hold paths, never secrets.
const NEVER_SECRET_NAME = /^(?:OLD)?PWD$/i;

// A shorter value, such as `true` or `1`, is a setting, not a secret, and
// redacting it everywhere it appears would hide ordinary text.
const MINIMUM_SECRET_VALUE_LENGTH = 8;

/** @param {string} name */
function isSecretName(name) {
  const bare = name.replace(/^-+/, "");
  return bare !== "" && !NEVER_SECRET_NAME.test(bare) && SECRET_NAME.test(bare);
}

// A header whose whole value is a credential. The value runs to the end of the
// line, because a Cookie value holds spaces and an Authorization value holds
// its scheme.
const SECRET_HEADER =
  /(?<![A-Za-z0-9_-])((?:proxy-)?authorization|x-api-key|set-cookie|cookie)(["']?[ \t]*:[ \t]*)[^\r\n]+/gi;

// A name followed by `=` or `:`, as in `NAME=value`, `--token=value`,
// `?token=value`, `"_authToken": "value"`, or `token: value`; or a flag
// followed by a space, as in `--token value`. The lookbehind starts a match
// only at the start of a name, so the scan stays linear in the text length.
const KEY_CANDIDATE = /(?<![A-Za-z0-9_-])([A-Za-z0-9_-]+)(["']?[ \t]*[=:][ \t]*|[ \t]+)/g;
// An unquoted value ends at white space, a quote, or a character that
// separates values in a query string, a list, or a URL's user information.
const UNQUOTED_VALUE = /[^\s"'&,;@]+/y;

/**
 * Replaces the value after each name that names a secret. A value after a
 * name that does not is scanned in turn, so `https://host/:_authToken=value`
 * still has its token redacted.
 *
 * @param {string} text
 */
function redactKeyedValues(text) {
  let output = "";
  let copied = 0;
  KEY_CANDIDATE.lastIndex = 0;

  for (let match = KEY_CANDIDATE.exec(text); match; match = KEY_CANDIDATE.exec(text)) {
    // Both groups always take part in a match.
    const [, name = "", separator = ""] = match;
    const valueStart = match.index + match[0].length;
    const flag = /^\s+$/.test(separator);

    if (!isSecretName(name) || (flag && !name.startsWith("-"))) {
      KEY_CANDIDATE.lastIndex = valueStart;
      continue;
    }

    const quote = text[valueStart] === '"' || text[valueStart] === "'" ? text[valueStart] : "";
    let valueEnd;

    if (quote) {
      const closing = text.indexOf(quote, valueStart + 1);
      const lineEnd = text.indexOf("\n", valueStart + 1);
      valueEnd =
        closing === -1 || (lineEnd !== -1 && lineEnd < closing)
          ? lineEnd === -1
            ? text.length
            : lineEnd
          : closing;
    } else {
      UNQUOTED_VALUE.lastIndex = valueStart;
      valueEnd = UNQUOTED_VALUE.test(text) ? UNQUOTED_VALUE.lastIndex : valueStart;
    }

    const valueFrom = valueStart + quote.length;
    if (valueEnd <= valueFrom || (flag && text[valueStart] === "-")) {
      KEY_CANDIDATE.lastIndex = valueStart;
      continue;
    }

    output += `${text.slice(copied, valueFrom)}${REDACTED}`;
    copied = valueEnd;
    KEY_CANDIDATE.lastIndex = valueEnd;
  }

  return output + text.slice(copied);
}

/**
 * A Bearer credential holds a digit or a base64 character, so the word after
 * "Bearer" in prose is kept.
 *
 * @param {string} match
 * @param {string} scheme
 * @param {string} credential
 */
function redactBearer(match, scheme, credential) {
  return /[0-9=+/]/.test(credential) ? `${scheme} ${REDACTED}` : match;
}

/**
 * A Basic credential is base64 for `user:password`, so the word after "Basic"
 * in prose, such as "Basic configuration", is kept.
 *
 * @param {string} match
 * @param {string} scheme
 * @param {string} credential
 */
function redactBasic(match, scheme, credential) {
  const decoded = Buffer.from(credential, "base64").toString("latin1");
  return /^[\x20-\x7e]*:[\x20-\x7e]*$/.test(decoded) ? `${scheme} ${REDACTED}` : match;
}

/** @type {[RegExp, (match: string, ...groups: string[]) => string][]} */
const SHAPE_PATTERNS = [
  [/\b(Bearer)\s+([A-Za-z0-9._~+/-]+=*)/g, redactBearer],
  [/\b(Basic)\s+([A-Za-z0-9+/]+={0,2})(?![A-Za-z0-9+/=])/g, redactBasic],
  // npm access tokens, the shape @npmcli/redact matches.
  [/\bnpms?_[A-Za-z0-9]{36,48}\b/g, () => REDACTED],
  // GitHub tokens: classic, OAuth, user-to-server, server-to-server, refresh, and fine-grained.
  [/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g, () => REDACTED],
  // The user information of a URL, which can hold a token or a password.
  [
    /(?<![a-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@]+@/gi,
    (_match, scheme) => `${scheme}${REDACTED}@`,
  ],
];

/**
 * Removes secrets from text before Calavera displays it, replacing each with
 * `[redacted]` and keeping the rest of the text, so the failure stays
 * diagnosable:
 *
 * - the value of every variable in `env` whose name names a secret
 * - the value of an Authorization, Proxy-Authorization, X-Api-Key, Cookie, or
 *   Set-Cookie header
 * - the value after a key, query parameter, or flag that names a secret, such
 *   as `NPM_TOKEN=`, `//registry/:_authToken=`, `?token=`, `"password": `,
 *   or `--token `
 * - Bearer and Basic credentials, npm and GitHub tokens, and URL user
 *   information
 *
 * Redacting text again changes nothing. Each pattern starts a match only where
 * a name or a fixed word starts, so the time taken grows linearly with the text.
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
        isSecretName(name) &&
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

  redacted = redactKeyedValues(redacted.replace(SECRET_HEADER, `$1$2${REDACTED}`));

  for (const [pattern, replacement] of SHAPE_PATTERNS) {
    redacted = redacted.replace(pattern, replacement);
  }

  return redacted;
}
