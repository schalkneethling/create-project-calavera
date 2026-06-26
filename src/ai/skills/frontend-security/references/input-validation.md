# Input Validation Reference

## Validation Strategy

**Always validate on the server.** Client-side validation improves UX but provides no security.

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
function validateUrl(input) {
  try {
    const url = new URL(input);
    return ["http:", "https:"].includes(url.protocol);
  } catch {
    return false;
  }
}

// For user-facing URLs, also check for malicious patterns
function validateSafeUrl(input) {
  const url = validateUrl(input);
  if (!url) return false;

  // Block data: and javascript: schemes
  const dangerous = ["javascript:", "data:", "vbscript:"];
  return !dangerous.some((scheme) => input.toLowerCase().startsWith(scheme));
}
```

### Numbers

```javascript
function validateInteger(input, min, max) {
  const num = parseInt(input, 10);
  if (isNaN(num)) return false;
  if (num.toString() !== input.toString()) return false; // Reject "123abc"
  return num >= min && num <= max;
}

function validateDecimal(input, min, max, decimals) {
  const num = parseFloat(input);
  if (isNaN(num)) return false;
  if (num < min || num > max) return false;

  const parts = input.split(".");
  if (parts.length > 2) return false;
  if (parts[1] && parts[1].length > decimals) return false;

  return true;
}
```

### Date

```javascript
function validateDate(input) {
  const date = new Date(input);
  return date instanceof Date && !isNaN(date);
}

function validateDateRange(input, minDate, maxDate) {
  const date = new Date(input);
  if (isNaN(date)) return false;
  return date >= minDate && date <= maxDate;
}
```

### Phone Numbers

```javascript
// International format
function validatePhone(input) {
  // E.164 format: +[country][number], max 15 digits
  const pattern = /^\+[1-9]\d{1,14}$/;
  return pattern.test(input.replace(/[\s\-()]/g, ""));
}
```

## Sanitization Functions

### HTML Entities

```javascript
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

const UserSchema = z.object({
  username: z
    .string()
    .min(3)
    .max(30)
    .regex(/^[a-zA-Z0-9_]+$/),
  email: z.string().email(),
  age: z.number().int().min(0).max(150).optional(),
  website: z.string().url().optional(),
});

type User = z.infer<typeof UserSchema>;

function validateUser(data: unknown): User {
  return UserSchema.parse(data);
}
```

## Validation Checklist

- [ ] Validate all input on the server
- [ ] Use allowlist validation when possible
- [ ] Validate data type, length, format, and range
- [ ] Reject unexpected input rather than sanitizing
- [ ] Use parameterized queries for database operations
- [ ] Validate file uploads (type, size, content)
- [ ] Canonicalize paths before validation
- [ ] Log validation failures for monitoring

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/Input_Validation_Cheat_Sheet.html
