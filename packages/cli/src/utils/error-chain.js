// @ts-check
import { stripVTControlCharacters } from "node:util";

import { isPlainObject } from "./guards.js";
import { redactSecrets } from "./redact.js";

/**
 * @typedef {{ name?: string, message: string, code?: string }} ErrorChainEntry
 */

/**
 * The error and each error under it, in the order a reader follows them: an
 * error, then its `cause`, then the members of an AggregateError, each once.
 * Every message is redacted with `redactSecrets` and stripped of terminal
 * control sequences.
 *
 * One rule keeps the chain free of repeated text, so a wrapper may either
 * embed its cause's message in its own or defer to the cause: a line of a
 * cause's message that an earlier message in the chain already contains is
 * left out, ignoring a final period the wrapper may have dropped, and a cause
 * with no line left is left out. The error itself is always kept.
 *
 * @param {unknown} error
 * @param {Record<string, string | undefined>} [env] The environment whose secret values are redacted.
 * @returns {[ErrorChainEntry, ...ErrorChainEntry[]]}
 */
export function errorChain(error, env = process.env) {
  /** @type {ErrorChainEntry[]} */
  const entries = [];
  /** @type {string[]} */
  const shown = [];
  const visited = new Set();

  /** @param {unknown} value */
  const visit = (value) => {
    if (visited.has(value)) return;
    visited.add(value);

    const text = redactSecrets(
      stripVTControlCharacters(value instanceof Error ? value.message : String(value)),
      env,
    );
    const lines = text
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => {
        const content = line.trim().replace(/\.$/, "");
        return content !== "" && !shown.some((previous) => previous.includes(content));
      });
    shown.push(text);

    if (entries.length === 0 || lines.length > 0) {
      const code = isPlainObject(value) && typeof value.code === "string" ? value.code : undefined;
      entries.push({
        ...(value instanceof Error ? { name: value.name } : {}),
        message: lines.join("\n"),
        ...(code ? { code } : {}),
      });
    }

    if (value instanceof Error && value.cause !== undefined) visit(value.cause);
    if (value instanceof AggregateError) {
      for (const member of value.errors) visit(member);
    }
  };

  visit(error);
  // The first visit always adds the error itself.
  return /** @type {[ErrorChainEntry, ...ErrorChainEntry[]]} */ (entries);
}

/**
 * The error chain as text for a terminal: the error's message, then each
 * cause on a line that starts with `Caused by:`, with further lines of that
 * cause indented.
 *
 * @param {unknown} error
 * @param {Record<string, string | undefined>} [env] The environment whose secret values are redacted.
 * @returns {string}
 */
export function formatErrorChain(error, env = process.env) {
  const [first, ...causes] = errorChain(error, env);

  return [
    first.message,
    ...causes.map(({ message }) => `Caused by: ${message.split("\n").join("\n  ")}`),
  ].join("\n");
}
