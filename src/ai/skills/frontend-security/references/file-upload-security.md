# File Upload Security Reference

## Core Protection Checklist

- [ ] Validate file extension (allowlist only)
- [ ] Validate Content-Type header
- [ ] Validate file signature (magic bytes)
- [ ] Generate new random filename
- [ ] Enforce file size limits
- [ ] Store outside webroot
- [ ] Scan for malware
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

### Double Extension Prevention

```javascript
function sanitizeFilename(filename) {
  // Remove all extensions except the last
  const parts = filename.split(".");
  if (parts.length > 2) {
    return `${parts[0]}.${parts[parts.length - 1]}`;
  }

  // Or generate completely new filename
  const ext = path.extname(filename).toLowerCase();
  const uuid = crypto.randomUUID();
  return `${uuid}${ext}`;
}
```

## Content-Type Validation

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

## File Signature (Magic Bytes) Validation

```javascript
const FILE_SIGNATURES = {
  jpg: Buffer.from([0xff, 0xd8, 0xff]),
  png: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  gif: Buffer.from([0x47, 0x49, 0x46, 0x38]),
  pdf: Buffer.from([0x25, 0x50, 0x44, 0x46]),
  zip: Buffer.from([0x50, 0x4b, 0x03, 0x04]),
};

async function validateFileSignature(filePath, expectedType) {
  const buffer = Buffer.alloc(8);
  const fd = await fs.open(filePath, "r");
  try {
    await fd.read(buffer, 0, 8, 0);
  } finally {
    await fd.close();
  }

  const signature = FILE_SIGNATURES[expectedType];
  if (!signature) return false;

  return buffer.slice(0, signature.length).equals(signature);
}
```

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
  res.setHeader("Content-Disposition", `attachment; filename="${fileRecord.safeName}"`);
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

```javascript
const AdmZip = require("adm-zip");
const path = require("path");

function safeExtractZip(zipPath, destDir, maxSize = 100 * 1024 * 1024) {
  const zip = new AdmZip(zipPath);
  const entries = zip.getEntries();

  let totalSize = 0;

  for (const entry of entries) {
    // Check for path traversal
    const resolvedDest = path.resolve(destDir);
    const resolvedEntry = path.resolve(destDir, entry.entryName);
    const relativeEntry = path.relative(resolvedDest, resolvedEntry);

    if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
      throw new Error("Path traversal detected");
    }

    // Check for zip bomb
    totalSize += entry.header.size;
    if (totalSize > maxSize) {
      throw new Error("Extracted size exceeds limit");
    }

    // Check compression ratio (zip bomb indicator)
    const ratio = entry.header.size / entry.header.compressedSize;
    if (ratio > 100) {
      throw new Error("Suspicious compression ratio");
    }
  }

  zip.extractAllTo(destDir, true);
}
```

## Express.js Complete Example

```javascript
const express = require("express");
const multer = require("multer");
const path = require("path");
const crypto = require("crypto");
const fs = require("fs").promises;

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

      // Validate magic bytes
      if (!validateMagicBytes(file.buffer, file.mimetype)) {
        return res.status(400).json({ error: "Invalid file" });
      }

      // Generate safe filename
      const ext = path.extname(file.originalname).toLowerCase();
      const filename = `${crypto.randomUUID()}${ext}`;
      const filepath = path.join(UPLOAD_DIR, filename);

      // Save file
      await fs.writeFile(filepath, file.buffer);

      // Store metadata in database
      const fileRecord = await db.createFile({
        userId: req.user.id,
        filename,
        originalName: file.originalname,
        mimeType: file.mimetype,
        size: file.size,
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
