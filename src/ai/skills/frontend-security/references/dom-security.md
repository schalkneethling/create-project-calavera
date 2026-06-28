# DOM Security Reference

## DOM-Based XSS Prevention

### Rule #1: HTML Subcontext

Untrusted data in HTML element content:

```javascript
// UNSAFE
element.innerHTML = "<div>" + userInput + "</div>";

// SAFE - use textContent
element.textContent = userInput;

// SAFE - create elements programmatically
const div = document.createElement("div");
div.textContent = userInput;
parent.appendChild(div);
```

### Rule #2: JavaScript Context

Untrusted data in JavaScript:

```javascript
// UNSAFE - string concatenation in script
const script = 'var x = "' + userInput + '"';

// UNSAFE - dynamic property access
window[userInput]();

// SAFE - use data attributes
element.dataset.value = userInput;
const value = element.dataset.value;
```

### Rule #3: HTML Attribute Context

```javascript
// UNSAFE - event handlers
element.setAttribute("onclick", userInput);

// UNSAFE - dangerous attributes
element.setAttribute("href", userInput); // javascript: URLs
element.setAttribute("src", userInput); // script injection

// SAFER - only allow attributes whose semantics are plain text in this element.
// Avoid user-controlled id/name because they can contribute to DOM clobbering.
const safeAttributes = ["title", "alt", "aria-label", "data-value"];
if (safeAttributes.includes(attributeName)) {
  element.setAttribute(attributeName, userInput);
}
```

### Rule #4: CSS Context

```javascript
// UNSAFE - expression injection
element.style.cssText = userInput;
element.setAttribute("style", userInput);

// SAFE - set specific properties
element.style.backgroundColor = sanitizeColor(userInput);

function sanitizeColor(input) {
  // Only allow safe color values
  const colorRegex = /^#[0-9A-Fa-f]{6}$|^#[0-9A-Fa-f]{3}$|^rgb\(\d{1,3},\s*\d{1,3},\s*\d{1,3}\)$/;
  return colorRegex.test(input) ? input : "inherit";
}
```

### Rule #5: URL Context

```javascript
// UNSAFE - unvalidated URLs
location.href = userInput;
window.open(userInput);
element.setAttribute("href", userInput);

// SAFER - parse, normalize, and enforce destination policy.
function normalizeAllowedUrl(input) {
  try {
    const url = new URL(input, window.location.origin);
    if (!["https:", "mailto:"].includes(url.protocol)) return null;
    if (
      url.protocol === "https:" &&
      !["https://example.com", "https://docs.example.com"].includes(url.origin)
    ) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

const safeUrl = normalizeAllowedUrl(userInput);
if (safeUrl) {
  location.assign(safeUrl);
}

// If opening a separate browsing context, also prevent tabnabbing.
if (safeUrl) {
  window.open(safeUrl, "_blank", "noopener,noreferrer");
}
```

## DOM Clobbering Prevention

### What is DOM Clobbering?

Named elements (id, name attributes) create global variables:

```html
<!-- This creates window.config -->
<img id="config" src="x" />

<!-- JavaScript that assumes config is an object will break -->
<script>
  console.log(config.apiKey); // Error: HTMLImageElement has no apiKey
</script>
```

### Prevention Strategies

```javascript
// 1. Use Object.hasOwn() or hasOwnProperty()
if (
  Object.hasOwn(window, "config") &&
  typeof window.config === "object" &&
  window.config !== null &&
  !(window.config instanceof Element)
) {
  // Safe to use window.config
}

// 2. Access through document methods
const element = document.getElementById("config");

// 3. Use Map instead of objects for user-controlled keys
const userConfig = new Map();
userConfig.set(userKey, userValue);

// 4. Freeze only owned objects after validating shape
if (
  Object.hasOwn(window, "config") &&
  typeof window.config === "object" &&
  window.config !== null &&
  !(window.config instanceof Element)
) {
  Object.freeze(window.config);
}

// 5. Use nullish coalescing with type checking
const config = window.config ?? {};
if (typeof config.apiKey === "string") {
  // Safe to use
}
```

### HTML Sanitization Against Clobbering

```javascript
// DOMPurify with clobbering protection
const clean = DOMPurify.sanitize(dirty, {
  SANITIZE_DOM: true, // Remove clobbering vectors
  SANITIZE_NAMED_PROPS: true,
});
```

## Secure DOM APIs

### Safe Methods

```javascript
// Text content (no HTML parsing)
element.textContent = userInput;
document.createTextNode(userInput);

// Attribute manipulation (for plain-text safe attributes)
element.setAttribute("data-value", userInput);
element.classList.add(sanitizedClass);

// Query selectors (read-only)
document.querySelector(selector);
document.querySelectorAll(selector);
```

### Dangerous Methods (Require Sanitization)

```javascript
// HTML parsing methods
element.innerHTML = sanitized;
element.outerHTML = sanitized;
element.insertAdjacentHTML(position, sanitized);
document.write(sanitized); // Avoid entirely

// Script execution
eval(); // Never use with user input
new Function(); // Never use with user input
setTimeout(string); // Never pass strings
setInterval(string); // Never pass strings
```

## postMessage Security

```javascript
// Sender - specify exact origin
targetWindow.postMessage(data, "https://trusted-domain.com");

// Receiver - always validate origin
window.addEventListener("message", (event) => {
  // Validate origin
  if (event.origin !== "https://trusted-domain.com") {
    return;
  }

  // Validate data structure
  if (event.data === null || typeof event.data !== "object" || !event.data.type) {
    return;
  }

  // Process trusted message
  handleMessage(event.data);
});
```

## Trusted Types (Modern Browsers)

```javascript
// Enable Trusted Types via CSP
// Content-Security-Policy: require-trusted-types-for 'script'

// Create a policy
const policy = trustedTypes.createPolicy("default", {
  createHTML: (input) => DOMPurify.sanitize(input),
  createScript: () => {
    throw new Error("Scripts not allowed");
  },
  createScriptURL: (input) => {
    const url = new URL(input, location.origin);
    if (url.origin === location.origin && url.pathname.startsWith("/assets/")) {
      return url.href;
    }
    throw new Error("Invalid script URL");
  },
});

// Usage
element.innerHTML = policy.createHTML(userInput);
```

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/DOM_based_XSS_Prevention_Cheat_Sheet.html
