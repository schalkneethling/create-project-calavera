# File Upload Security Reference

## Core Protection Checklist

- [ ] Validate file extension (allowlist only)
- [ ] Treat client Content-Type as advisory only
- [ ] Validate content with maintained type detection or domain-specific parsers
- [ ] Generate a new random storage filename
- [ ] Enforce file size limits
- [ ] Store outside webroot
- [ ] Quarantine and scan risky files before serving
- [ ] Require authentication
- [ ] Implement CSRF protection

## Extension Validation

### Allowlist Approach

```javascript
const ALLOWED_EXTENSIONS = {
  images: [".jpg", ".jpeg", ".png", ".gif", ".webp"],
  documents: [".pdf", ".docx", ".xlsx"],
  data: [".csv", ".json"],
};

function validateExtension(filename, category) {
  const ext = path.extname(filename).toLowerCase();
  return ALLOWED_EXTENSIONS[category]?.includes(ext) ?? false;
}
```

### Dangerous Extensions to Block

```javascript
const DANGEROUS_EXTENSIONS = [
  // Server-side execution
  ".php",
  ".php3",
  ".php4",
  ".php5",
  ".phtml",
  ".asp",
  ".aspx",
  ".ascx",
  ".ashx",
  ".jsp",
  ".jspx",
  ".jspa",
  ".cgi",
  ".pl",
  ".py",
  ".rb",

  // Windows executable
  ".exe",
  ".dll",
  ".bat",
  ".cmd",
  ".com",
  ".msi",
  ".ps1",

  // Script files
  ".js",
  ".vbs",
  ".wsf",
  ".hta",

  // Config files
  ".htaccess",
  ".htpasswd",
  ".config",
  ".ini",

  // Archive (can contain malicious files)
  ".zip",
  ".tar",
  ".gz",
  ".rar",
  ".7z",
];
```

### Storage Filename Generation

Do not store files using attacker-controlled names, even after stripping
characters or double extensions. Preserve the original display name only as
metadata if the product needs it.

```javascript
function generateStorageName(filename) {
  const ext = path.extname(filename).toLowerCase();
  const uuid = crypto.randomUUID();
  return `${uuid}${ext}`;
}
```

## Content-Type Validation

The browser-supplied MIME type is useful for quick rejection and UX, but it is
client controlled. Validate stored content with a maintained file-type detector
or a parser for the expected domain before trusting the file.

```javascript
const ALLOWED_MIME_TYPES = {
  ".jpg": ["image/jpeg"],
  ".jpeg": ["image/jpeg"],
  ".png": ["image/png"],
  ".gif": ["image/gif"],
  ".webp": ["image/webp"],
  ".pdf": ["application/pdf"],
  ".docx": ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
};

function validateMimeType(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  const allowedMimes = ALLOWED_MIME_TYPES[ext];

  if (!allowedMimes) return false;
  return allowedMimes.includes(file.mimetype);
}
```

## Content Signature Validation

```javascript
import { fileTypeFromBuffer } from "file-type";

async function detectAllowedType(buffer, allowedMimeTypes) {
  const detected = await fileTypeFromBuffer(buffer);
  if (!detected || !allowedMimeTypes.includes(detected.mime)) {
    return null;
  }
  return detected;
}
```

Magic-byte checks are only one signal. Polyglot files, container formats, and
domain-specific payloads may need deeper parsing, re-encoding, or manual review.

## Safe Storage

```javascript
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");

// Store OUTSIDE webroot
const UPLOAD_DIR = "/var/app/uploads"; // Not in /public/

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    // Organize by date
    const date = new Date().toISOString().split("T")[0];
    const dir = path.join(UPLOAD_DIR, date);
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    // Generate random filename
    const ext = path.extname(file.originalname).toLowerCase();
    const name = crypto.randomBytes(16).toString("hex");
    cb(null, `${name}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: {
    fileSize: 5 * 1024 * 1024, // 5MB
    files: 1,
  },
  fileFilter: (req, file, cb) => {
    // Early rejection only. Validate actual content after receiving the file.
    if (!validateMimeType(file)) {
      cb(new Error("Invalid file type"));
      return;
    }
    cb(null, true);
  },
});
```

## Secure File Serving

```javascript
const contentDisposition = require("content-disposition");

// Serve files through application, not directly
app.get("/files/:id", async (req, res) => {
  // Verify user authorization
  if (!req.user || !canAccessFile(req.user, req.params.id)) {
    return res.status(403).send("Forbidden");
  }

  // Get file from database (not from user input)
  const fileRecord = await db.getFile(req.params.id);
  if (!fileRecord) return res.status(404).send("Not found");

  // Set safe headers
  res.setHeader("Content-Type", fileRecord.mimeType);
  res.setHeader("Content-Disposition", contentDisposition(fileRecord.displayName));
  res.setHeader("X-Content-Type-Options", "nosniff");

  // Stream file
  const stream = fs.createReadStream(fileRecord.path);
  stream.pipe(res);
});
```

## Image Rewriting

Destroy potential malicious content by re-encoding images:

```javascript
const sharp = require("sharp");

async function sanitizeImage(inputPath, outputPath) {
  await sharp(inputPath)
    .rotate() // Apply EXIF orientation
    .toFormat("jpeg", { quality: 90 }) // Re-encode
    .toFile(outputPath);
}
```

## ZIP File Handling

Prefer not to extract user-provided archives. If extraction is a product
requirement, use a streaming library, extract into a dedicated temporary
directory, reject links/devices, normalize paths across platforms, enforce
limits while reading, and move accepted files into final storage only after all
checks pass.

```javascript
import AdmZip from "adm-zip";
import { fileTypeFromBuffer } from "file-type";
import path from "node:path";

const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-tar",
  "application/gzip",
  "application/x-7z-compressed",
  "application/vnd.rar",
]);

async function validateZipBeforeExtract(zipPath, destDir, options = {}) {
  const {
    maxTotalSize = 100 * 1024 * 1024,
    maxEntrySize = 10 * 1024 * 1024,
    maxEntries = 1000,
    maxDepth = 8,
  } = options;
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  if (entries.length > maxEntries) {
    throw new Error("Too many archive entries");
  }

  let totalSize = 0;
  const seenTargets = new Set();

  for (const entry of entries) {
    const normalizedName = entry.entryName.replace(/\\/g, "/");
    const depth = normalizedName.split("/").filter(Boolean).length;
    if (depth > maxDepth) {
      throw new Error("Archive entry is too deeply nested");
    }

    const resolvedDest = path.resolve(destDir);
    const resolvedEntry = path.resolve(destDir, normalizedName);
    const relativeEntry = path.relative(resolvedDest, resolvedEntry);

    if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
      throw new Error("Path traversal detected");
    }

    if (seenTargets.has(resolvedEntry)) {
      throw new Error("Duplicate archive target path");
    }
    seenTargets.add(resolvedEntry);

    if (entry.header.fileNameLength === 0 || entry.isDirectory) continue;
    if (entry.attr & 0o120000) {
      throw new Error("Archive symlink entries are not allowed");
    }

    if (entry.header.size > maxEntrySize) {
      throw new Error("Archive entry exceeds per-file limit");
    }

    totalSize += entry.header.size;
    if (totalSize > maxTotalSize) {
      throw new Error("Extracted size exceeds limit");
    }

    if (entry.header.compressedSize === 0) {
      if (entry.header.size > 0) {
        throw new Error("Suspicious zero-compressed entry");
      }
      continue;
    }

    const ratio = entry.header.size / entry.header.compressedSize;
    if (ratio > 100) {
      throw new Error("Suspicious compression ratio");
    }

    const detected = await fileTypeFromBuffer(entry.getData());
    if (detected && ARCHIVE_MIME_TYPES.has(detected.mime)) {
      throw new Error("Nested archives are not allowed");
    }
  }
}
```

## Express.js Complete Example

```javascript
const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs").promises;
const sharp = require("sharp");

const app = express();

// Configuration
const UPLOAD_DIR = "/var/app/uploads";
const MAX_FILE_SIZE = 5 * 1024 * 1024;
const ALLOWED_TYPES = ["image/jpeg", "image/png", "image/gif"];

// Multer setup
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (req, file, cb) => {
    // Early rejection only. Validate actual content after upload.
    if (!ALLOWED_TYPES.includes(file.mimetype)) {
      cb(new multer.MulterError("LIMIT_UNEXPECTED_FILE"));
      return;
    }
    cb(null, true);
  },
});

// Upload endpoint
app.post(
  "/upload",
  requireAuth, // Authentication
  verifyToken, // CSRF token
  upload.single("file"), // File handling
  async (req, res) => {
    try {
      const file = req.file;
      if (!file) return res.status(400).json({ error: "No file" });

      const detected = await detectAllowedType(file.buffer, ALLOWED_TYPES);
      if (!detected) {
        return res.status(400).json({ error: "Invalid file" });
      }

      // Generate safe storage filename for the re-encoded JPEG.
      const filename = `${crypto.randomUUID()}.jpg`;
      const filepath = path.join(UPLOAD_DIR, filename);

      // Re-encode images before they become downloadable.
      const output = await sharp(file.buffer).rotate().toFormat("jpeg", { quality: 90 }).toBuffer();
      await fs.writeFile(filepath, output);

      // Store metadata in database
      const fileRecord = await db.createFile({
        userId: req.user.id,
        filename,
        originalName: file.originalname,
        mimeType: "image/jpeg",
        size: output.length,
        status: "available",
      });

      res.json({ id: fileRecord.id });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Upload failed" });
    }
  },
);
```

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
