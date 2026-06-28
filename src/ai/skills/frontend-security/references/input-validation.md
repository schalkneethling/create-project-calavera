# Input Validation Reference

## Validation Strategy

**Always validate on the server.** Client-side validation improves UX but provides no security.

Validate input against the exact type, format, and business rule the application
will use. When parsing is required, validate and then consume the parsed or
normalized value instead of reusing the original string. Parser confusion is a
common source of validation bypasses.

### Allowlist vs Denylist

```javascript
// PREFERRED: Allowlist (accept known good)
function validateUsername(input) {
  const allowedPattern = /^[a-zA-Z0-9_]{3,20}$/;
  return allowedPattern.test(input);
}

// AVOID: Denylist (block known bad)
function validateInput(input) {
  const blocked = ["<script>", "javascript:", "onerror"];
  return !blocked.some((bad) => input.includes(bad)); // Easily bypassed
}
```

## Common Validation Patterns

### Email

```javascript
// Basic validation (server should still verify)
function validateEmail(email) {
  // Simple pattern - not comprehensive but catches most issues
  const pattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return pattern.test(email) && email.length <= 254;
}

// Use built-in browser validation
const input = document.createElement("input");
input.type = "email";
input.value = email;
return input.checkValidity();
```

### URL

```javascript
function matchesPathPrefix(pathname, allowedPrefix) {
  return pathname === allowedPrefix || pathname.startsWith(`${allowedPrefix}/`);
}

function parseAllowedHttpUrl(input, { baseUrl, allowedOrigins, allowedPathPrefixes = ["/"] }) {
  try {
    const allowedOriginSet = new Set(allowedOrigins.map((origin) => new URL(origin).origin));
    const url = new URL(input, baseUrl);

    if (!["http:", "https:"].includes(url.protocol)) return null;
    if (url.username || url.password) return null;
    if (!allowedOriginSet.has(url.origin)) return null;
    if (!allowedPathPrefixes.some((prefix) => matchesPathPrefix(url.pathname, prefix))) return null;

    return url;
  } catch {
    return null;
  }
}

const url = parseAllowedHttpUrl(input, {
  baseUrl: "https://example.com",
  allowedOrigins: ["https://example.com", "https://docs.example.com"],
  allowedPathPrefixes: ["/account", "/docs"],
});
if (!url) throw new Error("Invalid URL");

redirectTo(url.href); // Use the normalized URL returned by the parser.
```

Do not validate only the scheme and then use the original string for redirects,
links, fetches, or storage. Validate the full use case: protocol, origin, path,
credential-bearing URLs, and whether relative URLs are allowed.

### Numbers

```javascript
function parseInteger(input, min, max) {
  if (typeof input !== "string" || !/^-?(0|[1-9]\d*)$/.test(input)) return null;
  const num = Number(input);
  if (!Number.isSafeInteger(num)) return null;
  if (num < min || num > max) return null;
  return num;
}

function parseDecimal(input, min, max, decimals) {
  if (typeof input !== "string") return null;
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 20) return null;

  const decimalPart = decimals === 0 ? "" : `(?:\\.\\d{1,${decimals}})?`;
  const pattern = new RegExp(`^-?(?:0|[1-9]\\d*)${decimalPart}$`);
  if (!pattern.test(input)) return null;

  const num = Number(input);
  if (!Number.isFinite(num)) return null;
  if (num < min || num > max) return null;

  return num;
}
```

Use full-string format checks before numeric conversion. `parseInt` and
`parseFloat` are not validators because they can accept partial strings such as
`"1abc"`. For money, measurements, or other precision-sensitive values, prefer
minor units or a decimal library instead of JavaScript floating-point numbers.

### Date

```javascript
function parseIsoDateOnly(input) {
  if (typeof input !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return null;

  const [year, month, day] = input.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return input;
}

function validateDateRange(input, minDate, maxDate) {
  const date = parseIsoDateOnly(input);
  const min = parseIsoDateOnly(minDate);
  const max = parseIsoDateOnly(maxDate);

  if (!date || !min || !max) return false;
  return date >= min && date <= max;
}
```

Avoid free-form `Date.parse()` for validation. JavaScript date parsing accepts
multiple formats, can normalize invalid calendar dates, and may behave
differently for ambiguous inputs. Prefer explicit formats and round-trip checks.

### Phone Numbers

```javascript
// International format
function validatePhone(input) {
  // E.164 format: +[country][number], max 15 digits
  const pattern = /^\+[1-9]\d{1,14}$/;
  return pattern.test(input.replace(/[\s\-()]/g, ""));
}
```

## Output Encoding and Sanitization

Validation decides whether data is acceptable. Output encoding makes accepted
data safe for a specific rendering context. HTML sanitization removes unsafe
markup when the product intentionally accepts rich HTML.

| Context             | Safer pattern                                                            |
| ------------------- | ------------------------------------------------------------------------ |
| HTML text           | Framework escaping, `textContent`, or an HTML text encoder               |
| HTML attribute      | Framework attribute binding or a context-aware encoder                   |
| URL attribute       | Parse and allowlist URL, then assign through safe DOM/framework APIs     |
| JavaScript string   | Avoid inline script data; use JSON script data or framework data binding |
| CSS value           | Avoid dynamic CSS or validate against a strict allowlist                 |
| Rich HTML fragments | Sanitize with a maintained HTML sanitizer such as DOMPurify              |

### HTML Text Encoding

```javascript
// Only use this for HTML text-node content. Attribute, JavaScript, CSS, and URL
// contexts need their own encoders or framework-supported safe APIs.
function escapeHtml(input) {
  const map = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#x27;",
    "/": "&#x2F;",
  };
  return String(input).replace(/[&<>"'/]/g, (char) => map[char]);
}
```

Prefer DOM or framework APIs that encode for you:

```javascript
element.textContent = userInput;
```

Manual escaping is easy to misuse outside its intended context. Do not treat
HTML text encoding as URL validation, JavaScript escaping, CSS escaping, SQL
escaping, or HTML sanitization.

### HTML Sanitization

```javascript
import DOMPurify from "dompurify";

const clean = DOMPurify.sanitize(userSuppliedHtml, {
  ALLOWED_TAGS: ["a", "p", "strong", "em", "ul", "ol", "li"],
  ALLOWED_ATTR: ["href"],
});
```

Use sanitization only when users are allowed to provide markup. Plain text should
be rendered as text, not sanitized and inserted as HTML.

### SQL (Use Parameterized Queries Instead)

```javascript
// WRONG - never build SQL strings
const query = `SELECT * FROM users WHERE name = '${userInput}'`;

// RIGHT - use parameterized queries
const query = "SELECT * FROM users WHERE name = ?";
db.query(query, [userInput]);
```

### Path Traversal Prevention

```javascript
const path = require("path");

function validateFilePath(userPath, baseDir) {
  const baseCanonical = path.resolve(baseDir);
  const resolved = path.resolve(baseDir, userPath);
  const relativePath = path.relative(baseCanonical, resolved);

  // Ensure resolved path stays inside the base directory
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Path traversal detected");
  }

  return resolved;
}
```

## Framework Validation

### Node.js with Joi

```javascript
const Joi = require("joi");

const userSchema = Joi.object({
  username: Joi.string().alphanum().min(3).max(30).required(),
  email: Joi.string().email().required(),
  age: Joi.number().integer().min(0).max(150),
  website: Joi.string().uri({ scheme: ["http", "https"] }),
});

function validateUser(data) {
  const { error, value } = userSchema.validate(data);
  if (error) throw new Error(error.details[0].message);
  return value;
}
```

### Express Validator

```javascript
const { body, validationResult } = require("express-validator");

app.post(
  "/user",
  body("email").isEmail().normalizeEmail(),
  body("password").isLength({ min: 8 }),
  body("age").isInt({ min: 0, max: 150 }),
  (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
      return res.status(400).json({ errors: errors.array() });
    }
    // Process valid input
  },
);
```

### Zod (TypeScript)

```typescript
import { z } from "zod";

const AllowedWebsiteSchema = z.string().transform((value, ctx) => {
  const url = parseAllowedHttpUrl(value, {
    baseUrl: "https://example.com",
    allowedOrigins: ["https://example.com"],
    allowedPathPrefixes: ["/profiles"],
  });

  if (!url) {
    ctx.addIssue({ code: "custom", message: "Invalid website URL" });
    return z.NEVER;
  }

  return url.href;
});

const UserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().email(),
  age: z.number().int().min(0).max(150).optional(),
  website: AllowedWebsiteSchema.optional(),
});

type User = z.infer<typeof UserSchema>;

function validateUser(data: unknown): User {
  return UserSchema.parse(data);
}
```

Schema validators are useful for structured input and typed parsing, but they do
not replace business rules. Add refinements or transforms for application rules
such as allowed URL origins, allowed enum transitions, cross-field constraints,
and authorization-dependent limits.

## Validation Checklist

- [ ] Validate all input on the server
- [ ] Use allowlist validation when possible
- [ ] Consume normalized parsed values after validation
- [ ] Validate data type, length, format, and range
- [ ] Avoid `parseInt`, `parseFloat`, and free-form `Date.parse()` as validators
- [ ] Reject unexpected input rather than sanitizing
- [ ] Use context-specific output encoding at the rendering boundary
- [ ] Sanitize only when accepting user-supplied HTML fragments
- [ ] Use parameterized queries for database operations
- [ ] Validate file uploads (type, size, content)
- [ ] Canonicalize paths before validation
- [ ] Log validation failures for monitoring

OWASP References:

- https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html
