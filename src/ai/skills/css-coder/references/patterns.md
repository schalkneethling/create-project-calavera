# CSS Patterns and Snippets

This file contains reusable CSS patterns, snippets, and conventions. Consult before writing CSS.

---

## Utility Patterns

### Visually Hidden (Screen Reader Only)

Use when content should be accessible to assistive technologies but not visible on screen.

```css
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
```

---

## User Preference Queries

### Reduced Motion

Always wrap animations and transitions for users who prefer reduced motion.

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
```

### Color Scheme

```css
@media (prefers-color-scheme: dark) {
  :root {
    /* dark mode custom properties */
  }
}
```

### High Contrast

```css
@media (prefers-contrast: more) {
  :root {
    /* increased contrast custom properties */
  }
}
```

---

## Color Patterns

### Modern Color Syntax

Always use space-separated syntax for color functions. This is the current standard and required for modern color features.

```css
/* Legacy — avoid */
.legacy {
  background-color: hsla(10, 100%, 50%, 0.75);
  color: rgba(0, 0, 0, 0.9);
}

/* Modern — preferred */
.modern {
  background-color: hsl(10 100% 50% / 0.75);
  color: rgb(0 0 0 / 0.9);
}
```

Key points:

- Use `rgb()` and `hsl()` — the `a` suffix (`rgba`, `hsla`) is no longer needed.
- Separate components with spaces, not commas.
- Use `/` before the alpha value for transparency.

### Wide Gamut Colors (oklch, oklab)

Use `oklch()` when users request "vibrant", "bright", or "punchy" colors. It supports a wider gamut than sRGB and is perceptually uniform, making adjustments more predictable.

```css
:root {
  --color-accent: oklch(65% 0.25 340);
}
```

Note: `oklch()`, `oklab()`, and `color()` only support space-separated syntax.

### Relative Color Syntax

Use relative colors to derive variations (hover states, overlays, tints) from existing brand variables without defining new custom properties.

Syntax: `function(from [base-color] [components] / [alpha])`

```css
:root {
  --color-brand: oklch(55% 0.2 250);
}

.button {
  background-color: var(--color-brand);
}

.button:hover {
  /* Lighten by adjusting the L channel */
  background-color: oklch(from var(--color-brand) calc(l + 0.1) c h);
}

.overlay {
  /* Apply 50% opacity to brand color */
  background-color: oklch(from var(--color-brand) l c h / 0.5);
}
```

---

## Responsive Patterns

### Shared First (Preferred over Mobile First)

Avoid traditional mobile-first CSS where styles "bleed up" through open-ended `min-width` queries, requiring constant overrides. Instead, use a **Shared First** approach:

1. Define only truly shared styles outside media queries.
2. Use bounded media queries to scope styles to specific viewport ranges.
3. Keep breakpoints to a minimum — add more only when there's a clear need.

Use modern range syntax for all media queries:

```css
@media (width < 48rem) {
  /* below breakpoint */
}
@media (width >= 48rem) {
  /* at or above breakpoint */
}
@media (48rem <= width < 64rem) {
  /* between breakpoints */
}
```

**Why Shared First?**

- **Fewer side effects** — Changes to one viewport don't accidentally affect others.
- **Easier debugging** — DevTools shows fewer overridden (struck-through) properties.
- **Clearer intent** — Each viewport's styles are self-contained.

```css
/* Mobile First — avoid */
body {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

@media (min-width: 48rem) {
  body {
    flex-direction: row;
    gap: 2rem;
  }
}
```

```css
/* Shared First — preferred */
body {
  display: flex;
}

@media (width < 48rem) {
  body {
    flex-direction: column;
    gap: 1rem;
  }
}

@media (width >= 48rem) {
  body {
    flex-direction: row;
    gap: 2rem;
  }
}
```

The Shared First approach may use more lines, but results in more maintainable, predictable CSS with fewer debugging headaches.

#### Using Custom Properties with Shared First

Custom properties can reduce repetition by keeping the property declaration shared while scoping only the value to each viewport. Use sparingly — overuse can make code harder to follow.

```css
.Dialog-container {
  padding-block: var(--Dialog-block-padding);
}

@media (width < 48rem) {
  .Dialog-container {
    --Dialog-block-padding: var(--size-16);
  }
}

@media (width >= 48rem) {
  .Dialog-container {
    --Dialog-block-padding: var(--size-32);
  }
}
```
