# CSRF Protection Reference

## Token-Based Protection

### Synchronizer Token Pattern

Generate unique per-session tokens and validate on state-changing requests:

```javascript
// Server-side token generation (Node.js)
const crypto = require("crypto");

function generateCSRFToken(session) {
  const token = crypto.randomBytes(32).toString("hex");
  session.csrfToken = token;
  return token;
}

// Middleware validation
function validateCSRF(req, res, next) {
  const token = req.headers["x-csrf-token"] || req.body._csrf;
  const sessionToken = req.session.csrfToken;

  if (typeof token !== "string" || typeof sessionToken !== "string") {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }

  const tokenBuffer = Buffer.from(token);
  const sessionTokenBuffer = Buffer.from(sessionToken);

  if (
    tokenBuffer.length !== sessionTokenBuffer.length ||
    !crypto.timingSafeEqual(tokenBuffer, sessionTokenBuffer)
  ) {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }
  next();
}
```

### Double Submit Cookie Pattern

```javascript
// Set CSRF cookie
res.cookie("csrf_token", token, {
  httpOnly: false, // Must be readable by JavaScript
  secure: true,
  sameSite: "Strict",
});

// Client sends token in header
fetch("/api/action", {
  method: "POST",
  headers: {
    "X-CSRF-Token": getCookie("csrf_token"),
  },
});

// Server validates cookie matches header
import { timingSafeEqual } from "node:crypto";

function validateDoubleSubmit(req) {
  const cookieToken = req.cookies.csrf_token;
  const headerToken = req.headers["x-csrf-token"];

  if (typeof cookieToken !== "string" || typeof headerToken !== "string") {
    return false;
  }

  const cookieBuffer = Buffer.from(cookieToken);
  const headerBuffer = Buffer.from(headerToken);

  return cookieBuffer.length === headerBuffer.length && timingSafeEqual(cookieBuffer, headerBuffer);
}
```

## SameSite Cookie Attribute

```javascript
// Strict - never sent cross-site
res.cookie("session", value, { sameSite: "Strict", secure: true, httpOnly: true });

// Lax - sent for top-level GET navigations (default in modern browsers)
res.cookie("session", value, { sameSite: "Lax", secure: true, httpOnly: true });

// None - requires Secure flag, sent cross-site
res.cookie("session", value, { sameSite: "None", secure: true, httpOnly: true });
```

**Recommendation**: Use `SameSite=Strict` for session cookies when possible, `Lax` as minimum.

## Fetch Metadata Headers

Validate request origin using Sec-Fetch-\* headers:

```javascript
function validateFetchMetadata(req, res, next) {
  const site = req.headers["sec-fetch-site"];
  const mode = req.headers["sec-fetch-mode"];
  const dest = req.headers["sec-fetch-dest"];
  const method = req.method;

  // Allow same-origin requests
  if (site === "same-origin") return next();

  // Allow user-initiated browser navigations
  if (site === "none") return next();

  // Allow same-site top-level navigations and safe methods
  if (
    site === "same-site" &&
    (mode === "navigate" || ["GET", "HEAD", "OPTIONS"].includes(method))
  ) {
    return next();
  }

  return res.status(403).json({ error: "Fetch metadata validation failed" });
}
```

## Framework Integration

### Express.js with Signed Double-Submit Tokens

```javascript
const crypto = require("crypto");

const CSRF_COOKIE_NAME = "csrf_token";
if (!/^[a-f0-9]{64,}$/i.test(process.env.CSRF_SECRET || "")) {
  throw new Error("CSRF_SECRET must be a hex-encoded secret with at least 32 bytes of entropy");
}

const CSRF_SECRET = Buffer.from(process.env.CSRF_SECRET, "hex");

function signToken(sessionId, nonce) {
  return crypto
    .createHmac("sha256", CSRF_SECRET)
    .update(`${sessionId}:${nonce}`)
    .digest("base64url");
}

function constantTimeEqual(value, expected) {
  if (typeof value !== "string" || typeof expected !== "string") return false;

  const valueBuffer = Buffer.from(value);
  const expectedBuffer = Buffer.from(expected);

  return (
    valueBuffer.length === expectedBuffer.length &&
    crypto.timingSafeEqual(valueBuffer, expectedBuffer)
  );
}

function generateToken(req) {
  const nonce = crypto.randomBytes(32).toString("base64url");
  const signature = signToken(req.session.id, nonce);
  return `${nonce}.${signature}`;
}

function sendToken(req, res, next) {
  const token = generateToken(req);

  res.cookie(CSRF_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
  });

  res.locals.csrfToken = token;
  next();
}

function verifyToken(req, res, next) {
  const token = req.headers["x-csrf-token"] || req.body._csrf;
  const cookieToken = req.cookies[CSRF_COOKIE_NAME];

  if (!constantTimeEqual(token, cookieToken)) {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }

  const [nonce, signature, extra] = cookieToken.split(".");
  if (extra || !nonce || !signature) {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }

  if (!constantTimeEqual(signature, signToken(req.session.id, nonce))) {
    return res.status(403).json({ error: "Invalid CSRF token" });
  }

  next();
}

app.get("/form", sendToken, (req, res) => {
  res.render("form", { csrfToken: res.locals.csrfToken });
});

app.post("/submit", verifyToken, (req, res) => {
  res.json({ ok: true });
});
```

Example tests for token issuance and verification:

```javascript
const assert = require("node:assert/strict");
const test = require("node:test");

test("sendToken issues a cookie and exposes a form token", () => {
  const req = { session: { id: "session-123" } };
  const res = {
    locals: {},
    cookie(name, value, options) {
      this.cookieArgs = { name, value, options };
    },
  };

  sendToken(req, res, () => {});

  assert.equal(res.cookieArgs.name, CSRF_COOKIE_NAME);
  assert.equal(res.locals.csrfToken, res.cookieArgs.value);
  assert.equal(res.cookieArgs.options.httpOnly, true);
  assert.equal(res.cookieArgs.options.sameSite, "Strict");
});

test("verifyToken accepts a matching signed token", () => {
  const req = { session: { id: "session-123" } };
  const token = generateToken(req);
  let called = false;

  verifyToken(
    {
      ...req,
      headers: { "x-csrf-token": token },
      body: {},
      cookies: { [CSRF_COOKIE_NAME]: token },
    },
    {},
    () => {
      called = true;
    },
  );

  assert.equal(called, true);
});

test("verifyToken rejects mismatched or tampered tokens", () => {
  const req = {
    session: { id: "session-123" },
    headers: { "x-csrf-token": "tampered.token" },
    body: {},
    cookies: { [CSRF_COOKIE_NAME]: generateToken({ session: { id: "session-123" } }) },
  };
  const res = {
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
    },
  };

  verifyToken(req, res, () => {});

  assert.equal(res.statusCode, 403);
  assert.deepEqual(res.body, { error: "Invalid CSRF token" });
});
```

### React Forms

```jsx
function Form({ csrfToken }) {
  const handleSubmit = async (e) => {
    e.preventDefault();
    await fetch("/api/submit", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-CSRF-Token": csrfToken,
      },
      body: JSON.stringify(formData),
    });
  };

  return (
    <form onSubmit={handleSubmit}>
      <input type="hidden" name="_csrf" value={csrfToken} />
      {/* form fields */}
    </form>
  );
}
```

### Twig Forms

```twig
<form method="post" action="/submit">
  <input type="hidden" name="_csrf_token" value="{{ csrf_token('form_name') }}">
  <!-- form fields -->
</form>
```

## Client-Side CSRF (AJAX)

Protect against CSRF in single-page applications:

```javascript
// Set up axios defaults
import axios from "axios";

axios.defaults.xsrfCookieName = "csrf_token";
axios.defaults.xsrfHeaderName = "X-CSRF-Token";
axios.defaults.withCredentials = true;

// Or with fetch
async function secureFetch(url, options = {}) {
  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content;

  return fetch(url, {
    ...options,
    credentials: "same-origin",
    headers: {
      ...options.headers,
      "X-CSRF-Token": csrfToken,
    },
  });
}
```

## Verification Checklist

- [ ] All state-changing endpoints require CSRF tokens
- [ ] Tokens are cryptographically random (≥128 bits)
- [ ] Tokens are tied to user session
- [ ] Tokens validated server-side before processing
- [ ] SameSite cookie attribute set appropriately
- [ ] Fetch Metadata headers validated for sensitive endpoints
- [ ] GET requests are idempotent (no state changes)

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
