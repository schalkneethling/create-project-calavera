# Content Security Policy Reference

## Strict CSP Configuration

### Nonce-Based (Recommended)

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'nonce-{per_request_nonce}' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
  form-action 'self';
  frame-ancestors 'none';
```

Implementation:

```javascript
// Generate unique nonce per request
const crypto = require("crypto");
const nonce = crypto.randomBytes(16).toString("base64");

// Set header
res.setHeader(
  "Content-Security-Policy",
  [
    "default-src 'self'",
    `script-src 'nonce-${nonce}' 'strict-dynamic'`,
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; "),
);

// Include nonce in script tags
res.send(`<script nonce="${nonce}">/* safe code */</script>`);
```

### Hash-Based (For Static Scripts)

```http
Content-Security-Policy:
  default-src 'self';
  script-src 'sha256-{hash}' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
  form-action 'self';
  frame-ancestors 'none';
```

Generate hash:

```bash
echo -n 'console.log("hello");' | openssl sha256 -binary | openssl base64
```

## Essential Directives

| Directive         | Purpose                       | Recommended Value                              |
| ----------------- | ----------------------------- | ---------------------------------------------- |
| `default-src`     | Fallback for other directives | `'self'`                                       |
| `script-src`      | JavaScript sources            | `'nonce-{per_request_nonce}' 'strict-dynamic'` |
| `style-src`       | CSS sources                   | `'self'` or nonce/hash-based styles            |
| `img-src`         | Image sources                 | `'self' data: https:`                          |
| `font-src`        | Font sources                  | `'self'`                                       |
| `connect-src`     | AJAX/WebSocket/Fetch          | `'self' https://api.example.com`               |
| `frame-src`       | iframe sources                | `'none'` or specific origins                   |
| `object-src`      | Plugin content                | `'none'`                                       |
| `base-uri`        | Base URL restrictions         | `'none'`                                       |
| `form-action`     | Form submission targets       | `'self'`                                       |
| `frame-ancestors` | Who can embed page            | `'self'` or `'none'`                           |

## Framework Integration

### Express.js

```javascript
const crypto = require("crypto");
const helmet = require("helmet");

// Nonce middleware
app.use((req, res, next) => {
  res.locals.nonce = crypto.randomBytes(16).toString("base64");
  next();
});

app.use(
  helmet.contentSecurityPolicy({
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [(req, res) => `'nonce-${res.locals.nonce}'`, "'strict-dynamic'"],
      styleSrc: ["'self'", (req, res) => `'nonce-${res.locals.nonce}'`],
      imgSrc: ["'self'", "data:", "https:"],
      objectSrc: ["'none'"],
      baseUri: ["'none'"],
      formAction: ["'self'"],
      frameAncestors: ["'self'"],
    },
  }),
);
```

### Astro

```javascript
// astro.config.mjs
import { defineConfig } from "astro/config";

// Development-only fallback. Prefer production headers from your hosting edge,
// adapter middleware, or server response so each request can receive a fresh
// nonce and avoid unsafe-inline.
export default defineConfig({
  vite: {
    plugins: [
      {
        name: "dev-csp-plugin",
        apply: "serve",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            res.setHeader(
              "Content-Security-Policy",
              "default-src 'self'; script-src 'self'; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none';",
            );
            next();
          });
        },
      },
    ],
  },
});
```

### Meta Tag (Fallback)

```html
<meta
  http-equiv="Content-Security-Policy"
  content="default-src 'self'; script-src 'self' 'sha256-<base64-script-hash>'; object-src 'none'; base-uri 'none';"
/>
```

**Note**: Meta tag CSP cannot set `frame-ancestors`, `report-uri`, or `sandbox`.
Use hashes for static fallback pages. Use a response header when you need a
per-request nonce.

## Report-Only Mode

Test policies without enforcement:

```http
Content-Security-Policy-Report-Only:
  default-src 'self';
  script-src 'nonce-{per_request_nonce}' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
  form-action 'self';
  frame-ancestors 'none';
  report-uri /csp-report;
```

Report endpoint (apply a rate limiter before parsing and logging public reports):

```javascript
function sanitizeReportUrl(value) {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value);
    url.search = "";
    url.hash = "";
    return url.href.slice(0, 512);
  } catch {
    return value.slice(0, 128);
  }
}

app.post(
  "/csp-report",
  cspReportLimiter,
  express.json({ type: "application/csp-report", limit: "16kb" }),
  (req, res) => {
    const report = req.body?.["csp-report"];
    if (!report || typeof report !== "object" || Array.isArray(report)) {
      return res.status(204).end();
    }
    const directive = report["violated-directive"];
    console.warn("CSP Violation:", {
      blockedUri: sanitizeReportUrl(report["blocked-uri"]),
      violatedDirective: typeof directive === "string" ? directive.slice(0, 128) : undefined,
      documentUri: sanitizeReportUrl(report["document-uri"]),
    });
    res.status(204).end();
  },
);
```

## Common Violations and Fixes

### Inline Scripts

```html
<!-- Violation: inline script -->
<script>
  alert("hello");
</script>

<!-- Fix: add a fresh per-response nonce generated by the server -->
<script nonce="{per_request_nonce}">
  alert("hello");
</script>

<!-- Or: move to external file -->
<script src="/js/app.js"></script>
```

### Inline Event Handlers

```html
<!-- Violation: inline event handler -->
<button onclick="handleClick()">Click</button>

<!-- Fix: use addEventListener -->
<button id="myBtn">Click</button>
<script nonce="{per_request_nonce}">
  document.getElementById("myBtn").addEventListener("click", handleClick);
</script>
```

### Inline Styles

```html
<!-- Violation: style attribute -->
<div style="color: red;">Text</div>

<!-- Fix: use classes -->
<div class="text-red">Text</div>

<!-- Or: add a fresh per-response nonce to style tags -->
<style nonce="{per_request_nonce}">
  .text-red {
    color: red;
  }
</style>
```

Never copy a literal nonce value. A nonce must be unpredictable and unique for
each response that contains nonce-authorized inline script or style.

## Security Headers Companion

Deploy CSP with these additional headers:

```http
X-Content-Type-Options: nosniff
X-Frame-Options: DENY
X-XSS-Protection: 0
Referrer-Policy: strict-origin-when-cross-origin
Permissions-Policy: geolocation=(), microphone=(), camera=()
```

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html
