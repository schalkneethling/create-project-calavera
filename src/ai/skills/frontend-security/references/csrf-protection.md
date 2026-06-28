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

### Naive Double Submit Cookie Pattern (Insufficient Alone)

Do not rely on a plain "cookie equals header" comparison as the main CSRF
defense. Use signed, session-bound double-submit tokens when the synchronizer
token pattern is not practical.

```javascript
// Recognition-only pseudocode for audits. Do not paste into production.
// If all the server checks is:
//
//   cookie.csrf_token === header["x-csrf-token"]
//
// then an attacker who can set or inject the cookie value may be able to satisfy
// both sides. Replace this pattern with a signed, session-bound token flow such
// as the Express.js example below.
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

Validate request origin using Sec-Fetch-\* headers as a layered control. Fetch
Metadata does not replace CSRF tokens for cookie-authenticated state-changing
requests. `Sec-Fetch-Site: none` usually represents user-initiated browser
navigations and should be allowed only for safe top-level navigations.
`same-site` can include sibling subdomains, so allow it only when every same-site
origin shares the same trust boundary.

```javascript
function validateFetchMetadata(req, res, next) {
  const site = req.headers["sec-fetch-site"];
  const mode = req.headers["sec-fetch-mode"];
  const dest = req.headers["sec-fetch-dest"];
  const method = req.method;
  const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(method);
  const trustSameSiteSubdomains = false;

  // Absence is not proof of safety. Continue only to rely on CSRF tokens and
  // Origin/Referer validation in later middleware.
  if (!site) return next();

  // Allow same-origin requests
  if (site === "same-origin") return next();

  // Same-site can include sibling subdomains. Only allow it where those
  // subdomains share the same trust boundary, and do not use it to permit
  // state-changing requests without CSRF token validation.
  if (site === "same-site" && trustSameSiteSubdomains && safeMethod) {
    return next();
  }

  // Allow browser-initiated top-level navigations only for safe methods.
  if (site === "none" && mode === "navigate" && dest === "document" && safeMethod) {
    return next();
  }

  return res.status(403).json({ error: "Fetch metadata validation failed" });
}
```

## Origin and Referer Checks

Check `Origin` for state-changing requests and fall back to `Referer` only when
needed. Treat missing headers according to the endpoint risk and client support.

```javascript
function validateOrigin(req, res, next) {
  const expectedOrigin = "https://app.example.com";
  const origin = req.headers.origin;
  const referer = req.headers.referer;

  if (origin) {
    if (origin !== expectedOrigin) {
      return res.status(403).json({ error: "Invalid origin" });
    }
    return next();
  }

  if (referer) {
    try {
      if (new URL(referer).origin !== expectedOrigin) {
        return res.status(403).json({ error: "Invalid referer" });
      }
      return next();
    } catch {
      return res.status(403).json({ error: "Invalid referer" });
    }
  }

  return res.status(403).json({ error: "Missing origin" });
}
```

## Framework Integration

### Express.js with Signed Double-Submit Tokens

This server-rendered variant stores the signed token in an `httpOnly` cookie and
also injects the same token into the form response. Do not combine this exact
cookie setting with client libraries that expect JavaScript to read the CSRF
cookie automatically. For AJAX-only clients, inject the token into the page or
use a readable signed CSRF cookie only when that exposure is an accepted tradeoff;
the server must still verify the signature and session binding.

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

Protect AJAX requests by sending a server-provided CSRF token in a header. Avoid
using a plain cookie-to-header mirror as the only defense; the token must still
be signed and session-bound or backed by a server-side synchronizer token.

```javascript
// If the server intentionally exposes a signed CSRF cookie to JavaScript:
import axios from "axios";

axios.defaults.xsrfCookieName = "csrf_token";
axios.defaults.xsrfHeaderName = "X-CSRF-Token";
axios.defaults.withCredentials = true;

// Prefer server-rendered meta tags or a bootstrap response when using fetch.
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
- [ ] Origin or Referer validated for state-changing requests
- [ ] GET requests are idempotent (no state changes)

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html
