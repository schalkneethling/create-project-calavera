# Node.js and NPM Security Reference

## NPM Dependency Security

### Audit Commands

```bash
# Check for vulnerabilities
npm audit

# Fix automatically where possible
npm audit fix

# Force fix (may have breaking changes)
npm audit fix --force

# Generate detailed report
npm audit --json > audit-report.json
```

### Lockfile Enforcement

```bash
# Always use lockfile in CI/CD
npm ci  # Instead of npm install

# Verify lockfile integrity
npm ci --ignore-scripts  # Safer for first run
```

### Package.json Security

```json
{
  "scripts": {
    "preinstall": "npx npm-force-resolutions",
    "postinstall": "npm audit"
  },
  "overrides": {
    "vulnerable-package": "^2.0.0"
  }
}
```

## Dangerous Functions

### Code Execution

```javascript
// DANGEROUS - never use with user input
eval(userInput);
new Function(userInput);
vm.runInThisContext(userInput);
require(userInput);

// DANGEROUS - setTimeout/setInterval with strings
setTimeout(userInput, 1000); // Executes as code

// SAFE - pass functions instead
setTimeout(() => {
  /* code */
}, 1000);
```

### Child Process Injection

```javascript
// DANGEROUS - command injection
const { exec } = require("child_process");
exec(`ls ${userInput}`); // Shell injection

// SAFER - use execFile with arguments array
const { execFile } = require("child_process");
execFile("ls", [userInput], callback); // Arguments not interpreted by shell

// SAFEST - use spawn with shell: false
const { spawn } = require("child_process");
spawn("ls", [userInput], { shell: false });
```

### File System

```javascript
const path = require("path");
const fs = require("fs");

// DANGEROUS - path traversal
const filePath = `/uploads/${userInput}`;

// SAFE - validate and resolve path
function safeReadFile(userInput, baseDir) {
  const basePath = path.resolve(baseDir);
  const safePath = path.resolve(basePath, userInput);
  const relativePath = path.relative(basePath, safePath);

  // Verify path is within allowed directory
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Invalid file path");
  }

  return fs.readFileSync(safePath);
}
```

## Request Handling

### Rate Limiting

```javascript
const rateLimit = require("express-rate-limit");

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per window
  message: "Too many requests",
  standardHeaders: true,
  legacyHeaders: false,
});

app.use(limiter);

// Stricter limits for auth endpoints
const authLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 5, // 5 attempts per hour
  message: "Too many login attempts",
});

app.use("/api/login", authLimiter);
```

### Request Size Limits

```javascript
const express = require("express");
const app = express();

// Limit JSON body size
app.use(express.json({ limit: "100kb" }));

// Limit URL-encoded body
app.use(express.urlencoded({ extended: true, limit: "100kb" }));

// Limit file uploads
const multer = require("multer");
const upload = multer({
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
});
```

### Timeout Configuration

```javascript
const server = app.listen(3000);

// Set timeouts
server.setTimeout(30000); // 30 seconds
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;
```

## Secure Headers

```javascript
const helmet = require("helmet");

app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", "data:", "https:"],
        objectSrc: ["'none'"],
        upgradeInsecureRequests: [],
      },
    },
    hsts: {
      maxAge: 31536000,
      includeSubDomains: true,
      preload: true,
    },
    referrerPolicy: { policy: "strict-origin-when-cross-origin" },
    frameguard: { action: "deny" },
  }),
);
```

## Error Handling

```javascript
// Global error handler - don't expose details
app.use((err, req, res, next) => {
  // Log full error internally
  console.error(err);

  // Send generic message to client
  res.status(500).json({
    error: "An unexpected error occurred",
  });
});

// Async error wrapper
const asyncHandler = (fn) => (req, res, next) => {
  Promise.resolve(fn(req, res, next)).catch(next);
};

app.get(
  "/data",
  asyncHandler(async (req, res) => {
    const data = await fetchData();
    res.json(data);
  }),
);
```

## Environment Variables

```javascript
// NEVER commit secrets to code
// Use environment variables
const apiKey = process.env.API_KEY;

// Validate required env vars at startup
const required = ["API_KEY", "DB_URL", "SESSION_SECRET"];
required.forEach((varName) => {
  if (!process.env[varName]) {
    console.error(`Missing required env var: ${varName}`);
    process.exit(1);
  }
});
```

## Regex DoS Prevention

```javascript
// DANGEROUS - evil regex (catastrophic backtracking)
const evilRegex = /^(a+)+$/;
evilRegex.test("aaaaaaaaaaaaaaaaaaaaaaaaaaa!"); // Hangs

// Heuristic only: safe-regex can have false positives/negatives for ReDoS
const safe = require("safe-regex");
if (!safe(userProvidedRegex)) {
  throw new Error("Unsafe regex pattern");
}

// Preferred for untrusted patterns: use RE2 for guaranteed linear time
const RE2 = require("re2");
const pattern = new RE2(userProvidedRegex);
```

## NPM Security Checklist

- [ ] Run `npm audit` regularly and in CI/CD
- [ ] Use `npm ci` instead of `npm install` in CI
- [ ] Enable 2FA on npm account
- [ ] Use lockfiles and commit them
- [ ] Review new dependencies before installation
- [ ] Use `--ignore-scripts` for untrusted packages
- [ ] Set up automated vulnerability scanning (Snyk, Dependabot)
- [ ] Keep dependencies updated
- [ ] Avoid typosquatting by double-checking package names
- [ ] Use `npm-shrinkwrap.json` for published packages

OWASP References:

- https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html
