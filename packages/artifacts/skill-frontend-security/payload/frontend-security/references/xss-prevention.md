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

// Safe attribute setting (only for explicitly benign attributes)
element.setAttribute("title", userInput); // Safe for plain text attributes
// Do not treat href, src, style, or event-handler attributes as safe sinks.

// Safe URL handling: parse, normalize, then enforce the actual policy.
function matchesPathPrefix(pathname, allowedPrefix) {
  return pathname === allowedPrefix || pathname.startsWith(`${allowedPrefix}/`);
}

function toAllowedInternalUrl(input) {
  try {
    const url = new URL(input, window.location.origin);
    if (url.origin !== window.location.origin) return null;
    if (!["/account", "/settings", "/help"].some((path) => matchesPathPrefix(url.pathname, path))) {
      return null;
    }
    return url.href;
  } catch {
    return null;
  }
}

const safeUrl = toAllowedInternalUrl(userInput);
if (safeUrl) location.assign(safeUrl);

// New tabs/windows need opener protection when the destination is untrusted or
// external.
if (safeUrl) {
  const opened = window.open(safeUrl, "_blank", "noopener,noreferrer");
  if (opened) opened.opener = null;
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

// DANGEROUS - href can contain javascript:, phishing, or redirect targets.
<a href={userInput}>Link</a>

// SAFER - parse and enforce the allowed destinations for this component.
function toSafeExternalHref(input) {
  try {
    const url = new URL(input, window.location.origin);
    if (!["https:"].includes(url.protocol)) return "#";
    if (!["https://example.com", "https://docs.example.com"].includes(url.origin)) return "#";
    return url.href;
  } catch {
    return "#";
  }
}

<a href={toSafeExternalHref(userInput)} target="_blank" rel="noopener noreferrer">
  Link
</a>;
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

URL checks should return a parsed, normalized value for the exact sink. A scheme
allowlist is necessary but not sufficient for redirects, links, downloads, or
navigation.

```javascript
function matchesPathPrefix(pathname, allowedPrefix) {
  if (allowedPrefix === "/") return pathname.startsWith("/");
  return pathname === allowedPrefix || pathname.startsWith(`${allowedPrefix}/`);
}

function normalizeAllowedHref(
  input,
  { baseUrl, allowedOrigins, allowedPathPrefixes = ["/"], allowedProtocols = ["https:"] },
) {
  try {
    const url = new URL(input, baseUrl);
    if (!allowedProtocols.includes(url.protocol)) return null;
    if (!allowedOrigins.includes(url.origin)) return null;
    if (!allowedPathPrefixes.some((prefix) => matchesPathPrefix(url.pathname, prefix))) return null;
    return url.href;
  } catch {
    return null;
  }
}

const href = normalizeAllowedHref(userInput, {
  baseUrl: window.location.origin,
  allowedOrigins: [window.location.origin, "https://docs.example.com"],
  allowedPathPrefixes: ["/docs", "/account"],
  allowedProtocols: ["https:"],
});
```

For links that open in a new browsing context, pair normalized URLs with
`rel="noopener noreferrer"` or `window.open(..., "noopener,noreferrer")` so the
new page cannot control the opener.

## Content-Type Headers

Always set appropriate Content-Type headers:

```javascript
// Express.js
res.setHeader("Content-Type", "application/json");
res.setHeader("X-Content-Type-Options", "nosniff");
```

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
