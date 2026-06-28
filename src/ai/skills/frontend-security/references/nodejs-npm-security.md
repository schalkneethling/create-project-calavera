# Node.js and NPM Security Reference

## NPM Dependency Security

### Audit Commands

```bash
# Check for vulnerabilities
npm audit

# Preview the proposed changes and lockfile diff first, then run `npm audit fix`
npm audit fix

# Force fix can apply breaking direct or transitive upgrades. Use only after
# reviewing release notes, dependency graphs, lockfile diffs, and test results.
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

### Dependency Update Review

Treat automated dependency updates as reviewable changes, not background
maintenance. Dependabot or Renovate PRs are useful because they isolate the
package, lockfile, release notes, provenance or publisher signals where
available, and CI result for each update. Review dependency diffs carefully for
new install scripts, ownership changes, unexpected transitive churn, native
build steps, and broad permission or runtime changes.

Run audits in CI and scheduled automation so ordinary installs are predictable.
Use `npm audit fix --force` only when the breaking-change and transitive-update
effects are understood.

### Package.json Security

Avoid package lifecycle scripts that fetch or audit during ordinary installs.
Install-time `npx` expands supply-chain trust, and `postinstall` audits make
local installs depend on network and registry behavior. Prefer pinned
devDependencies, package-manager-native overrides, CI checks, and scheduled
dependency automation.

```json
{
  "overrides": {
    "vulnerable-package": "^2.0.0"
  },
  "scripts": {
    "audit:ci": "npm audit --audit-level=high"
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

// SAFER - use execFile with arguments array and no shell
const { execFile } = require("child_process");
execFile("ls", ["--", userInput], { shell: false }, callback);

// SAFEST - avoid shelling out when a library API can do the work.
// If a command is necessary, allowlist the command and argument shapes.
const { spawn } = require("child_process");
const allowedFormats = new Set(["json", "text"]);
if (!allowedFormats.has(userSelectedFormat)) {
  throw new Error("Invalid format");
}
spawn("tool", ["--format", userSelectedFormat, "--", userPath], {
  shell: false,
  cwd: "/srv/app",
  env: { PATH: "/usr/bin:/bin" },
});
```

Argument arrays prevent shell metacharacter expansion, but they do not make
user-controlled arguments safe automatically. Some programs treat values as
options, paths, patterns, or expressions. Use `--` before user-controlled path
arguments when supported, validate option values, set `cwd` and `env`
explicitly, run with least privilege, and treat command output as untrusted.

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
        styleSrc: ["'self'"],
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
- [ ] Set up automated vulnerability scanning such as Dependabot or Renovate
- [ ] Review dependency and lockfile diffs for risky scripts, publisher changes, and unexpected transitive churn
- [ ] Keep dependencies updated
- [ ] Avoid typosquatting by double-checking package names
- [ ] Use `npm-shrinkwrap.json` only when publishing a deployable app or CLI that must lock transitive dependencies; avoid it for libraries unless you intentionally want to constrain consumers

OWASP References:

- https://cheatsheetseries.owasp.org/cheatsheets/Nodejs_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/NPM_Security_Cheat_Sheet.html
- https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html
- https://docs.npmjs.com/cli/commands/npm-audit
- https://docs.github.com/en/code-security/dependabot
- https://nodejs.org/api/child_process.html
