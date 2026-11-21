// @ts-check

/**
 * Characters that zsh and bash pass through unchanged anywhere in a word. It leaves out `~` and
 * `^`: both shells expand a leading `~` to a home directory, bash also expands one after `=` or
 * `:` in an assignment-shaped argument, and zsh's EXTENDED_GLOB option treats `~` and `^` as
 * pattern characters anywhere in a word.
 */
const PLAIN_WORD = /^[\w@%+=:,./-]+$/;

/**
 * Quotes a token for display when a shell would otherwise split or expand it, so a pasted command
 * runs as printed in zsh and bash (#1037). A token that starts with `=` is quoted because zsh's
 * EQUALS option, on by default, replaces `=cmd` with the path of `cmd`; one that holds `==` is
 * quoted because zsh's MAGIC_EQUAL_SUBST option applies that expansion after `=` in an argument.
 *
 * @param {string} token
 * @returns {string}
 */
export function quoteShellToken(token) {
  return PLAIN_WORD.test(token) && !token.startsWith("=") && !token.includes("==")
    ? token
    : `'${token.replaceAll("'", `'\\''`)}'`;
}
