# Accessibility Testing

Automated accessibility testing catches common issues early. Combine with manual testing and assistive technology validation for comprehensive coverage.

## Limitations of Automated Testing

Automated tools detect approximately 30-40% of accessibility issues. They catch:

- Missing labels and alt text
- Color contrast violations
- Invalid ARIA attributes
- Duplicate IDs
- Missing landmark regions

They cannot catch:

- Logical reading order
- Meaningful link text in context
- Appropriate focus management
- Keyboard trap issues in complex flows
- Whether content is actually understandable

**Always combine automated testing with manual review and user testing.**

## Playwright + axe-core Integration

### Setup

```bash
npm install @axe-core/playwright --save-dev
```

### Basic Page Scan

```javascript
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test.describe("Homepage", () => {
  test("has no automatically detectable accessibility violations", async ({ page }) => {
    await page.goto("/");

    const accessibilityScanResults = await new AxeBuilder({ page }).analyze();

    expect(accessibilityScanResults.violations).toEqual([]);
  });
});
```

### Wait for Page State

Always ensure the page is in the expected state before scanning:

```javascript
test("navigation menu is accessible when open", async ({ page }) => {
  await page.goto("/");

  // Open the menu
  await page.getByRole("button", { name: /menu/i }).click();

  // Wait for menu to be visible before scanning
  await page.getByRole("navigation", { name: /main/i }).waitFor();

  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations).toEqual([]);
});
```

### Scan Specific Regions

Focus on components you're testing:

```javascript
test("checkout form is accessible", async ({ page }) => {
  await page.goto("/checkout");

  const results = await new AxeBuilder({ page })
    .include("#checkout-form") // Only scan this region
    .analyze();

  expect(results.violations).toEqual([]);
});
```

### Exclude Known Issues

Temporarily exclude elements while fixing issues:

```javascript
const results = await new AxeBuilder({ page })
  .exclude("#third-party-widget") // Can't control this
  .exclude("[data-ad-unit]") // Ads managed externally
  .analyze();
```

**Important**: Document why exclusions exist. Remove them when fixed.

## WCAG Targeting

### Target Specific WCAG Levels

```javascript
// WCAG 2.1 Level AA (most common compliance target)
const results = await new AxeBuilder({ page })
  .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
  .analyze();

// WCAG 2.2 (latest standard)
const results = await new AxeBuilder({ page })
  .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"])
  .analyze();

// Best practices (not WCAG requirements but recommended)
const results = await new AxeBuilder({ page }).withTags(["best-practice"]).analyze();
```

### Common Tag Sets

| Target         | Tags                                           |
| -------------- | ---------------------------------------------- |
| WCAG 2.1 AA    | `["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]` |
| WCAG 2.2 AA    | Add `"wcag22aa"`                               |
| Section 508    | `["section508"]`                               |
| Best practices | `["best-practice"]`                            |

## Creating Reusable Fixtures

### Custom Test Fixture

```javascript
// fixtures/axe.js
import { test as base } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

export const test = base.extend({
  makeAxeBuilder: async ({ page }, use) => {
    const makeAxeBuilder = () =>
      new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .exclude("#cookie-banner") // Known third-party issue
        .exclude("[data-testid='ad-unit']");

    await use(makeAxeBuilder);
  },
});

export { expect } from "@playwright/test";
```

### Using the Fixture

```javascript
import { test, expect } from "./fixtures/axe";

test("product page is accessible", async ({ page, makeAxeBuilder }) => {
  await page.goto("/products/123");

  const results = await makeAxeBuilder().analyze();

  expect(results.violations).toEqual([]);
});
```

## Handling Violations

### Understanding Results

```javascript
const results = await new AxeBuilder({ page }).analyze();

// Structure of a violation
results.violations.forEach((violation) => {
  console.log(`Rule: ${violation.id}`);
  console.log(`Impact: ${violation.impact}`); // minor, moderate, serious, critical
  console.log(`Description: ${violation.description}`);
  console.log(`Help: ${violation.helpUrl}`);

  violation.nodes.forEach((node) => {
    console.log(`  Element: ${node.html}`);
    console.log(`  Fix: ${node.failureSummary}`);
  });
});
```

### Impact Levels

| Level    | Description                  | Priority              |
| -------- | ---------------------------- | --------------------- |
| Critical | Blocks access for some users | Fix immediately       |
| Serious  | Major barriers               | Fix soon              |
| Moderate | Inconsistencies              | Plan to fix           |
| Minor    | Annoyances                   | Improve when possible |

### Progressive Enforcement

Start permissive, tighten over time:

```javascript
// Phase 1: Only critical issues fail
const criticalViolations = results.violations.filter((v) => v.impact === "critical");
expect(criticalViolations).toEqual([]);

// Phase 2: Critical and serious
const seriousViolations = results.violations.filter((v) =>
  ["critical", "serious"].includes(v.impact),
);
expect(seriousViolations).toEqual([]);

// Phase 3: All violations (goal state)
expect(results.violations).toEqual([]);
```

### Disable Specific Rules

When you have a known issue being addressed:

```javascript
const results = await new AxeBuilder({ page })
  .disableRules(["color-contrast"]) // Tracked in JIRA-123
  .analyze();
```

**Document why rules are disabled. Remove when fixed.**

## Integration Patterns

### Per-Component Tests

Test components in isolation:

```javascript
test.describe("Button component", () => {
  test("default button is accessible", async ({ page }) => {
    await page.goto("/storybook/button--default");
    const results = await new AxeBuilder({ page }).include("#storybook-root").analyze();
    expect(results.violations).toEqual([]);
  });

  test("disabled button is accessible", async ({ page }) => {
    await page.goto("/storybook/button--disabled");
    const results = await new AxeBuilder({ page }).include("#storybook-root").analyze();
    expect(results.violations).toEqual([]);
  });
});
```

### Critical User Flows

Scan at each step of important journeys:

```javascript
test("checkout flow is accessible at each step", async ({ page }) => {
  // Cart page
  await page.goto("/cart");
  let results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  // Shipping form
  await page.getByRole("link", { name: /checkout/i }).click();
  await page.getByRole("heading", { name: /shipping/i }).waitFor();
  results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  // Payment form
  await page.getByRole("button", { name: /continue/i }).click();
  await page.getByRole("heading", { name: /payment/i }).waitFor();
  results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
```

### After Dynamic Content

Always re-scan after content changes:

```javascript
test("modal is accessible when opened", async ({ page }) => {
  await page.goto("/");

  // Initial page scan
  let results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);

  // Open modal
  await page.getByRole("button", { name: /settings/i }).click();
  await page.getByRole("dialog").waitFor();

  // Scan modal
  results = await new AxeBuilder({ page }).include("[role='dialog']").analyze();
  expect(results.violations).toEqual([]);
});
```

## Common Issues and Fixes

### Missing Form Labels

```html
<!-- BAD -->
<input type="email" placeholder="Email" />

<!-- GOOD -->
<label for="email">Email address</label>
<input id="email" type="email" />

<!-- ALSO GOOD (visually hidden label) -->
<label for="search" class="visually-hidden">Search products</label>
<input id="search" type="search" placeholder="Search..." />
```

### Color Contrast

```css
/* BAD: 2.61:1 ratio */
.muted-text {
  color: #a0a0a0;
  background: #ffffff;
}

/* GOOD: 4.5:1+ ratio for normal text */
.muted-text {
  color: #6b6b6b;
  background: #ffffff;
}
```

### Missing Button Names

```html
<!-- BAD -->
<button><svg>...</svg></button>

<!-- GOOD -->
<button aria-label="Close dialog"><svg>...</svg></button>

<!-- ALSO GOOD -->
<button>
  <svg aria-hidden="true">...</svg>
  <span class="visually-hidden">Close dialog</span>
</button>
```

### Duplicate IDs

```html
<!-- BAD -->
<input id="email" />
<input id="email" />
<!-- Duplicate! -->

<!-- GOOD -->
<input id="billing-email" />
<input id="shipping-email" />
```

## References

- [axe-core Rules](https://github.com/dequelabs/axe-core/blob/develop/doc/rule-descriptions.md)
- [Playwright Accessibility Testing](https://playwright.dev/docs/accessibility-testing)
- [WCAG Quick Reference](https://www.w3.org/WAI/WCAG21/quickref/)
- [Deque University](https://dequeuniversity.com/) — Free accessibility training
