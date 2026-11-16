// @ts-check
import { stripVTControlCharacters } from "node:util";

import { redactSecrets } from "./redact.js";

// How much of a failure's own text Calavera shows: at most this many lines,
// each cut at this many characters.
export const FAILURE_OUTPUT_LINES = 10;
export const FAILURE_OUTPUT_LINE_LENGTH = 300;

/**
 * @param {string} line
 * @returns {string}
 */
export function truncateFailureLine(line) {
  return line.length > FAILURE_OUTPUT_LINE_LENGTH
    ? `${line.slice(0, FAILURE_OUTPUT_LINE_LENGTH)}… [line truncated]`
    : line;
}

/**
 * @typedef {{ name?: string, message: string, code?: string, stack?: string }} ErrorChainEntry
 */

/**
 * Whether the opt-in debug switch is on: `CALAVERA_DEBUG` set to `1` or
 * `true`, in any case. An environment variable, not a flag, so that it also
 * reaches an MCP server that an agent client starts.
 *
 * @param {Record<string, string | undefined>} [env]
 */
export function isDebugEnabled(env = process.env) {
  return /^(?:1|true)$/i.test(env.CALAVERA_DEBUG ?? "");
}

// A line of a V8 stack trace that names a call site.
const STACK_FRAME = /^\s+at\s/;

/**
 * Reads a property without letting a throwing getter or proxy escape.
 *
 * @param {unknown} value
 * @param {string} key
 * @returns {unknown}
 */
function readProperty(value, key) {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    return undefined;
  }

  try {
    return /** @type {Record<string, unknown>} */ (value)[key];
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function displayString(value) {
  try {
    return String(value);
  } catch {
    // An object without a prototype, or with a throwing toString, has no string form.
  }

  try {
    return Object.prototype.toString.call(value);
  } catch {
    // A revoked proxy throws even here.
    return "[a value that cannot be displayed]";
  }
}

/**
 * @param {unknown} value
 * @returns {unknown[]}
 */
function aggregateMembers(value) {
  try {
    return value instanceof AggregateError && Array.isArray(value.errors) ? value.errors : [];
  } catch {
    return [];
  }
}

/**
 * The text a value contributes to the chain. A child-process error from execa
 * contributes its `shortMessage`, the command and how it ended, not its
 * captured output: the wrapper shows the last lines of that output itself,
 * and the terminal has already shown standard error.
 *
 * @param {unknown} value
 * @returns {string}
 */
function ownText(value) {
  if (typeof value === "string") return value;

  const shortMessage = readProperty(value, "shortMessage");
  if (typeof shortMessage === "string") return shortMessage;

  const message = readProperty(value, "message");
  if (typeof message === "string") return message;
  if (message !== undefined) return displayString(message);

  return displayString(value);
}

/**
 * The call-site lines of a value's stack, redacted, without the header line or
 * lines that repeat its name and message, or undefined when it has none. The
 * frames are taken from after the first occurrence of the message, which keeps
 * a message line that looks like a frame out of them. V8 writes the header the
 * first time `stack` is read, so a message changed after that read no longer
 * occurs in it; then only the frame shape tells the header from the frames.
 *
 * The text is redacted before it is split into lines, as a message is, so that
 * a secret value spanning several lines is still found.
 *
 * @param {unknown} value
 * @param {(text: string) => string} redact
 * @returns {string[] | undefined}
 */
function stackFrames(value, redact) {
  const stack = readProperty(value, "stack");
  if (typeof stack !== "string") return undefined;

  const message = readProperty(value, "message");
  const messageIndex = typeof message === "string" ? stack.indexOf(message) : -1;
  const afterHeader =
    messageIndex === -1
      ? stack
      : stack.slice(messageIndex + /** @type {string} */ (message).length);
  const frames = redact(afterHeader)
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => STACK_FRAME.test(line));

  return frames.length > 0 ? frames : undefined;
}

/** @param {string} text */
function normalize(text) {
  return text.trim().replace(/\.$/, "");
}

/**
 * Whether `text` contains `part` as a whole, not as the start or end of a
 * longer word: "line 3" occurs in "line 3." but not in "line 31".
 *
 * @param {string} text
 * @param {string} part
 */
function containsWhole(text, part) {
  const isWordCharacter = (/** @type {string | undefined} */ character) =>
    character !== undefined && /\w/.test(character);

  for (let index = text.indexOf(part); index !== -1; index = text.indexOf(part, index + 1)) {
    if (!isWordCharacter(text[index - 1]) && !isWordCharacter(text[index + part.length])) {
      return true;
    }
  }

  return false;
}

/**
 * The error and each error under it, in the order a reader follows them: an
 * error, then its `cause`, then the members of an AggregateError, each once.
 * Every message, name, and code is redacted with `redactSecrets`, and terminal
 * control sequences are removed.
 *
 * One rule keeps the chain free of repeated text, so a wrapper may either
 * embed its cause's message in its own or defer to the cause:
 *
 * - A cause whose whole message, ignoring a final period, occurs in an earlier
 *   message is left out. A one-word message is exempt, because a word such as
 *   "install" occurs in many messages by chance.
 * - Otherwise, each line of the cause equal to a line of an earlier message is
 *   left out, and a cause with no line left is left out. A cause keeps at most
 *   FAILURE_OUTPUT_LINES lines, each cut at FAILURE_OUTPUT_LINE_LENGTH
 *   characters.
 *
 * The error itself is always kept in full.
 *
 * When `isDebugEnabled(env)`, each entry also carries `stack`: the call-site
 * lines of its stack, redacted the same way. A cause whose text the rule above
 * leaves out is then kept with an empty message, so that its stack is shown.
 *
 * @param {unknown} error
 * @param {Record<string, string | undefined>} [env] The environment whose secret values are redacted.
 * @returns {[ErrorChainEntry, ...ErrorChainEntry[]]}
 */
export function errorChain(error, env = process.env) {
  /** @type {ErrorChainEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const shownTexts = [];
  /** @type {Set<string>} */
  const shownLines = new Set();
  const visited = new Set();
  const debug = isDebugEnabled(env);
  /** @param {string} text */
  const redact = (text) => redactSecrets(stripVTControlCharacters(text), env);

  /** @param {unknown} value */
  const visit = (value) => {
    if (visited.has(value)) return;
    visited.add(value);

    const text = redact(ownText(value));
    const whole = normalize(text);
    const isError = entries.length === 0;
    const repeated =
      !isError && /\s/.test(whole) && shownTexts.some((previous) => containsWhole(previous, whole));
    let lines = repeated
      ? []
      : text
          .split("\n")
          .map((line) => line.trimEnd())
          .filter(
            (line) => normalize(line) !== "" && (isError || !shownLines.has(normalize(line))),
          );

    shownTexts.push(text);
    for (const line of text.split("\n")) shownLines.add(normalize(line));

    if (!isError && lines.length > FAILURE_OUTPUT_LINES) {
      const omitted = lines.length - FAILURE_OUTPUT_LINES;
      lines = [...lines.slice(0, FAILURE_OUTPUT_LINES), `… ${omitted} more lines`];
    }

    const name = readProperty(value, "name");
    const code = readProperty(value, "code");
    const frames = debug ? stackFrames(value, redact) : undefined;
    // A cause with an empty message of its own is still shown, by its name.
    if (
      isError ||
      lines.length > 0 ||
      (whole === "" && typeof name === "string" && name) ||
      frames !== undefined
    ) {
      entries.push({
        ...(typeof name === "string" && name ? { name: redact(name) } : {}),
        message: (isError ? lines : lines.map(truncateFailureLine)).join("\n"),
        ...(typeof code === "string" && code ? { code: redact(code) } : {}),
        ...(frames ? { stack: frames.join("\n") } : {}),
      });
    }

    const cause = readProperty(value, "cause");
    if (cause !== undefined) visit(cause);
    for (const member of aggregateMembers(value)) visit(member);
  };

  visit(error);
  // The first visit always adds the error itself.
  return /** @type {[ErrorChainEntry, ...ErrorChainEntry[]]} */ (entries);
}

/**
 * An entry as text: its message, after its name when the name is not plain
 * `Error`, or only its name when the message is empty.
 *
 * @param {ErrorChainEntry} entry
 */
function entryText({ name, message }) {
  if (message === "") return name ?? "";
  return name && name !== "Error" ? `${name}: ${message}` : message;
}

/**
 * An entry's text, followed by its stack frames when it carries them.
 *
 * @param {string} text
 * @param {ErrorChainEntry} entry
 */
function withStack(text, { stack }) {
  return stack ? `${text}\n${stack}` : text;
}

/**
 * The error chain as text for a terminal: the error, then each cause on a
 * line that starts with `Caused by:`, with further lines of that cause
 * indented. With the debug switch on, each entry's stack frames follow it.
 *
 * @param {unknown} error
 * @param {Record<string, string | undefined>} [env] The environment whose secret values are redacted.
 * @returns {string}
 */
export function formatErrorChain(error, env = process.env) {
  const [first, ...causes] = errorChain(error, env);

  return [
    withStack(entryText(first) || "Calavera stopped with an error that has no message.", first),
    ...causes.map(
      (cause) => `Caused by: ${withStack(entryText(cause), cause).split("\n").join("\n  ")}`,
    ),
  ].join("\n");
}
