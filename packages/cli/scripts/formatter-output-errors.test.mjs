// Issue #1157: when the project's formatter fails or returns text that does not hold what
// Calavera sent, the error names the file, the kind of failure, and the remedy. It never quotes
// the formatter's output or the text Calavera sent, because vp fmt quotes the file it cannot
// parse, and vite.config.ts can print anything, such as values from .env.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";

import { formatErrorChain } from "../src/utils/error-chain.js";
import { formatGeneratedText } from "../src/utils/generated-text.js";
import { writeJSON } from "../src/utils/json-rewrite.js";
import { loadProjectFormatter } from "../src/utils/project-formatter.js";
import { createTemporaryFixture, writeVitePlusFormatter } from "./vite-plus-fixtures.mjs";

// Not shaped like any token redactSecrets knows, so only the error handling can keep it out.
const SECRET = "FAKE_SECRET_9f3a7c";

/**
 * Asserts that `error` and everything a debug run would print of it hold no planted secret, and
 * that it has no cause that could carry the formatter's output.
 *
 * @param {unknown} error
 */
function assertQuotesNothing(error) {
  assert.ok(error instanceof Error);
  assert.equal(error.cause, undefined);
  const output = formatErrorChain(error, { CALAVERA_DEBUG: "1" });
  assert.ok(!output.includes("FAKE_SECRE"), `The error quotes the text:\n${output}`);
  return error.message;
}

test("vp fmt that cannot parse the text: the error names the exit code and the remedy, not vp fmt's output", async () => {
  await using project = await createTemporaryFixture("formatter-output-parse", {});
  await writeVitePlusFormatter(project.root);
  const formatter = await loadProjectFormatter(project.root, "managed");

  await assert.rejects(
    formatter.format(".claude/settings.json", `{\n  "token": ${SECRET}\n}\n`),
    (error) => {
      assert.match(
        assertQuotesNothing(error),
        /^vp fmt from vite-plus \S+ could not format \.claude\/settings\.json: it exited with code 2\. Calavera does not show vp fmt's output, because it can quote the file\. Run vp fmt --check in the project to see that output, then run Calavera again\.$/,
      );
      return true;
    },
  );
});

test("vp fmt that fails with its own message: the message is left out, and distinct exit codes stay visible", async () => {
  await using project = await createTemporaryFixture("formatter-output-fail", {});
  await writeVitePlusFormatter(project.root, { failFor: "a.json" });
  const formatter = await loadProjectFormatter(project.root, "managed");

  await assert.rejects(formatter.format("a.json", "{}\n"), (error) => {
    assert.match(assertQuotesNothing(error), /could not format a\.json: it exited with code 2\./);
    assert.ok(!error.message.includes("vp stub"), error.message);
    return true;
  });
});

test("vp fmt that is stopped by a signal: the error names the signal, a different failure from an exit code", async () => {
  await using project = await createTemporaryFixture("formatter-output-signal", {});
  await writeVitePlusFormatter(project.root);
  await writeFile(
    join(project.root, "node_modules/vite-plus/bin/vp"),
    `console.error("API_KEY=${SECRET}");\nprocess.kill(process.pid, "SIGTERM");\n`,
  );
  const formatter = await loadProjectFormatter(project.root, "managed");

  await assert.rejects(formatter.format("a.json", "{}\n"), (error) => {
    assert.match(
      assertQuotesNothing(error),
      /could not format a\.json: it was stopped by the signal SIGTERM\. Calavera does not show/,
    );
    return true;
  });
});

test("vp fmt that never finishes: the error says it was stopped, with no cause that holds its output", async () => {
  await using project = await createTemporaryFixture("formatter-output-hang", {});
  await writeVitePlusFormatter(project.root, { banner: `API_KEY=${SECRET}`, hang: true });
  const formatter = await loadProjectFormatter(project.root, "managed", { timeout: 500 });

  await assert.rejects(formatter.format(".claude/settings.json", "{}\n"), (error) => {
    assert.match(
      assertQuotesNothing(error),
      /did not finish formatting \.claude\/settings\.json within 0\.5 seconds, so Calavera stopped it\./,
    );
    return true;
  });
});

test("vp fmt whose vite.config.ts prints before Markdown: the error says so without quoting either line", async () => {
  await using project = await createTemporaryFixture("formatter-output-markdown", {});
  await writeVitePlusFormatter(project.root, { banner: `API_KEY=${SECRET}` });
  const formatter = await loadProjectFormatter(project.root, "managed");

  await assert.rejects(
    formatGeneratedText("docs/notes.md", `# Notes for ${SECRET}\n`, async () => formatter),
    (error) => {
      assert.match(
        assertQuotesNothing(error),
        /^vp fmt from vite-plus \S+ returned text for docs\/notes\.md that does not start with the first line Calavera sent, so something came before the formatted text, such as output that vite\.config\.ts printed\. Make sure vite\.config\.ts prints nothing when vp fmt loads it, then run Calavera again\.$/,
      );
      return true;
    },
  );
});

test("a formatter that returns only the first line of Markdown is a different failure from stray output", async () => {
  const formatter = { description: "a test formatter", format: async () => "# Notes" };

  await assert.rejects(
    formatGeneratedText("docs/notes.md", `# Notes\n\n${SECRET}\n`, async () => formatter),
    (error) => {
      assert.match(
        assertQuotesNothing(error),
        /^a test formatter returned text for docs\/notes\.md that ends after the first line, so it lost the rest of what Calavera sent\. /,
      );
      return true;
    },
  );
});

test("vp fmt whose vite.config.ts prints before JSON: the error says the text is not JSON, without quoting it", async () => {
  await using project = await createTemporaryFixture("formatter-output-json", {});
  await writeVitePlusFormatter(project.root, { banner: `API_KEY=${SECRET}` });
  const formatter = await loadProjectFormatter(project.root, "managed");

  await assert.rejects(
    writeJSON({ token: SECRET }, ".claude/settings.json", formatter),
    (error) => {
      assert.match(
        assertQuotesNothing(error),
        /^vp fmt from vite-plus \S+ returned text for \.claude\/settings\.json that is not JSON, so something came with the formatted text, such as output that vite\.config\.ts printed\. Make sure vite\.config\.ts prints nothing when vp fmt loads it, then run Calavera again\.$/,
      );
      return true;
    },
  );
});

test("a formatter that returns other JSON values is a different failure from stray output", async () => {
  const formatter = { description: "a test formatter", format: async () => '{"token": "other"}\n' };

  await assert.rejects(writeJSON({ token: SECRET }, "a.json", formatter), (error) => {
    assert.match(
      assertQuotesNothing(error),
      /^a test formatter returned text for a\.json that is JSON but holds other values than the ones Calavera sent\. /,
    );
    return true;
  });
});
