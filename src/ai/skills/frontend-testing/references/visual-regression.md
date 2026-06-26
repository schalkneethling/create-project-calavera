# Visual Regression Testing

Visual regression testing (VRT) catches unintended visual changes by comparing screenshots against approved baselines.

## When to Use VRT

**Good candidates:**

- Design system components
- Critical landing pages
- Complex layouts (grids, dashboards)
- Components with CSS that changes frequently
- Cross-browser visual consistency

**Poor candidates:**

- Pages with frequently changing dynamic content
- Components with animations
- Time-dependent displays
- Pages with third-party content (ads, embeds)

## Playwright Visual Testing

### Basic Screenshot Comparison

```javascript
import { test, expect } from "@playwright/test";

test("homepage looks correct", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveScreenshot();
});
```

First run creates the baseline. Subsequent runs compare against it.

### Named Screenshots

```javascript
test("hero section renders correctly", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveScreenshot("homepage-hero.png");
});
```

### Element Screenshots

More stable than full-page screenshots:

```javascript
test("product card renders correctly", async ({ page }) => {
  await page.goto("/products/123");

  const productCard = page.getByTestId("product-card");
  await expect(productCard).toHaveScreenshot("product-card.png");
});
```

### Full Page Screenshots

```javascript
test("full page layout", async ({ page }) => {
  await page.goto("/about");

  await expect(page).toHaveScreenshot("about-page-full.png", {
    fullPage: true,
  });
});
```

## Handling Instability

Visual tests fail due to timing, rendering, or environment differences. Stabilize tests before trusting results.

### Wait for Network and Fonts

```javascript
test("page renders after loading", async ({ page }) => {
  await page.goto("/");

  // Wait for network to be idle
  await page.waitForLoadState("networkidle");

  // Wait for web fonts to load
  await page.evaluate(() => document.fonts.ready);

  await expect(page).toHaveScreenshot();
});
```

### Disable Animations

```javascript
// playwright.config.js
export default defineConfig({
  use: {
    // Disable CSS animations and transitions
    contextOptions: {
      reducedMotion: "reduce",
    },
  },
});
```

Or in test:

```javascript
test("static screenshot", async ({ page }) => {
  await page.goto("/");

  // Inject CSS to disable animations
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        transition-duration: 0s !important;
      }
    `,
  });

  await expect(page).toHaveScreenshot();
});
```

### Mask Dynamic Content

Hide elements that change between runs:

```javascript
test("page with masked dynamic content", async ({ page }) => {
  await page.goto("/dashboard");

  await expect(page).toHaveScreenshot({
    mask: [
      page.locator("[data-testid='current-time']"),
      page.locator("[data-testid='user-avatar']"),
      page.locator(".ad-container"),
    ],
  });
});
```

### Fixed Viewport

Lock viewport size for consistent screenshots:

```javascript
// playwright.config.js
export default defineConfig({
  use: {
    viewport: { width: 1280, height: 720 },
  },
});
```

Or per-test:

```javascript
test("mobile view", async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto("/");
  await expect(page).toHaveScreenshot("homepage-mobile.png");
});
```

### Hide Scrollbars

Scrollbars vary by OS:

```javascript
await page.addStyleTag({
  content: `
    ::-webkit-scrollbar { display: none; }
    * { scrollbar-width: none; }
  `,
});
```

## Tolerance Settings

Allow minor pixel differences to reduce flakiness.

### Global Configuration

```javascript
// playwright.config.js
export default defineConfig({
  expect: {
    toHaveScreenshot: {
      maxDiffPixels: 100, // Allow up to 100 different pixels
      maxDiffPixelRatio: 0.01, // Or 1% of total pixels
      threshold: 0.2, // Color difference threshold (0-1)
    },
  },
});
```

### Per-Screenshot Settings

```javascript
await expect(page).toHaveScreenshot({
  maxDiffPixels: 50,
  threshold: 0.3,
});
```

### Threshold Guidelines

| Setting             | Value | Use Case                     |
| ------------------- | ----- | ---------------------------- |
| `threshold`         | 0.1   | Strict pixel matching        |
| `threshold`         | 0.2   | Standard tolerance (default) |
| `threshold`         | 0.3   | Generous for anti-aliasing   |
| `maxDiffPixels`     | 50    | Small components             |
| `maxDiffPixels`     | 200   | Full pages                   |
| `maxDiffPixelRatio` | 0.01  | 1% tolerance                 |

## Updating Baselines

### When to Update

- Intentional design changes
- New features affecting layout
- Browser rendering engine updates
- After fixing visual bugs

### Update Command

```bash
npx playwright test --update-snapshots
```

**Never update blindly.** Review changes before committing:

```bash
# See what changed
git diff --stat
# Review visual diffs in the Playwright report or configured snapshot directory
npx playwright show-report
```

### Workflow

1. Test fails due to visual difference
2. Open test report, review diff image
3. If change is intentional:
   - Update baseline with `--update-snapshots`
   - Commit new baseline
4. If change is unintentional:
   - Fix the code
   - Run test again

## Cross-Browser Testing

Screenshots differ between browsers due to rendering differences.

### Browser-Specific Baselines

Playwright automatically creates separate baselines per browser:

```
example.spec.ts-snapshots/
├── homepage-chromium-linux.png
├── homepage-firefox-linux.png
└── homepage-webkit-linux.png
```

### Testing Specific Browsers

```javascript
// playwright.config.js
export default defineConfig({
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] },
    },
    {
      name: "firefox",
      use: { ...devices["Desktop Firefox"] },
    },
    {
      name: "webkit",
      use: { ...devices["Desktop Safari"] },
    },
  ],
});
```

### OS Differences

Font rendering varies by OS. Options:

- Run visual tests in CI only (consistent environment)
- Use Docker with consistent fonts
- Generate baselines in CI, not locally

## CI/CD Configuration

When adding GitHub Actions examples or workflow files, declare explicit least-privilege
`GITHUB_TOKEN` permissions. Use a restrictive top-level default such as `contents: read`, then add
job-level permissions only for jobs that need to push commits, update pull requests, publish pages,
or write other repository resources.

Pin every third-party or GitHub-owned action to a full-length commit SHA. Do not commit tag-based
refs such as `@v6` or `@v7`; use those only as temporary input to a pinning tool, then keep the
version as a comment beside the SHA.

When a job checks out the repository, set `persist-credentials: false` on `actions/checkout`.
Artifact-producing jobs should not keep the repository token persisted for later test, build, or
upload steps.

### GitHub Actions Example

```yaml
permissions:
  contents: read

jobs:
  visual-tests:
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v4.2.2 - re-resolve before use
        with:
          persist-credentials: false

      - name: Run visual tests
        run: npx playwright test --project=chromium

      - name: Upload diff artifacts on failure
        if: failure()
        uses: actions/upload-artifact@4cec3d8aa04e39d1a68397de0c4cd6fb9dce8ec1 # v4.6.1 - re-resolve before use
        with:
          name: visual-diff
          path: test-results/
```

### Generate Baselines in CI

For consistent baselines, generate in CI:

```yaml
permissions:
  contents: read

jobs:
  update-baselines:
    permissions:
      contents: write
    steps:
      - name: Checkout
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v4.2.2 - re-resolve before use
        with:
          persist-credentials: false

      - name: Update baselines
        run: npx playwright test --update-snapshots

      - name: Commit baselines
        env:
          GITHUB_TOKEN: ${{ github.token }}
        run: |
          git config user.name "CI Bot"
          git config user.email "github-actions[bot]@users.noreply.github.com"
          git add "**/*.png"
          git commit -m "Update visual baselines"
          git -c http.https://github.com/.extraheader="AUTHORIZATION: bearer $GITHUB_TOKEN" push origin HEAD:refs/heads/${GITHUB_REF_NAME}
```

## Organizing Screenshots

### Directory Structure

```
tests/
├── visual/
│   ├── homepage.spec.ts
│   └── components/
│       ├── button.spec.ts
│       └── card.spec.ts
└── visual.spec.ts-snapshots/
    ├── homepage-chromium.png
    └── button-default-chromium.png
```

### Custom Path Template

```javascript
// playwright.config.js
export default defineConfig({
  snapshotPathTemplate: "{testDir}/__snapshots__/{projectName}/{testFilePath}/{arg}{ext}",
});
```

## Reporting and Review

### Test Report

```bash
npx playwright show-report
```

Shows:

- Expected (baseline) image
- Actual (current) image
- Diff highlighting changed pixels

### Artifacts on Failure

Configure to save all artifacts:

```javascript
// playwright.config.js
export default defineConfig({
  use: {
    trace: "on-first-retry",
    screenshot: "only-on-failure",
  },
  outputDir: "test-results/",
});
```

## Anti-Patterns

### Removing Platform Suffix

```javascript
// BAD: Removes platform/browser suffix from snapshot names
test.beforeEach(async ({}, testInfo) => {
  testInfo.snapshotSuffix = "";
});

// Results in single baseline used across all platforms:
// button.png  ← Used for Chrome/Mac, Firefox/Linux, Safari/Windows...
```

This seems appealing for "cleaner" snapshot names, but it breaks visual testing. Per [Playwright documentation](https://playwright.dev/docs/test-snapshots):

> "Different snapshots are needed for different browsers and platforms due to variations in rendering and fonts."

**Why it fails:**

- Font rendering differs between macOS, Windows, and Linux
- Anti-aliasing algorithms vary by OS and browser
- Subpixel rendering produces different results
- You'll get constant false positives or false negatives

**Keep the default naming:**

```
button-chromium-darwin.png
button-chromium-linux.png
button-firefox-linux.png
```

Yes, it's more files. But each baseline accurately represents that specific environment.

### Too Many Full-Page Screenshots

```javascript
// BAD: Full page with dynamic content
await expect(page).toHaveScreenshot({ fullPage: true });

// GOOD: Target stable regions
const header = page.getByRole("banner");
await expect(header).toHaveScreenshot("header.png");
```

### No Stabilization

```javascript
// BAD: Screenshot immediately
await page.goto("/");
await expect(page).toHaveScreenshot();

// GOOD: Wait for stable state
await page.goto("/");
await page.waitForLoadState("networkidle");
await page.evaluate(() => document.fonts.ready);
await expect(page).toHaveScreenshot();
```

### Overly Strict Tolerance

```javascript
// BAD: Zero tolerance causes flaky tests
await expect(page).toHaveScreenshot({ maxDiffPixels: 0 });

// GOOD: Allow minor rendering differences
await expect(page).toHaveScreenshot({ maxDiffPixels: 50 });
```

### Updating Without Review

```bash
# BAD: Blindly update all baselines
npx playwright test --update-snapshots

# GOOD: Review changes first
npx playwright test
npx playwright show-report
# Review diffs, then update if intentional
npx playwright test --update-snapshots
```

## References

- [Playwright Visual Comparisons](https://playwright.dev/docs/test-snapshots)
- [Pixelmatch](https://github.com/mapbox/pixelmatch) — Image comparison library used by Playwright
