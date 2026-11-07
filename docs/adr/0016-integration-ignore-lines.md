# ADR-0016: Integrations Declare Their Ignore Lines in Catalog Metadata

- **Status:** Proposed (2026-11-07)
- **Date:** 2026-11-07
- **Issue:** https://github.com/schalkneethling/create-project-calavera/issues/733
- **Decides:** how a catalog integration adds lines to a project's `.gitignore` and to the `.htmlvalidateignore` file that Calavera manages. An integration declares the lines in an optional `ignore` field of its catalog entry. Apply writes the `.gitignore` lines as one marked block per integration, records what it wrote in `.calavera/state.json`, and removes or replaces the block only while it still holds that text. It writes the `.htmlvalidateignore` lines into the managed file, which it already owns as a whole. Varlock keeps its own merge. None of the C8 safety properties is weakened.

## Context

Stryker writes `.stryker-tmp/` and `reports/mutation/` into a project. In a scratch `vp create` library, `vp check` failed on formatting `reports/mutation/mutation.html` until `.gitignore` listed that folder. html-validate does not read `.gitignore`, so the managed `lint:html` wrapper (`packages/cli/src/templates/lint-html.mjs`) also linted the report and failed (#733). The Stryker catalog entry (#734) therefore needs a way to add ignore lines to both files.

Today only Varlock adds lines to `.gitignore`, through `mergeVarlockGitignore` in `packages/cli/src/index.js`. It appends the Varlock lines that are missing, under a `# Varlock` heading, with no markers and no record, so a later apply cannot tell its lines from the person's and never removes them. `.htmlvalidateignore` is a managed file: apply writes it whole from the constant `HTML_VALIDATE_IGNORE` and records its hash, so an edit is already a conflict.

Issue #814 records the owner's longer-term direction: integrations and artifacts declare the ignore lines they need in metadata, and the CLI writes them as a marked block, like the `.vite-hooks` blocks of ADR-0015 Decision 5. It asks for an ADR on the metadata shape and the marker format first. This ADR is that decision for integrations.

The catalog shape is part of interface contract surface I7 (`docs/cross-repo/interface-contract.md`). Calavera owns I7, and I7 freezes at Calavera Checkpoint 3, which has not been reached. An optional field is an additive change, so no cross-repo request is needed.

## Decision

### 1. The `ignore` field

A catalog integration may declare an `ignore` object with two optional lists of lines:

```js
{
  id: "stryker",
  // ...
  ignore: {
    gitignore: [".stryker-tmp/", "reports/mutation/"],
    htmlValidateIgnore: ["reports/mutation/"],
  },
}
```

- `gitignore` holds lines for the project's `.gitignore`.
- `htmlValidateIgnore` holds lines for `.htmlvalidateignore`. They take effect only when the recipe also selects `html-validate`, because only then does the file exist.

Each line is a single line of text in the syntax both files share, the `.gitignore` pattern syntax. A line may not be empty or contain a line break, and a `.gitignore` line may not be a Calavera marker. A catalog test checks every entry, so a bad line fails in this repository rather than in a project.

The `html-validate` entry declares its own four lines, `node_modules/`, `dist/`, `coverage/`, and `.claude/worktrees/`, in `ignore.htmlValidateIgnore`, and the `HTML_VALIDATE_IGNORE` constant goes. A recipe with `html-validate` alone produces the same bytes as before.

### 2. The `.gitignore` block

Apply writes one block per integration that declares `gitignore` lines, delimited by the same markers as the `.vite-hooks` blocks of ADR-0015 Decision 5, with the integration's id in place of the artifact's:

```gitignore
# calavera:stryker:start
.stryker-tmp/
reports/mutation/
# calavera:stryker:end
```

- When `.gitignore` does not exist, apply creates it with the blocks alone.
- When it exists without the block, apply appends the block at the end. Every line already in the file stays as it is, in order. If the last line has no line break, apply adds one before the block. A file with Windows line endings gets them on the added lines too.
- When the block exists and holds the declared lines, nothing changes, and the dry run reports `.gitignore` as unchanged.
- When the block holds what the state record says apply wrote last, apply replaces the lines between the markers. This happens when a newer catalog declares different lines.
- When the block holds anything else, the person edited it. Apply stops before it writes anything, with a conflict that names the file and shows what Calavera wrote, what the file holds, and what Calavera would write. A block with no record is treated the same way.
- When only one marker is present, or a marker line was changed, apply stops with a conflict, because it cannot tell where its block ends.

Blocks are appended in catalog order. Apply does not remove a line from a block because the person's own lines already list it, because the block must stay exactly what apply recorded for an edit to be detectable. A pattern listed twice in `.gitignore` is harmless.

### 3. The state record

`.calavera/state.json` gains `gitignoreBlocks`, a list of `{ "integration": "<id>", "lines": ["<line>", ...] }`, one entry for each block in the file after apply. It is the only way apply can tell its own unchanged block from one the person edited. `.htmlvalidateignore` needs no new record, because the managed-file hash already covers the whole file.

### 4. Removal

When the recipe no longer selects an integration, or the integration no longer declares `gitignore` lines, apply removes its block, markers included, only while the block still holds the recorded lines. An edited block is a conflict, not a silent deletion. The person removes the block themselves, or deletes its markers to keep the lines as their own, and runs apply again. A block the person already removed needs nothing. After apply, the record lists only the blocks that remain. Removing a block takes out exactly the lines apply added, so a file that ended with a line break before the block was added is byte-for-byte what it was. A `.gitignore` that apply created stays in place, even when it is left empty, because only `clean` removes a file.

For `.htmlvalidateignore`, apply writes the file from the integrations the recipe selects, so a deselected integration's lines are gone after the next apply.

### 5. The dry run

The dry run lists each block apply would add, replace, keep, or remove, with its lines, and the lines each integration adds to `.htmlvalidateignore` and the lines that file loses. `apply --dry-run` prints them, and `dry_run_apply` returns them as `ignoreChanges`. After apply, a second dry run reports `.gitignore` and `.htmlvalidateignore` as unchanged.

### 6. Varlock keeps its own merge

#733 requires Varlock's behavior and tests to stay unchanged. Moving Varlock onto the block would add marker lines to every project that selects Varlock, and a project already applied would get a block that repeats the Varlock lines it already has. Varlock therefore keeps `mergeVarlockGitignore`. When a recipe selects Varlock and an integration with `gitignore` lines, apply plans the blocks first and merges the Varlock lines into the result, so the dry run reports one change to `.gitignore`. Moving Varlock onto the block, with a migration for the unmarked section in existing projects, is a separate decision.

### 7. How C8 holds

No C8 test changes.

- **Only the CLI writes into projects.** Apply writes the blocks and the managed file.
- **`dry_run_apply` is the approval boundary.** The dry run lists every line apply adds or removes (Decision 5).
- **Local edits are preserved.** Apply writes only between its own markers and keeps every other line of `.gitignore` byte for byte and in order. An edited block is a hard stop.
- **Artifacts are not written to `package.json`.** Nothing here touches `package.json`.
- **Conflicts surface as a hard stop.** An edited block, a changed marker, and an unpaired marker stop apply, and the dry run, before anything is written.

## Consequences

#734 can declare Stryker's lines in its catalog entry and write no code for them.

`.gitignore` becomes a file that apply may stop on. Before this ADR, apply never refused because of `.gitignore`.

`doctor` does not yet report a missing or edited block, and `clean` does not remove blocks. Both would follow the wiring behavior that ADR-0015 Decision 5 and #829 describe for hook blocks, and they are left to #857 (`doctor`) and #858 (`clean`).

## Alternatives considered

**Extend Varlock's merge to every integration.** Not chosen. It appends only the missing lines and keeps no record, so apply could never remove an integration's lines without risking the person's own, and could not tell an edit from its own text.

**One shared Calavera block for all integrations.** Not chosen. Removing one integration would mean rewriting a block that holds the others' lines, and an edit to one integration's lines would block every integration.

**Put the html-validate lines under the existing `htmlValidate` field.** Not chosen. `htmlValidate` holds configuration for `.htmlvalidate.json`. Keeping both ignore files under `ignore` puts the knowledge "this tool writes these paths" in one place for each integration.

**Artifacts declaring ignore lines.** #814 also names artifacts. No artifact needs ignore lines today, so this ADR covers integrations only. An artifact would need its own record key, because an artifact id and an integration id can be equal.
