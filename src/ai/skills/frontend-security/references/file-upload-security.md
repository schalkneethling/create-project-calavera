# File Upload Security Reference

## Core Protection Checklist

- [ ] Validate file extension (allowlist only)
- [ ] Treat client Content-Type as advisory only
- [ ] Validate content with maintained type detection or domain-specific parsers
- [ ] Generate a new random storage filename
- [ ] Enforce file size limits
- [ ] Store outside webroot
- [ ] Quarantine and scan risky files before serving
- [ ] Re-encode images or apply CDR where appropriate
- [ ] Serve downloads through an authorization-checked handler with safe headers
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
function generateStorageName(serverValidatedExtension) {
  const ext = serverValidatedExtension.toLowerCase();
  const uuid = crypto.randomUUID();
  return `${uuid}${ext}`;
}

const outputExtension = ".jpg"; // Chosen by the server-side image rewrite pipeline.
const storageName = generateStorageName(outputExtension);
```

Prefer deriving the final extension from the server-validated or rewritten file,
not from `file.originalname`. For example, image rewrite pipelines that always
emit JPEG should store a random `*.jpg` name regardless of the uploaded name.

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
  if (fileRecord.status !== "available") return res.status(404).send("Not found");

  // Set safe headers
  res.setHeader("Content-Type", fileRecord.mimeType);
  res.setHeader(
    "Content-Disposition",
    contentDisposition(fileRecord.displayName, { type: "attachment" }),
  );
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
    .toFormat("jpeg", { quality: 90 }) // Re-encode without preserving metadata
    .toFile(outputPath);
}
```

Do not call `withMetadata()` unless the product explicitly requires metadata
retention and the fields have been reviewed for privacy and scriptable payload
risk. For PDF, DOCX, and other active document formats, use a dedicated
Content Disarm and Reconstruction (CDR) flow or hold files for manual review.

## Quarantine and Scanning Workflow

Treat upload completion as the start of processing, not approval to serve the
file. Store new files in a private quarantine location, record `quarantined`
metadata, and make the download route refuse anything that is not explicitly
`available`.

```javascript
async function quarantineUpload({ buffer, detected, originalName, userId }) {
  const quarantinedName = `${crypto.randomUUID()}.bin`;
  const quarantinePath = path.join(QUARANTINE_DIR, quarantinedName);

  await fs.writeFile(quarantinePath, buffer, { mode: 0o600 });

  const fileRecord = await db.createFile({
    userId,
    originalName,
    storageName: quarantinedName,
    mimeType: detected.mime,
    status: "quarantined",
  });

  await scanQueue.enqueue({ fileId: fileRecord.id, path: quarantinePath });
  return fileRecord;
}

async function releaseAfterScan(fileRecord, cleanPath, releaseMetadata) {
  if (fileRecord.status !== "quarantined") {
    throw new Error("Only quarantined files can be released");
  }

  const storageName = `${crypto.randomUUID()}${releaseMetadata.extension}`;
  const storagePath = path.join(UPLOAD_DIR, storageName);

  await fs.rename(cleanPath, storagePath);
  try {
    await db.updateFile(fileRecord.id, {
      storageName,
      storagePath,
      storageRoot: "uploads",
      mimeType: releaseMetadata.mimeType,
      size: releaseMetadata.size,
      status: "available",
    });
  } catch (error) {
    await fs.rename(storagePath, cleanPath).catch(() => {});
    throw error;
  }
}
```

The scanner can be antivirus, sandbox detonation, CDR, image re-encoding, or a
manual review queue depending on file type and risk. Avoid sending sensitive
customer files to public scanning APIs unless that data-sharing model is
explicitly approved.

## ZIP File Handling

Prefer not to extract user-provided archives. If extraction is a product
requirement, use a streaming library, extract into a dedicated temporary
directory, reject links/devices, normalize paths across platforms, enforce
limits while reading, and move accepted files into final storage only after all
checks pass.

```javascript
import { fileTypeFromBuffer } from "file-type";
import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";

const ARCHIVE_MIME_TYPES = new Set([
  "application/zip",
  "application/x-tar",
  "application/gzip",
  "application/x-7z-compressed",
  "application/vnd.rar",
]);

const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;
const UNIX_CHARACTER_DEVICE = 0o020000;
const UNIX_BLOCK_DEVICE = 0o060000;
const UNIX_FIFO = 0o010000;
const UNIX_SOCKET = 0o140000;

function openZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true, validateEntrySizes: true }, (error, zip) =>
      error ? reject(error) : resolve(zip),
    );
  });
}

function nextZipEntry(zip) {
  return new Promise((resolve, reject) => {
    function cleanup() {
      zip.off("entry", onEntry);
      zip.off("end", onEnd);
      zip.off("error", onError);
    }

    function onEntry(entry) {
      cleanup();
      resolve(entry);
    }

    function onEnd() {
      cleanup();
      resolve(null);
    }

    function onError(error) {
      cleanup();
      reject(error);
    }

    zip.once("entry", onEntry);
    zip.once("end", onEnd);
    zip.once("error", onError);
    zip.readEntry();
  });
}

async function* readZipEntries(zip) {
  while (true) {
    const entry = await nextZipEntry(zip);
    if (!entry) return;
    yield entry;
  }
}

function assertSafeArchiveName(entryName, destDir, seenTargets, maxDepth) {
  const normalizedName = entryName.replace(/\\/g, "/");
  if (normalizedName.includes("\0") || /^[a-zA-Z]:/.test(normalizedName)) {
    throw new Error("Unsafe archive entry name");
  }

  const parts = normalizedName.split("/").filter(Boolean);
  if (parts.length === 0 || parts.length > maxDepth) {
    throw new Error("Archive entry has invalid depth");
  }

  if (path.posix.isAbsolute(normalizedName) || parts.includes("..")) {
    throw new Error("Path traversal detected");
  }

  const resolvedDest = path.resolve(destDir);
  const resolvedEntry = path.resolve(resolvedDest, ...parts);
  const relativeEntry = path.relative(resolvedDest, resolvedEntry);

  if (relativeEntry.startsWith("..") || path.isAbsolute(relativeEntry)) {
    throw new Error("Path traversal detected");
  }

  if (seenTargets.has(resolvedEntry)) {
    throw new Error("Duplicate archive target path");
  }
  seenTargets.add(resolvedEntry);

  return { normalizedName: parts.join("/"), resolvedEntry };
}

function assertSafeArchiveMode(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0o777777;
  const fileType = mode & UNIX_FILE_TYPE_MASK;
  const unsafeTypes = new Set([
    UNIX_SYMLINK,
    UNIX_CHARACTER_DEVICE,
    UNIX_BLOCK_DEVICE,
    UNIX_FIFO,
    UNIX_SOCKET,
  ]);

  if (unsafeTypes.has(fileType)) {
    throw new Error("Archive links and device entries are not allowed");
  }
}

function openReadStream(zip, entry) {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => (error ? reject(error) : resolve(stream)));
  });
}

async function inspectAndExtractEntry(zip, entry, resolvedEntry, maxEntrySize) {
  const tempPath = `${resolvedEntry}.tmp`;
  await fs.mkdir(path.dirname(tempPath), { recursive: true, mode: 0o700 });

  try {
    const readStream = await openReadStream(zip, entry);
    const chunks = [];
    let signatureBytes = 0;
    let bytesRead = 0;

    readStream.on("data", (chunk) => {
      bytesRead += chunk.length;
      if (bytesRead > maxEntrySize) {
        readStream.destroy(new Error("Archive entry exceeds per-file limit"));
        return;
      }
      if (signatureBytes < 4100) {
        const remainingBytes = 4100 - signatureBytes;
        const signatureChunk = chunk.subarray(0, remainingBytes);
        chunks.push(signatureChunk);
        signatureBytes += signatureChunk.length;
      }
    });

    await pipeline(readStream, createWriteStream(tempPath, { flags: "wx", mode: 0o600 }));

    const detected = await fileTypeFromBuffer(Buffer.concat(chunks));
    if (detected && ARCHIVE_MIME_TYPES.has(detected.mime)) {
      throw new Error("Nested archives are not allowed");
    }

    return tempPath;
  } catch (error) {
    await fs.rm(tempPath, { force: true });
    throw error;
  }
}

async function extractZipSafely(zipPath, destDir, options = {}) {
  const {
    maxTotalSize = 100 * 1024 * 1024,
    maxEntrySize = 10 * 1024 * 1024,
    maxEntries = 1000,
    maxDepth = 8,
    maxCompressionRatio = 100,
  } = options;

  const zip = await openZip(zipPath);

  let totalSize = 0;
  let entryCount = 0;
  const seenTargets = new Set();
  const extractedTempPaths = [];

  try {
    for await (const entry of readZipEntries(zip)) {
      entryCount += 1;
      if (entryCount > maxEntries) {
        throw new Error("Too many archive entries");
      }

      const isDirectory = entry.fileName.replace(/\\/g, "/").endsWith("/");
      const { normalizedName, resolvedEntry } = assertSafeArchiveName(
        entry.fileName,
        destDir,
        seenTargets,
        maxDepth,
      );

      assertSafeArchiveMode(entry);

      if (isDirectory) continue;

      if (entry.uncompressedSize > maxEntrySize) {
        throw new Error("Archive entry exceeds per-file limit");
      }

      totalSize += entry.uncompressedSize;
      if (totalSize > maxTotalSize) {
        throw new Error("Extracted size exceeds limit");
      }

      if (entry.compressedSize === 0) {
        if (entry.uncompressedSize > 0) {
          throw new Error("Suspicious zero-compressed entry");
        }
        continue;
      }

      const ratio = entry.uncompressedSize / entry.compressedSize;
      if (ratio > maxCompressionRatio) {
        throw new Error("Suspicious compression ratio");
      }

      const tempPath = await inspectAndExtractEntry(zip, entry, resolvedEntry, maxEntrySize);
      extractedTempPaths.push({ tempPath, finalPath: resolvedEntry });
    }

    for (const { tempPath, finalPath } of extractedTempPaths) {
      await fs
        .stat(finalPath)
        .then(() => {
          throw new Error("Archive target already exists");
        })
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      await fs.rename(tempPath, finalPath);
    }
  } catch (error) {
    for (const { tempPath } of extractedTempPaths) {
      await fs.rm(tempPath, { force: true });
    }
    throw error;
  } finally {
    zip.close();
  }
}
```

Some ZIP libraries expose directory entries without reliable Unix mode bits,
and other archive formats have different metadata fields. Treat this as a
pattern: choose a library that can stream entries, expose link/device metadata,
and validate declared sizes while still enforcing byte counts during extraction.

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
const QUARANTINE_DIR = "/var/app/quarantine";
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

      // Generate a safe quarantine filename. The final storage name is created
      // by the scanner/release worker after approval.
      const quarantinedName = `${crypto.randomUUID()}.upload`;
      const quarantinePath = path.join(QUARANTINE_DIR, quarantinedName);

      // Re-encode images before scanning and release.
      const output = await sharp(file.buffer).rotate().toFormat("jpeg", { quality: 90 }).toBuffer();
      await fs.writeFile(quarantinePath, output, { mode: 0o600 });

      let fileRecord;
      try {
        // Store quarantined metadata. A separate scanner/review worker flips
        // this to available and moves it into UPLOAD_DIR only after approval.
        fileRecord = await db.createFile({
          userId: req.user.id,
          storageName: quarantinedName,
          storageRoot: "quarantine",
          originalName: file.originalname,
          mimeType: "image/jpeg",
          size: output.length,
          status: "quarantined",
        });
        await scanQueue.enqueue({ fileId: fileRecord.id, path: quarantinePath });
      } catch (error) {
        await fs.rm(quarantinePath, { force: true });
        throw error;
      }

      res.json({ id: fileRecord.id });
    } catch (error) {
      console.error(error);
      res.status(500).json({ error: "Upload failed" });
    }
  },
);
```

OWASP Reference: https://cheatsheetseries.owasp.org/cheatsheets/File_Upload_Cheat_Sheet.html
