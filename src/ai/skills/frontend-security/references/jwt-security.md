# JWT Security Reference

## Common Vulnerabilities

### None Algorithm Attack

Attack: Attacker changes algorithm to "none" to bypass signature verification.

```javascript
// VULNERABLE - accepts any algorithm
const decoded = jwt.verify(token, secret);

// SECURE - explicitly specify allowed algorithms
const decoded = jwt.verify(token, secret, {
  algorithms: ["HS256"], // Only accept HS256
});
```

### Algorithm Confusion Attack

Attack: Switching from RS256 to HS256 using public key as secret.

```javascript
// VULNERABLE - auto-detects algorithm
const decoded = jwt.verify(token, publicKey);

// SECURE - specify expected algorithm
const decoded = jwt.verify(token, publicKey, {
  algorithms: ["RS256"], // Only accept RS256
});
```

### Weak Secret

Attack: Brute-force weak HMAC secrets.

```javascript
// VULNERABLE - weak secret
const token = jwt.sign(payload, "password123");

// SECURE - strong random secret (256+ bits)
const crypto = require("crypto");
const secret = crypto.randomBytes(32); // 256 bits
const token = jwt.sign(payload, secret);

// Or use RSA keys
const privateKey = fs.readFileSync("private.pem");
const token = jwt.sign(payload, privateKey, { algorithm: "RS256" });
```

## Token Sidejacking Prevention

For browser-held bearer tokens, a hardened fingerprint cookie can reduce reuse
of a stolen token. Treat it as defense in depth, not a substitute for short
lifetimes, XSS prevention, revocation, or keeping tokens out of browser storage
when the architecture allows it.

```javascript
const crypto = require("crypto");

// Generate fingerprint on login
function generateFingerprint() {
  return crypto.randomBytes(32).toString("hex");
}

// Create token with fingerprint hash
function createToken(userId, fingerprint) {
  const fingerprintHash = crypto.createHash("sha256").update(fingerprint).digest("hex");

  return jwt.sign({ sub: userId, fph: fingerprintHash }, secret, { expiresIn: "15m" });
}

// Set fingerprint as httpOnly cookie
res.cookie("__Secure-Fgp", fingerprint, {
  httpOnly: true,
  secure: true,
  sameSite: "Strict",
  maxAge: 15 * 60 * 1000, // Match token expiry
});

// Validate both token and fingerprint
function validateToken(token, fingerprintCookie) {
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });

  const fingerprintHash = crypto.createHash("sha256").update(fingerprintCookie).digest("hex");

  if (decoded.fph !== fingerprintHash) {
    throw new Error("Invalid fingerprint");
  }

  return decoded;
}
```

## Token Storage and Browser Architecture

Choose token handling from the application architecture. Do not present
Web Storage as a universal default.

### Traditional Web App or BFF: httpOnly Cookie

Prefer server-owned sessions or a backend-for-frontend (BFF) that stores tokens
server-side and sends only `httpOnly`, `Secure`, SameSite cookies to the
browser. Cookie-based auth needs CSRF protection on state-changing requests;
SameSite is useful defense in depth but does not replace tokens plus
Origin/Referer checks for sensitive operations.

```javascript
// Server sets cookie
res.cookie("token", jwt, {
  httpOnly: true, // Not accessible via JavaScript
  secure: true, // HTTPS only
  sameSite: "Strict", // CSRF protection
  maxAge: 15 * 60 * 1000,
});

// Need CSRF protection with cookie-based auth
```

### SPA: In-Memory Access Token

For browser-only SPAs, prefer short-lived access tokens kept in memory, refresh
token rotation where appropriate, and a clear re-authentication path. Avoid
long-lived bearer tokens in Web Storage. If refresh tokens are issued to browser
clients, rotate them, expire them, detect reuse, and avoid storing them in
`localStorage` or other long-lived JavaScript-readable storage.

```javascript
let accessToken = null;
const trustedApiOrigin = "https://api.example.com";

export function setAccessToken(token) {
  accessToken = token;
}

export async function apiFetch(url, options = {}) {
  const target = new URL(url, trustedApiOrigin);
  if (target.origin !== trustedApiOrigin) {
    throw new Error("Refusing to send bearer token to an untrusted origin");
  }

  return fetch(target.href, {
    ...options,
    headers: {
      ...options.headers,
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
  });
}
```

### Constrained Fallback: sessionStorage + Fingerprint Cookie

`sessionStorage` is a last-resort compromise for browser-held bearer tokens, not
a security improvement over in-memory storage. It is readable by XSS. Use it
only when the architecture requires browser-held tokens and the risk is
explicitly accepted. Keep token lifetimes short, bind tokens to an `httpOnly`
fingerprint cookie when possible, and clear tokens on logout.

```javascript
sessionStorage.setItem("token", jwt);
sessionStorage.removeItem("token");
```

### Avoid: localStorage

```javascript
// VULNERABLE - persists after browser close, accessible to XSS
localStorage.setItem("token", jwt); // Not recommended
```

## Token Expiration

The refresh-token example is a server-side sketch. For browser clients, do not
pair it with long-lived refresh tokens stored in Web Storage; prefer a BFF,
server-side session, or refresh-token rotation with storage and replay controls
chosen for the client architecture.

```javascript
// Short-lived access tokens (15-60 minutes)
const accessToken = jwt.sign(payload, secret, { expiresIn: "15m" });

// Longer refresh tokens (days/weeks)
const refreshToken = jwt.sign({ sub: userId, type: "refresh" }, refreshSecret, { expiresIn: "7d" });

// Refresh endpoint
app.post("/refresh", async (req, res) => {
  const { refreshToken } = req.body;

  try {
    const decoded = jwt.verify(refreshToken, refreshSecret, {
      algorithms: ["HS256"],
    });

    if (decoded.type !== "refresh") {
      throw new Error("Invalid token type");
    }

    // Check if refresh token is revoked
    if (await isTokenRevoked(decoded)) {
      throw new Error("Token revoked");
    }

    // Issue new access token
    const newAccessToken = jwt.sign({ sub: decoded.sub }, secret, { expiresIn: "15m" });

    res.json({ accessToken: newAccessToken });
  } catch (error) {
    res.status(401).json({ error: "Invalid refresh token" });
  }
});
```

## Token Revocation

JWTs are stateless, so revocation requires additional mechanisms:

```javascript
// Denylist approach
const revokedTokens = new Map(); // Use Redis in production

function revokeToken(token) {
  const decoded = jwt.verify(token, secret, { algorithms: ["HS256"] });
  const tokenId = decoded.jti;
  const expiry = decoded.exp * 1000;

  if (!tokenId || !expiry) {
    throw new Error("Token missing required revocation claims");
  }

  // Store until token expires
  revokedTokens.set(tokenId, expiry);

  // Clean up expired entries periodically
  setTimeout(() => revokedTokens.delete(tokenId), Math.max(0, expiry - Date.now()));
}

function isTokenRevoked(decoded) {
  return Boolean(decoded.jti) && revokedTokens.has(decoded.jti);
}

// Include jti (JWT ID) in tokens
const token = jwt.sign({ sub: userId, jti: crypto.randomUUID() }, secret, { expiresIn: "15m" });
```

## Token Information Disclosure

JWTs are base64-encoded, not encrypted. Sensitive data is visible.

```javascript
// VULNERABLE - sensitive data in payload
const token = jwt.sign(
  {
    sub: userId,
    ssn: "123-45-6789", // Visible to anyone!
    salary: 100000,
  },
  secret,
);

// SECURE - minimal claims
const token = jwt.sign(
  {
    sub: userId,
    role: "user",
  },
  secret,
);

// If sensitive claims are unavoidable, use JWE or keep the data server-side.
const encryptedToken = encrypt(token, encryptionKey);
```

## Validation Middleware

This middleware validates bearer tokens after they reach an API. It does not
recommend where the browser should store those tokens; use the storage guidance
above before deciding whether a browser should send an `Authorization` header at
all.

```javascript
function authenticateToken(req, res, next) {
  // Get token from header
  const authHeader = req.headers.authorization;
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : undefined;

  if (!token) {
    return res.status(401).json({ error: "Token required" });
  }

  try {
    // Verify with explicit algorithm
    const decoded = jwt.verify(token, secret, {
      algorithms: ["HS256"],
      issuer: "myapp",
      audience: "myapp-users",
    });

    // Validate fingerprint if using sidejacking protection
    const fingerprint = req.cookies["__Secure-Fgp"];
    if (!validateFingerprint(decoded, fingerprint)) {
      throw new Error("Invalid fingerprint");
    }

    // Check revocation
    if (isTokenRevoked(decoded)) {
      throw new Error("Token revoked");
    }

    req.user = decoded;
    next();
  } catch (error) {
    if (error.name === "TokenExpiredError") {
      return res.status(401).json({ error: "Token expired" });
    }
    return res.status(403).json({ error: "Invalid token" });
  }
}
```

## Security Checklist

- [ ] Explicit algorithm specification (never auto-detect)
- [ ] Strong secret (256+ bits) or RSA keys
- [ ] Short expiration times (15-60 minutes for access tokens)
- [ ] Fingerprint cookie considered for browser-held bearer tokens where appropriate
- [ ] Validate issuer (iss) and audience (aud) claims
- [ ] Implement token revocation mechanism
- [ ] No sensitive data in payload
- [ ] Choose storage based on architecture: server-side session/BFF, in-memory SPA token, or constrained sessionStorage fallback
- [ ] Refresh tokens are rotated, replay-detected, and not kept in long-lived Web Storage
- [ ] Avoid long-lived bearer tokens in Web Storage
- [ ] Protect cookie-based auth with CSRF defenses
- [ ] Use HTTPS only

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/JSON_Web_Token_for_Java_Cheat_Sheet.html
