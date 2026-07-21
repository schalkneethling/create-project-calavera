import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { tabFocusIndex } from "../src/tabs.js";

const html = await readFile(new URL("../index.html", import.meta.url), "utf8");
const script = await readFile(new URL("../src/main.js", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("generated-output controls expose the APG tabs relationships", () => {
  assert.match(html, /role="tablist" aria-label="Generated configuration formats"/);
  for (const format of ["calavera", "rule", "config"]) {
    assert.match(
      html,
      new RegExp(
        `id="output-tab-${format}"[\\s\\S]+?role="tab"[\\s\\S]+?aria-controls="output-panel-${format}"`,
      ),
    );
    assert.match(
      html,
      new RegExp(
        `id="output-panel-${format}"[\\s\\S]+?role="tabpanel"[\\s\\S]+?aria-labelledby="output-tab-${format}"`,
      ),
    );
  }
  assert.match(script, /setAttribute\("aria-selected"/);
  assert.match(script, /tab\.tabIndex = selected \? 0 : -1/);
  assert.match(script, /panel\.hidden = panel\.dataset\.outputPanel !== output/);
  assert.match(script, /event\.key === "Enter" \|\| event\.key === " "/);
  assert.match(script, /outputTabs\[nextIndex\]\.tabIndex = 0/);
  assert.match(styles, /\.output-tabs button\[aria-selected="true"\]/);
});

test("manual tabs keyboard navigation moves focus without selecting", () => {
  assert.equal(tabFocusIndex(0, "ArrowLeft", 3), 2);
  assert.equal(tabFocusIndex(2, "ArrowRight", 3), 0);
  assert.equal(tabFocusIndex(1, "Home", 3), 0);
  assert.equal(tabFocusIndex(1, "End", 3), 2);
  assert.equal(tabFocusIndex(1, "Enter", 3), null);
  assert.equal(tabFocusIndex(1, "Tab", 3), null);
});
