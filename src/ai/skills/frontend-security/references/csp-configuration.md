# Content Security Policy Reference

## Strict CSP Configuration

### Nonce-Based (Recommended)

```http
Content-Security-Policy:
  script-src 'nonce-{random}' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
```

Implementation:

```javascript
// Generate unique nonce per request
const crypto = require("crypto");
const nonce = crypto.randomBytes(16).toString("base64");

// Set header
res.setHeader(
  "Content-Security-Policy",
  `script-src 'nonce-${nonce}' 'strict-dynamic'; object-src 'none'; base-uri 'none';`,
);

// Include nonce in script tags
res.send(`<script nonce="${nonce}">/* safe code */</script>`);
```

### Hash-Based (For Static Scripts)

```http
Content-Security-Policy:
  script-src 'sha256-{hash}' 'strict-dynamic';
  object-src 'none';
  base-uri 'none';
```

Generate hash:

```bash
echo -n 'console.log("hello");' | openssl sha256 -binary | openssl base64
```

## Essential Directives

| Directive         | Purpose                       | Recommended Value                    |
| ----------------- | ----------------------------- | ------------------------------------ |
| `default-src`     | Fallback for other directives | `'self'`                             |
| `script-src`      | JavaScript sources            | `'nonce-{random}' 'strict-dynamic'`  |
| `style-src`       | CSS sources                   | `'self' 'unsafe-inline'` (or nonces) |
| `img-src`         | Image sources                 | `'self' data: https:`                |
| `font-src`        | Font sources                  | `'self'`                             |
| `connect-src`     | AJAX/WebSocket/Fetch          | `'self' https://api.example.com`     |
| `frame-src`       | iframe sources                | `'none'` or specific origins         |
| `object-src`      | Plugin content                | `'none'`                             |
| `base-uri`        | Base URL restrictions         | `'none'`                             |
| `form-action`     | Form submission targets       | `'self'`                             |
| `frame-ancestors` | Who can embed page            | `'self'` or `'none'`                 |

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
      styleSrc: ["'self'", "'unsafe-inline'"],
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
export default defineConfig({
  vite: {
    plugins: [
      {
        name: "csp-plugin",
        configureServer(server) {
          server.middlewares.use((req, res, next) => {
            res.setHeader(
              "Content-Security-Policy",
              "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';",
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
  content="default-src 'self'; script-src 'self' 'nonce-abc123';"
/>
```

**Note**: Meta tag CSP cannot set `frame-ancestors`, `report-uri`, or `sandbox`.

## Report-Only Mode

Test policies without enforcement:

```http
Content-Security-Policy-Report-Only:
  default-src 'self';
  script-src 'self';
  report-uri /csp-report;
```

Report endpoint:

```javascript
app.post("/csp-report", express.json({ type: "application/csp-report" }), (req, res) => {
  console.log("CSP Violation:", req.body);
  res.status(204).end();
});
```

## Common Violations and Fixes

### Inline Scripts

```html
<!-- Violation: inline script -->
<script>
  alert("hello");
</script>

<!-- Fix: add nonce -->
<script nonce="abc123">
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
<script nonce="abc123">
  document.getElementById("myBtn").addEventListener("click", handleClick);
</script>
```

### Inline Styles

```html
<!-- Violation: style attribute -->
<div style="color: red;">Text</div>

<!-- Fix: use classes -->
<div class="text-red">Text</div>

<!-- Or: add nonce to style tags -->
<style nonce="abc123">
  .text-red {
    color: red;
  }
</style>
```

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
