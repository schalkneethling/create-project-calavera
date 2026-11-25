// @ts-check

/**
 * The ways formatting the files Calavera writes can fail, so a caller that must not quote the
 * message, such as the project phase that the doctors read (ADR-0020, Decision 3), can still say
 * which failure it was and give that failure's remedy.
 *
 * - `not-installed`: the project uses Vite+, and its vite-plus package cannot be found.
 * - `no-vp-command`: the vite-plus package has no vp command.
 * - `editorconfig-change`: Calavera's `.editorconfig` would change how vp fmt formats the file.
 * - `editorconfig-removal`: removing the `.editorconfig` would change how vp fmt formats the file.
 * - `timeout`: a vp fmt run did not finish in time.
 * - `failed`: a vp fmt run did not succeed.
 * - `printed-output`: something came with the formatted text, such as output that vite.config.ts
 *   printed.
 * - `changed-content`: the formatted text lost or changed what Calavera sent.
 *
 * @typedef {"not-installed" | "no-vp-command" | "editorconfig-change" | "editorconfig-removal" | "timeout" | "failed" | "printed-output" | "changed-content"} FormatterFailureKind
 */

/** An error from formatting a file Calavera writes, with the kind of failure it was. */
export class FormatterFailure extends Error {
  /**
   * @param {FormatterFailureKind} kind
   * @param {string} message
   * @param {ErrorOptions} [options]
   */
  constructor(kind, message, options) {
    super(message, options);
    this.kind = kind;
  }
}
