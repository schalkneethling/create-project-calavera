# XSS Prevention Reference

## Output Encoding Rules

Apply context-appropriate encoding for all untrusted data:

| Context        | Encoding Method      | Example               |
| -------------- | -------------------- | --------------------- |
| HTML Body      | HTML Entity Encoding | `&lt;script&gt;`      |
| HTML Attribute | Attribute Encoding   | `&quot;onclick&quot;` |
| JavaScript     | JavaScript Encoding  | `\x3cscript\x3e`      |
| CSS            | CSS Encoding         | `\3c script\3e`       |
| URL Parameter  | URL Encoding         | `%3Cscript%3E`        |

## Safe vs Unsafe Sinks

### Unsafe Sinks (Never use with untrusted data)

```javascript
// Execution sinks - NEVER use with user input
element.innerHTML = userInput; // XSS
element.outerHTML = userInput; // XSS
document.write(userInput); // XSS
document.writeln(userInput); // XSS

// JavaScript execution sinks
eval(userInput); // XSS
new Function(userInput); // XSS
setTimeout(userInput, time); // XSS if string
setInterval(userInput, time); // XSS if string

// URL sinks
location.href = userInput; // XSS
location.assign(userInput); // XSS
location.replace(userInput); // XSS
window.open(userInput); // XSS
```

### Safe Alternatives

```javascript
// Safe text insertion
element.textContent = userInput; // Safe
element.innerText = userInput; // Safe

// Safe attribute setting (for safe attributes)
element.setAttribute("title", userInput); // Safe for non-event attributes

// Safe URL handling
const url = new URL(userInput, window.location.origin);
if (url.protocol === "https:") {
  location.href = url.href;
}
```

## HTML Sanitization

When HTML must be rendered, use sanitization:

```javascript
// Using DOMPurify (recommended)
import DOMPurify from "dompurify";
element.innerHTML = DOMPurify.sanitize(userInput);

// With configuration
const clean = DOMPurify.sanitize(dirty, {
  ALLOWED_TAGS: ["b", "i", "em", "strong", "a"],
  ALLOWED_ATTR: ["href", "title"],
});

// Browser Sanitizer API (when available)
const sanitizer = new Sanitizer({
  allowElements: ["b", "i", "em", "strong", "a"],
  allowAttributes: { href: ["a"] },
});
element.setHTML(userInput, { sanitizer });
```

## Framework-Specific XSS Risks

### React

```jsx
// DANGEROUS - bypasses React's protection
<div dangerouslySetInnerHTML={{ __html: userInput }} />

// SAFE - React auto-escapes
<div>{userInput}</div>

// DANGEROUS - href with javascript:
<a href={userInput}>Link</a> // If userInput = "javascript:alert(1)"

// SAFE - validate URL protocol
const safeUrl = userInput.startsWith('https://') ? userInput : '#';
<a href={safeUrl}>Link</a>
```

### Twig

```twig
{# DANGEROUS - raw filter bypasses escaping #}
{{ userInput|raw }}

{# DANGEROUS - autoescape disabled #}
{% autoescape false %}
  {{ userInput }}
{% endautoescape %}

{# SAFE - auto-escaped by default #}
{{ userInput }}

{# SAFE - explicit escaping #}
{{ userInput|e('html') }}
{{ userInput|e('js') }}
{{ userInput|e('url') }}
```

### Astro

```astro
<!-- DANGEROUS - set:html bypasses escaping -->
<div set:html={userInput} />

<!-- SAFE - auto-escaped -->
<div>{userInput}</div>
```

## URL Validation

```javascript
function isValidUrl(input) {
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

// Prevent javascript: URLs
function sanitizeHref(input) {
  if (!input) return "#";
  const trimmed = input.trim().toLowerCase();
  if (
    trimmed.startsWith("javascript:") ||
    trimmed.startsWith("data:") ||
    trimmed.startsWith("vbscript:")
  ) {
    return "#";
  }
  return input;
}
```

## Content-Type Headers

Always set appropriate Content-Type headers:

```javascript
// Express.js
res.setHeader("Content-Type", "application/json");
res.setHeader("X-Content-Type-Options", "nosniff");
```

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
