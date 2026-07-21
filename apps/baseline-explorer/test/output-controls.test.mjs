import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("generated-output controls use toggle-button semantics", () => {
  assert.doesNotMatch(html, /role="tab(?:list)?"/);
  assert.doesNotMatch(html, /aria-selected/);
  assert.match(html, /aria-pressed="true" data-output="calavera"/);
  assert.match(html, /aria-pressed="false" data-output="rule"/);
  assert.match(html, /aria-pressed="false" data-output="config"/);
  assert.match(script, /setAttribute\("aria-pressed"/);
  assert.doesNotMatch(script, /setAttribute\("aria-selected"/);
  assert.match(styles, /\.output-tabs button\[aria-pressed="true"\]/);
});
