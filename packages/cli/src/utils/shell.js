// @ts-check

/**
 * Characters that zsh and bash pass through unchanged anywhere in a word. It leaves out `~` and
 * `^`. Both shells expand a leading `~` to a home directory, and both expand a `~` after `=` or
 * `:` in an argument shaped like an assignment (bash by default, zsh with MAGIC_EQUAL_SUBST).
 * zsh's EXTENDED_GLOB option treats `^` as a pattern character anywhere in a word.
 */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/**
 * Quotes a token for display when a shell would otherwise split or expand it, so a pasted command
 * runs as printed in zsh and bash (#1037). A token that starts with `=` is quoted because zsh's
 * EQUALS option, on by default, replaces `=cmd` with the path of `cmd`. One that holds `==` or `:=`
 * is quoted because zsh's MAGIC_EQUAL_SUBST option applies that expansion after the first `=` and
 * after each `:` in an argument shaped like an assignment.
 *
 * @param {string} token
 * @returns {string}
 */
export function quoteShellToken(token) {
  return PLAIN_WORD.test(token) &&
    !token.startsWith("=") &&
    !token.includes("==") &&
    !token.includes(":=")
    ? token
    : `'${token.replaceAll("'", `'\\''`)}'`;
}

/**
 * @param {{ command: string, args: string[] }} launchCommand
 * @returns {string}
 */
export function formatShellCommand(launchCommand) {
  return [launchCommand.command, ...launchCommand.args].map(quoteShellToken).join(" ");
}
