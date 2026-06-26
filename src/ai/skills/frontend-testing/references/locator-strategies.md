# Locator Strategies

Locators determine how tests find elements. Good locators are resilient to implementation changes while verifying accessibility.

## Priority Hierarchy

Both Playwright and Testing Library recommend this order. Each level provides accessibility verification as a byproduct.

### 1. Accessible Roles (First Choice)

Query the accessibility tree. If this fails, the UI likely has accessibility issues.

```javascript
// Playwright
page.getByRole("button", { name: /submit/i });
page.getByRole("textbox", { name: /email/i });
page.getByRole("heading", { level: 1 });
page.getByRole("navigation");
page.getByRole("listitem");

// Testing Library
screen.getByRole("button", { name: /submit/i });
screen.getByRole("checkbox", { checked: true });
```

**Why first**: Users and assistive technologies perceive the page through roles. Testing with roles validates both functionality and accessibility.

**Name option**: Filters by accessible name (visible text, aria-label, or aria-labelledby).

```javascript
// Multiple buttons? Filter by name
page.getByRole("button", { name: /save/i }); // Save button
page.getByRole("button", { name: /cancel/i }); // Cancel button
page.getByRole("button", { name: /delete/i }); // Delete button
```

**Common roles**:

- `button`, `link`, `textbox`, `checkbox`, `radio`
- `combobox` (select), `listbox`, `option`
- `heading`, `navigation`, `main`, `article`
- `dialog`, `alert`, `alertdialog`
- `list`, `listitem`, `table`, `row`, `cell`
- `tab`, `tablist`, `tabpanel`

### 2. Label Text (Forms)

How users find form fields. Validates label-input association.

```javascript
// Playwright
page.getByLabel("Email address");
page.getByLabel(/password/i);

// Testing Library
screen.getByLabelText("Email address");
screen.getByLabelText(/confirm password/i);
```

**Why second**: Form users navigate by labels. Tests using labels fail if labels are missing or improperly associated—catching real accessibility bugs.

### 3. Placeholder Text (Fallback for Forms)

Use only when labels aren't available. Placeholder is not a label substitute.

```javascript
page.getByPlaceholder("Search products...");
screen.getByPlaceholderText("Enter your query");
```

**Why third**: Better than test IDs, but UI should have proper labels.

### 4. Visible Text (Non-Interactive Content)

For elements identified by their content.

```javascript
// Playwright
page.getByText("Welcome back, Sarah");
page.getByText(/order confirmed/i);

// Testing Library
screen.getByText("No results found");
screen.getByText(/loading/i);
```

**Why fourth**: Useful for assertions on content, but doesn't verify semantic structure.

### 5. Alt Text (Images)

For images with meaningful alt text.

```javascript
page.getByAltText("Company logo");
screen.getByAltText(/product photo/i);
```

### 6. Title Attribute

Rarely used. Most elements shouldn't rely on title for identification.

```javascript
page.getByTitle("Close dialog");
screen.getByTitle(/help/i);
```

### 7. Test IDs (Last Resort)

Escape hatch when semantic queries fail. Provides no accessibility verification.

```javascript
// Playwright
page.getByTestId("pricing-calculator");

// Testing Library
screen.getByTestId("data-grid");
```

**When appropriate**:

- Complex dynamic components (data grids, charts)
- Elements with no stable accessible name
- Third-party components you can't modify

**When to avoid**:

- Any element that has text, label, or semantic role
- As a default choice to "make tests easier"

## Playwright-Specific Patterns

### Chaining and Filtering

Narrow down when multiple matches exist:

```javascript
// Find delete button in specific row
const userRow = page.getByRole("row").filter({ hasText: "john@example.com" });
await userRow.getByRole("button", { name: /delete/i }).click();

// Combine locators
const submitButton = page
  .getByRole("button", { name: /submit/i })
  .and(page.locator("[type=submit]"));
```

### Scoped Queries with `within`

Test elements within a container:

```javascript
// Playwright
const form = page.getByRole("form", { name: /checkout/i });
await form.getByLabel("Card number").fill("4111111111111111");

// Testing Library
import { within } from "@testing-library/react";
const form = screen.getByRole("form");
within(form).getByLabelText("Email");
```

### Handling Multiple Elements

When strict matching fails:

```javascript
// Get all, then filter
const buttons = await page.getByRole("button").all();
const buttonTexts = await Promise.all(buttons.map((button) => button.textContent()));
const deleteButtons = buttons.filter((button, index) => buttonTexts[index]?.includes("Delete"));

// Or be more specific with the query
page.getByRole("button", { name: "Delete", exact: true });
```

## Testing Library Variants

### get vs query vs find

| Variant   | No match     | Multiple matches | Async       |
| --------- | ------------ | ---------------- | ----------- |
| `getBy`   | Throws       | Throws           | No          |
| `queryBy` | Returns null | Throws           | No          |
| `findBy`  | Throws       | Throws           | Yes (waits) |

```javascript
// Element should exist now
screen.getByRole("button", { name: /submit/i });

// Element might not exist (testing absence)
expect(screen.queryByRole("alert")).not.toBeInTheDocument();

// Element appears after async action
await screen.findByRole("alert");
```

### Regex vs String Matching

```javascript
// Exact match (case-sensitive)
screen.getByText("Submit Order");

// Flexible match (recommended for resilience)
screen.getByText(/submit order/i);

// Partial match
screen.getByText(/submit/i);
```

## Anti-Patterns

### CSS Selectors as Primary Strategy

```javascript
// BAD: Tied to implementation
page.locator(".btn-primary");
page.locator("#submit-form-btn");
page.locator("div.container > form > button");

// GOOD: Tied to user experience
page.getByRole("button", { name: /submit/i });
```

### XPath

```javascript
// BAD: Brittle, hard to read
page.locator("//div[@class='form']//button[text()='Submit']");

// GOOD: Clear and semantic
page.getByRole("button", { name: /submit/i });
```

### Position-Based Selection

```javascript
// BAD: Breaks when order changes
page.getByRole("button").nth(2);

// GOOD: Explicit about which element
page.getByRole("button", { name: /delete account/i });
```

### Test IDs for Everything

```javascript
// BAD: No accessibility verification
page.getByTestId("submit-button");
page.getByTestId("email-input");
page.getByTestId("error-message");

// GOOD: Validates accessibility
page.getByRole("button", { name: /submit/i });
page.getByLabel("Email");
page.getByRole("alert");
```

## Debugging Locators

### Playwright

```javascript
// Log all accessible elements
await page.getByRole("button").evaluateAll((buttons) => buttons.map((b) => b.textContent));

// Use Playwright Inspector
// npx playwright test --debug

// Use codegen for suggestions
// npx playwright codegen example.com
```

### Testing Library

```javascript
// Log the DOM
screen.debug();

// Log specific element
screen.debug(screen.getByRole("form"));

// Use Testing Playground
// testing-playground.com
// Or browser extension
```

## References

- [Playwright Locators](https://playwright.dev/docs/locators)
- [Testing Library Queries](https://testing-library.com/docs/queries/about/)
- [ARIA Roles](https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles)
- [Testing Library Priority Guide](https://testing-library.com/docs/queries/about/#priority)
